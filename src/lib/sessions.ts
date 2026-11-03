// Session persistence (SPEC.md §6 Phase 4). All writes to `sessions`/`segments` go
// through here so lifecycle invariants live in one place:
//   - 'recording' — owned by a live recorder in some tab (active or paused)
//   - 'draft'     — interrupted (tab killed/crashed mid-recording); resumable
//   - 'complete'  — the user stopped it and every queued utterance was transcribed
import { db, type Segment, type Session } from './db'

const DEFAULT_LANGUAGE = 'en-US'

export function defaultSessionTitle(createdAt: number): string {
  const formatted = new Date(createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `Recording · ${formatted}`
}

export async function createSession(id: string = crypto.randomUUID()): Promise<Session> {
  const now = Date.now()
  const session: Session = {
    id,
    title: defaultSessionTitle(now),
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    language: DEFAULT_LANGUAGE,
    tags: [],
    status: 'recording',
  }
  await db.sessions.add(session)
  return session
}

/**
 * Persists a finalized utterance. Returns false (and writes nothing) if the session
 * was deleted while its audio was still being transcribed, so no orphaned segments
 * are left behind.
 */
export async function appendSegment(segment: Omit<Segment, 'isEdited'>): Promise<boolean> {
  return db.transaction('rw', db.sessions, db.segments, async () => {
    const session = await db.sessions.get(segment.sessionId)
    if (!session) return false
    await db.segments.add({ ...segment, isEdited: false })
    await db.sessions.update(segment.sessionId, {
      updatedAt: Date.now(),
      durationMs: Math.max(session.durationMs, segment.endMs),
    })
    return true
  })
}

/** Autosave heartbeat for a live session — also what staleness detection keys off. */
export async function saveSessionProgress(id: string, durationMs: number): Promise<void> {
  await db.transaction('rw', db.sessions, async () => {
    const session = await db.sessions.get(id)
    if (!session) return
    await db.sessions.update(id, {
      updatedAt: Date.now(),
      durationMs: Math.max(session.durationMs, durationMs),
    })
  })
}

export async function setSessionStatus(id: string, status: Session['status']): Promise<void> {
  await db.sessions.update(id, { status, updatedAt: Date.now() })
}

/**
 * Marks a stopped session complete — or deletes it if nothing was ever transcribed,
 * so tapping record then stop without speaking doesn't leave an empty entry behind.
 * Returns whether the session still exists afterward.
 */
export async function completeSession(id: string): Promise<boolean> {
  return db.transaction('rw', db.sessions, db.segments, async () => {
    const segmentCount = await db.segments.where('sessionId').equals(id).count()
    if (segmentCount === 0) {
      await db.sessions.delete(id)
      return false
    }
    await db.sessions.update(id, { status: 'complete', updatedAt: Date.now() })
    return true
  })
}

/** Returns false for blank titles (left unchanged). */
export async function renameSession(id: string, title: string): Promise<boolean> {
  const trimmed = title.trim()
  if (!trimmed) return false
  await db.sessions.update(id, { title: trimmed, updatedAt: Date.now() })
  return true
}

export async function deleteSession(id: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.segments, async () => {
    await db.segments.where('sessionId').equals(id).delete()
    await db.sessions.delete(id)
  })
}

export function getSessionSegments(sessionId: string): Promise<Segment[]> {
  return db.segments.where('sessionId').equals(sessionId).sortBy('startMs')
}

/**
 * Finds sessions left in 'recording' by a tab that's no longer running and demotes
 * them to 'draft' so the user can resume or finish them. `isLive` says whether some
 * tab still owns a given session (see sessionLock.ts). Returns the recovered ids.
 */
export async function recoverInterruptedSessions(
  isLive: (session: Session) => boolean,
): Promise<string[]> {
  return db.transaction('rw', db.sessions, async () => {
    const orphaned = (await db.sessions.where('status').equals('recording').toArray()).filter(
      (session) => !isLive(session),
    )
    // updatedAt is deliberately left alone: it records when the session last made progress.
    await Promise.all(orphaned.map((session) => db.sessions.update(session.id, { status: 'draft' })))
    return orphaned.map((session) => session.id)
  })
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
