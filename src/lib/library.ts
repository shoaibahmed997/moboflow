// Folders and tags (SPEC.md §6 Phase 6). Folders are flat in v1 — `Folder.parentId`
// stays in the schema for a later one-level nesting pass, but nothing sets it yet.
import { db, type Folder } from './db'

export const MAX_FOLDER_NAME_LENGTH = 60
export const MAX_TAG_LENGTH = 32

function normalizeFolderName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME_LENGTH)
}

/** Tags are case-insensitive: lowercased, leading '#' dropped, whitespace collapsed. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
}

/** Normalizes, drops empties and de-duplicates, preserving first-seen order. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))]
}

/** Returns the new folder, or null for a blank name. Names needn't be unique. */
export async function createFolder(name: string): Promise<Folder | null> {
  const normalized = normalizeFolderName(name)
  if (!normalized) return null
  const folder: Folder = { id: crypto.randomUUID(), name: normalized, createdAt: Date.now() }
  await db.folders.add(folder)
  return folder
}

export async function renameFolder(id: string, name: string): Promise<boolean> {
  const normalized = normalizeFolderName(name)
  if (!normalized) return false
  await db.folders.update(id, { name: normalized })
  return true
}

/** Deletes the folder only — its sessions move to Unfiled, they're never deleted with it. */
export async function deleteFolder(id: string): Promise<void> {
  await db.transaction('rw', db.folders, db.sessions, async () => {
    await db.sessions
      .where('folderId')
      .equals(id)
      .modify((session) => {
        delete session.folderId
        session.updatedAt = Date.now()
      })
    await db.folders.delete(id)
  })
}

/** `folderId` undefined = Unfiled. */
export async function moveSessionToFolder(sessionId: string, folderId: string | undefined): Promise<void> {
  await db.sessions
    .where('id')
    .equals(sessionId)
    .modify((session) => {
      if (folderId) session.folderId = folderId
      else delete session.folderId
      session.updatedAt = Date.now()
    })
}

export async function setSessionTags(sessionId: string, tags: string[]): Promise<void> {
  await db.sessions.update(sessionId, { tags: normalizeTags(tags), updatedAt: Date.now() })
}
