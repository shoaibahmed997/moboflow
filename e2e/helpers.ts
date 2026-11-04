import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

/** The ~890MB model is git-ignored; specs that need real transcription skip without it. */
export const HAS_MODEL = existsSync(fileURLToPath(new URL('../parakeet/encoder-int8.onnx.data', import.meta.url)))

export interface SeedSession {
  id: string
  title: string
  createdAt?: number
  language?: string
  tags?: string[]
  folderId?: string
  segments: [startMs: number, endMs: number, text: string][]
}

/**
 * Writes sessions straight into IndexedDB (the app must have opened the DB once so the
 * schema exists), then reloads so live queries pick them up.
 */
export async function seed(page: Page, sessions: SeedSession[]) {
  await page.evaluate(async (sessions) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('moboflow')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const tx = db.transaction(['sessions', 'segments'], 'readwrite')
    for (const s of sessions) {
      const createdAt = s.createdAt ?? Date.now()
      const durationMs = Math.max(0, ...s.segments.map(([, end]) => end))
      tx.objectStore('sessions').put({
        id: s.id,
        title: s.title,
        createdAt,
        updatedAt: createdAt,
        durationMs,
        language: s.language ?? 'en',
        tags: s.tags ?? [],
        ...(s.folderId ? { folderId: s.folderId } : {}),
        status: 'complete',
      })
      s.segments.forEach(([startMs, endMs, text], i) =>
        tx.objectStore('segments').put({ id: `${s.id}-${i}`, sessionId: s.id, startMs, endMs, text, isEdited: false }),
      )
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, sessions)
  await page.reload()
}

export interface DbSnapshot {
  sessions: { id: string; status: string; language: string; title: string }[]
  segments: { id: string; sessionId: string; startMs: number; text: string; isEdited: boolean }[]
}

export function readDb(page: Page): Promise<DbSnapshot> {
  return page.evaluate(
    () =>
      new Promise<DbSnapshot>((resolve, reject) => {
        const req = indexedDB.open('moboflow')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction(['sessions', 'segments'])
          const out: Record<string, unknown[]> = {}
          for (const name of ['sessions', 'segments']) {
            const all = tx.objectStore(name).getAll()
            all.onsuccess = () => (out[name] = all.result)
          }
          tx.oncomplete = () => {
            req.result.close()
            resolve(out as unknown as DbSnapshot)
          }
        }
      }),
  )
}

/** Loads the app and waits until the service worker controls the page (needed for offline). */
export async function openControlled(page: Page, path = '/') {
  await page.goto(path)
  await page.evaluate(() => navigator.serviceWorker.ready)
  // clientsClaim() normally takes control without a reload; reload once if it hasn't yet.
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload()
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
}

/** Polls IndexedDB until `predicate` holds; returns the snapshot that satisfied it. */
export async function waitForDb(page: Page, predicate: (db: DbSnapshot) => boolean, timeout = 120_000): Promise<DbSnapshot> {
  let last: DbSnapshot | undefined
  await expect
    .poll(
      async () => {
        last = await readDb(page)
        return predicate(last)
      },
      { timeout, intervals: [500] },
    )
    .toBe(true)
  return last!
}
