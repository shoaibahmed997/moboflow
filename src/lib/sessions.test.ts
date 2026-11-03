import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  appendSegment,
  completeSession,
  createSession,
  deleteSession,
  editedSegment,
  formatDuration,
  getSessionSegments,
  recoverInterruptedSessions,
  renameSession,
  revertedSegment,
  saveSessionProgress,
  writeSegmentState,
} from './sessions'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

const segment = (sessionId: string, startMs: number, endMs: number, text = 'hello') => ({
  id: crypto.randomUUID(),
  sessionId,
  startMs,
  endMs,
  text,
})

describe('session persistence', () => {
  it('creates a recording session and appends segments in timeline order', async () => {
    const session = await createSession()
    expect(session.status).toBe('recording')

    await appendSegment(segment(session.id, 4000, 5000, 'second'))
    await appendSegment(segment(session.id, 1000, 2000, 'first'))

    const segments = await getSessionSegments(session.id)
    expect(segments.map((s) => s.text)).toEqual(['first', 'second'])
    expect(segments.every((s) => !s.isEdited)).toBe(true)
    expect((await db.sessions.get(session.id))?.durationMs).toBe(5000)
  })

  it('drops segments for a session deleted while they were being transcribed', async () => {
    const session = await createSession()
    await deleteSession(session.id)
    expect(await appendSegment(segment(session.id, 0, 1000))).toBe(false)
    expect(await db.segments.count()).toBe(0)
  })

  it('never lets an autosave shrink the recorded duration', async () => {
    const session = await createSession()
    await saveSessionProgress(session.id, 9000)
    await saveSessionProgress(session.id, 3000)
    expect((await db.sessions.get(session.id))?.durationMs).toBe(9000)
  })

  it('completes sessions with content and deletes empty ones', async () => {
    const kept = await createSession()
    await appendSegment(segment(kept.id, 0, 1000))
    const empty = await createSession()

    expect(await completeSession(kept.id)).toBe(true)
    expect(await completeSession(empty.id)).toBe(false)
    expect((await db.sessions.get(kept.id))?.status).toBe('complete')
    expect(await db.sessions.get(empty.id)).toBeUndefined()
  })

  it('recovers only orphaned recording sessions as drafts', async () => {
    const orphan = await createSession()
    await appendSegment(segment(orphan.id, 0, 1000))
    const live = await createSession()
    const done = await createSession()
    await appendSegment(segment(done.id, 0, 1000))
    await completeSession(done.id)

    const recovered = await recoverInterruptedSessions((s) => s.id === live.id)

    expect(recovered).toEqual([orphan.id])
    expect((await db.sessions.get(orphan.id))?.status).toBe('draft')
    expect((await db.sessions.get(live.id))?.status).toBe('recording')
    expect((await db.sessions.get(done.id))?.status).toBe('complete')
    expect(await getSessionSegments(orphan.id)).toHaveLength(1)
  })

  it('renames, rejecting blank titles', async () => {
    const session = await createSession()
    expect(await renameSession(session.id, '  Standup notes ')).toBe(true)
    expect(await renameSession(session.id, '   ')).toBe(false)
    expect((await db.sessions.get(session.id))?.title).toBe('Standup notes')
  })

  it('deletes a session together with its segments', async () => {
    const a = await createSession()
    const b = await createSession()
    await appendSegment(segment(a.id, 0, 1000))
    await appendSegment(segment(b.id, 0, 1000))

    await deleteSession(a.id)

    expect(await db.sessions.get(a.id)).toBeUndefined()
    expect(await getSessionSegments(a.id)).toHaveLength(0)
    expect(await getSessionSegments(b.id)).toHaveLength(1)
  })
})

describe('segment edits', () => {
  it('keeps the original text across repeated edits and clears the flag on revert', () => {
    const raw = { ...segment('s', 0, 1000, 'raw output'), isEdited: false }
    const once = editedSegment(raw, 'First edit')
    const twice = editedSegment(once, 'Second edit')
    expect(twice).toMatchObject({ text: 'Second edit', isEdited: true, originalText: 'raw output' })

    const reverted = revertedSegment(twice)
    expect(reverted).toMatchObject({ text: 'raw output', isEdited: false })
    expect(reverted).not.toHaveProperty('originalText')
    expect(editedSegment(once, 'raw output')).toEqual(reverted)
  })

  it('writes, deletes and restores exact segment states', async () => {
    const session = await createSession()
    const original = { ...segment(session.id, 0, 1000, 'hello'), isEdited: false }
    await appendSegment(original)

    const edited = editedSegment(original, 'Hello there.')
    await writeSegmentState(session.id, original.id, edited)
    expect(await db.segments.get(original.id)).toEqual(edited)

    await writeSegmentState(session.id, original.id, null)
    expect(await db.segments.get(original.id)).toBeUndefined()

    await writeSegmentState(session.id, original.id, original) // undo of the delete
    expect(await db.segments.get(original.id)).toEqual(original)
  })

  it('ignores writes for a deleted session', async () => {
    const session = await createSession()
    await deleteSession(session.id)
    await writeSegmentState(session.id, 'x', { ...segment(session.id, 0, 1), id: 'x', isEdited: false })
    expect(await db.segments.count()).toBe(0)
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [59_999, '0:59'],
    [61_000, '1:01'],
    [3_723_000, '1:02:03'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})
