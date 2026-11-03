import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { createFolder, deleteFolder, moveSessionToFolder, normalizeTags, renameFolder, setSessionTags } from './library'
import { createSession } from './sessions'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('library', () => {
  it('normalizes tags: case, leading #, whitespace, duplicates, empties', () => {
    expect(normalizeTags(['#Work', 'work', '  big   ideas ', '', '##']).sort()).toEqual(['big ideas', 'work'])
  })

  it('creates and renames folders, rejecting blank names', async () => {
    expect(await createFolder('   ')).toBeNull()
    const folder = (await createFolder('  Work  stuff '))!
    expect(folder.name).toBe('Work stuff')
    expect(await renameFolder(folder.id, '')).toBe(false)
    await renameFolder(folder.id, 'Work')
    expect((await db.folders.get(folder.id))?.name).toBe('Work')
  })

  it('moves sessions in and out of folders, queryable by folderId', async () => {
    const folder = (await createFolder('Work'))!
    const session = await createSession()
    await moveSessionToFolder(session.id, folder.id)
    expect(await db.sessions.where('folderId').equals(folder.id).count()).toBe(1)
    await moveSessionToFolder(session.id, undefined)
    expect((await db.sessions.get(session.id))?.folderId).toBeUndefined()
  })

  it('deleting a folder keeps its sessions, moving them to Unfiled', async () => {
    const folder = (await createFolder('Work'))!
    const session = await createSession()
    await moveSessionToFolder(session.id, folder.id)
    await deleteFolder(folder.id)
    expect(await db.folders.count()).toBe(0)
    const kept = await db.sessions.get(session.id)
    expect(kept).toBeDefined()
    expect(kept?.folderId).toBeUndefined()
  })

  it('stores normalized tags queryable through the multi-entry index', async () => {
    const session = await createSession()
    await setSessionTags(session.id, ['#Ideas', 'ideas', 'Q3'])
    expect((await db.sessions.get(session.id))?.tags).toEqual(['ideas', 'q3'])
    expect(await db.sessions.where('tags').equals('q3').count()).toBe(1)
  })
})
