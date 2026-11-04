// Storage budget for model weights (SPEC.md §6 Phase 8). Models are only downloaded when
// a language that needs them is actually used; each lives in its own Cache API bucket,
// with a `modelAssets` row recording size and last use. Under quota pressure, least-
// recently-used models are evicted (never the one being loaded), and buckets from
// models/versions no longer in the registry are always reclaimed first.
//
// Runs in the ASR worker (Cache API + IndexedDB are both available there).
import { db } from '../db'
import { MODEL_CACHE_PREFIX, MODELS, modelSize, ORT_RUNTIME, type ModelSpec } from './models'

/** Safety margin over the raw model size — Cache API/IndexedDB have per-entry overhead. */
const HEADROOM = 1.1

export class StorageFullError extends Error {
  constructor(spec: ModelSpec, freeBytes: number) {
    const mb = (bytes: number) => `${Math.round(bytes / 1e6)}MB`
    super(
      `Not enough storage for the ${spec.label} model: needs ~${mb(modelSize(spec))}, ` +
        `about ${mb(Math.max(0, freeBytes))} available. Free up space on this device and try again.`,
    )
    this.name = 'StorageFullError'
  }
}

export interface StorageDeps {
  caches: CacheStorage
  estimate: () => Promise<StorageEstimate>
  now: () => number
}

const browserDeps = (): StorageDeps => ({
  caches: self.caches,
  estimate: () => navigator.storage.estimate(),
  now: () => Date.now(),
})

const knownCacheNames = () => new Set(Object.values(MODELS).map((m) => m.cacheName))

async function isFullyCached(spec: ModelSpec, deps: StorageDeps): Promise<boolean> {
  if (!(await deps.caches.has(spec.cacheName))) return false
  const cache = await deps.caches.open(spec.cacheName)
  const hits = await Promise.all(spec.files.map((f) => cache.match(spec.baseUrl + f.name)))
  return hits.every(Boolean)
}

async function isRuntimeCached(deps: StorageDeps): Promise<boolean> {
  if (!(await deps.caches.has(ORT_RUNTIME.cacheName))) return false
  const cache = await deps.caches.open(ORT_RUNTIME.cacheName)
  const hits = await Promise.all(ORT_RUNTIME.files.map((f) => cache.match(ORT_RUNTIME.baseUrl + f)))
  return hits.every(Boolean)
}

/** Whether `spec` could start with no network: its weights and the ORT runtime are all cached. */
export async function canLoadOffline(spec: ModelSpec, deps: StorageDeps = browserDeps()): Promise<boolean> {
  return (await isFullyCached(spec, deps)) && (await isRuntimeCached(deps))
}

/**
 * True when we recorded `spec` as cached but its files are gone — i.e. the browser
 * evicted it under storage pressure (Safari does this readily), so it must re-download.
 */
export async function wasEvicted(spec: ModelSpec, deps: StorageDeps = browserDeps()): Promise<boolean> {
  return !!(await db.modelAssets.get(spec.id)) && !(await isFullyCached(spec, deps))
}

/** User-initiated removal of a downloaded model (frees its storage; it re-downloads on next use). */
export async function removeCachedModel(spec: ModelSpec, deps: StorageDeps = browserDeps()): Promise<void> {
  await deps.caches.delete(spec.cacheName)
  await db.modelAssets.delete(spec.id)
}

/** Deletes model buckets that no registry entry points at (old versions, removed models). */
export async function removeStaleModelCaches(deps: StorageDeps = browserDeps()): Promise<string[]> {
  const known = knownCacheNames()
  const stale = (await deps.caches.keys()).filter((name) => name.startsWith(MODEL_CACHE_PREFIX) && !known.has(name))
  await Promise.all(stale.map((name) => deps.caches.delete(name)))
  return stale
}

/**
 * Evicts the least-recently-used cached model other than `keep`. Returns the evicted
 * model id, or null if there was nothing else to evict.
 */
export async function evictLeastRecentlyUsed(keep: ModelSpec, deps: StorageDeps = browserDeps()): Promise<string | null> {
  const candidates = (await db.modelAssets.toArray())
    .filter((asset) => asset.id !== keep.id && MODELS[asset.id])
    .sort((a, b) => (a.lastUsedAt ?? a.cachedAt) - (b.lastUsedAt ?? b.cachedAt))
  const victim = candidates[0]
  if (!victim) return null
  await deps.caches.delete(MODELS[victim.id].cacheName)
  await db.modelAssets.delete(victim.id)
  console.info(`[model storage] evicted ${victim.id} (last used ${new Date(victim.lastUsedAt ?? victim.cachedAt).toISOString()})`)
  return victim.id
}

/**
 * Makes room for `spec` before it's downloaded. No-op when it's already cached. Throws
 * StorageFullError if evicting every other model still wouldn't fit it.
 */
export async function ensureRoomFor(spec: ModelSpec, deps: StorageDeps = browserDeps()): Promise<void> {
  await removeStaleModelCaches(deps)
  if (await isFullyCached(spec, deps)) return

  const needed = modelSize(spec) * HEADROOM
  for (;;) {
    const { quota, usage } = await deps.estimate()
    if (quota === undefined || usage === undefined) return // unknown budget: try, and handle failures at put()
    const free = quota - usage
    if (free >= needed) return
    if (!(await evictLeastRecentlyUsed(spec, deps))) throw new StorageFullError(spec, free)
  }
}

/** Records that `spec` was used just now (and is cached, if `cached`). */
export async function recordModelUse(spec: ModelSpec, cached: boolean, deps: Pick<StorageDeps, 'now'> = browserDeps()) {
  const now = deps.now()
  if (!cached) {
    await db.modelAssets.delete(spec.id)
    return
  }
  const existing = await db.modelAssets.get(spec.id)
  await db.modelAssets.put({
    id: spec.id,
    version: spec.version,
    sizeBytes: modelSize(spec),
    cachedAt: existing?.version === spec.version ? existing.cachedAt : now,
    lastUsedAt: now,
  })
}

/** Quota errors from the Cache API (DOMException) or IndexedDB via Dexie (which wraps them). */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22)) return true
  const named = err as { name?: string; inner?: { name?: string } } | null
  return named?.name === 'QuotaExceededError' || named?.inner?.name === 'QuotaExceededError'
}
