// Cross-tab ownership of live sessions via the Web Locks API. A tab holds a session's
// lock for as long as it's recording (or finalizing) it; the browser releases the lock
// the instant that tab dies, which is exactly the signal crash recovery needs. Without
// Web Locks we fall back to heartbeat staleness: a 'recording' session whose updatedAt
// hasn't moved in STALE_AFTER_MS is assumed abandoned.
import type { Session } from './db'

const LOCK_PREFIX = 'moboflow:session:'

/** Must comfortably exceed the recorder's autosave interval. */
export const HEARTBEAT_INTERVAL_MS = 5_000
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 4

export type ReleaseLock = () => void

function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && 'locks' in navigator
}

/**
 * Takes exclusive ownership of a session. Resolves to a release function, or null if
 * another tab already holds it. Without Web Locks support this always succeeds.
 */
export function acquireSessionLock(sessionId: string): Promise<ReleaseLock | null> {
  if (!hasWebLocks()) return Promise.resolve(() => {})
  return new Promise((resolve) => {
    void navigator.locks.request(`${LOCK_PREFIX}${sessionId}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null)
        return
      }
      // The lock is held until this promise settles, i.e. until release() is called.
      return new Promise<void>((release) => resolve(release))
    })
  })
}

/** Builds an `isLive` predicate for recoverInterruptedSessions(). */
export async function createLivenessCheck(): Promise<(session: Session) => boolean> {
  if (hasWebLocks()) {
    const { held = [] } = await navigator.locks.query()
    const heldIds = new Set(
      held
        .map((lock) => lock.name)
        .filter((name): name is string => !!name?.startsWith(LOCK_PREFIX))
        .map((name) => name.slice(LOCK_PREFIX.length)),
    )
    return (session) => heldIds.has(session.id)
  }
  const now = Date.now()
  return (session) => now - session.updatedAt < STALE_AFTER_MS
}
