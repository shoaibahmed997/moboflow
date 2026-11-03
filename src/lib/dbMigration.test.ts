import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'

// Runs in its own file (= fresh IndexedDB + module registry) so the v2 database can be
// created *before* the app's db module is imported and upgrades it.
it('v3 upgrade normalizes session languages and keeps everything else', async () => {
  const legacy = new Dexie('moboflow')
  legacy.version(2).stores({
    sessions: 'id, createdAt, updatedAt, folderId, status, *tags, language',
    segments: 'id, sessionId, startMs',
    folders: 'id, parentId',
    modelAssets: 'id',
  })
  await legacy.table('sessions').bulkAdd([
    { id: 'a', title: 'Old', createdAt: 1, updatedAt: 1, durationMs: 0, language: 'en-US', tags: ['x'], status: 'complete' },
    { id: 'b', title: 'German', createdAt: 2, updatedAt: 2, durationMs: 0, language: 'de-DE', tags: [], status: 'draft' },
  ])
  await legacy.table('segments').add({ id: 's', sessionId: 'a', startMs: 0, endMs: 1, text: 'hi', isEdited: false })
  legacy.close()

  const { db } = await import('./db')
  const sessions = await db.sessions.orderBy('createdAt').toArray()
  expect(sessions.map((s) => [s.id, s.language, s.title, s.tags, s.status])).toEqual([
    ['a', 'en', 'Old', ['x'], 'complete'],
    ['b', 'de', 'German', [], 'draft'],
  ])
  expect(await db.sessions.where('language').equals('de').count()).toBe(1)
  expect(await db.segments.count()).toBe(1)
  await db.settings.put({ key: 'language', value: 'fr' })
  expect((await db.settings.get('language'))?.value).toBe('fr')
})
