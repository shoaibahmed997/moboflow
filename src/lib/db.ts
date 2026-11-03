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
  id: string // ModelSpec.id, e.g. "parakeet-tdt-0.6b-v3-int8"
  version: string
  sizeBytes: number
  cachedAt: number
  /** Drives LRU eviction under storage pressure (asr/modelStorage.ts). Not indexed — tiny table. */
  lastUsedAt?: number
}

/** Key-value user preferences (settings.ts). */
export interface Setting {
  key: string
  value: unknown
}

export const db = new Dexie('moboflow') as Dexie & {
  sessions: EntityTable<Session, 'id'>
  segments: EntityTable<Segment, 'id'>
  folders: EntityTable<Folder, 'id'>
  modelAssets: EntityTable<ModelAsset, 'id'>
  settings: EntityTable<Setting, 'key'>
}

db.version(1).stores({
  sessions: 'id, createdAt, updatedAt, folderId, status',
  segments: 'id, sessionId, startMs',
  folders: 'id, parentId',
  modelAssets: 'id',
})

// v2 (Phase 6): multi-entry tag index and language index for filtering. Index-only
// change — existing rows already carry `tags`/`language`, so no upgrade() is needed.
db.version(2).stores({
  sessions: 'id, createdAt, updatedAt, folderId, status, *tags, language',
})

// v3 (Phase 8): settings table; session languages normalized to the registry's primary
// subtags ("en-US" → "en") so filters don't split one language into variants.
db.version(3)
  .stores({ settings: 'key' })
  .upgrade((tx) =>
    tx
      .table('sessions')
      .toCollection()
      .modify((session: Session) => {
        session.language = session.language.trim().toLowerCase().split(/[-_]/)[0] || 'en'
      }),
  )
