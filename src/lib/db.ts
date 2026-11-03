import Dexie, { type EntityTable } from 'dexie'

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  durationMs: number
  language: string // BCP-47 tag, e.g. "en-US"
  folderId?: string
  tags: string[]
  status: 'recording' | 'complete' | 'draft'
}

export interface Segment {
  id: string
  sessionId: string
  startMs: number
  endMs: number
  text: string
  isEdited: boolean
  /** The model's raw output, kept from the first manual edit on so it can be restored. Not indexed. */
  originalText?: string
  confidence?: number
}

export interface Folder {
  id: string
  name: string
  parentId?: string
  createdAt: number
}

export interface ModelAsset {
  id: string // e.g. "parakeet-tdt-0.6b-en-int8"
  version: string
  sizeBytes: number
  cachedAt: number
}

export const db = new Dexie('moboflow') as Dexie & {
  sessions: EntityTable<Session, 'id'>
  segments: EntityTable<Segment, 'id'>
  folders: EntityTable<Folder, 'id'>
  modelAssets: EntityTable<ModelAsset, 'id'>
}

db.version(1).stores({
  sessions: 'id, createdAt, updatedAt, folderId, status',
  segments: 'id, sessionId, startMs',
  folders: 'id, parentId',
  modelAssets: 'id',
})
