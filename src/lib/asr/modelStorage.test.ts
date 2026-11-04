import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { MODELS, ORT_RUNTIME, type ModelSpec } from './models'
import {
  canLoadOffline,
  ensureRoomFor,
  evictLeastRecentlyUsed,
  isQuotaError,
  recordModelUse,
  removeCachedModel,
  removeStaleModelCaches,
  StorageFullError,
  wasEvicted,
  type StorageDeps,
} from './modelStorage'

// Two extra registry entries so eviction has something to choose between.
const spec = (id: string, mb: number): ModelSpec => ({
  id,
  version: '1',
  label: id,
  baseUrl: `/models/${id}/`,
  cacheName: `moboflow-${id}`,
  files: [{ name: 'weights.bin', approxBytes: mb * 1e6 }],
})
const big = spec('big', 500)
const small = spec('small', 100)
const fresh = spec('fresh', 300)
Object.assign(MODELS, { big, small, fresh })

/** In-memory CacheStorage + a quota where usage = sum of cached model sizes. */
function fakeStorage(quotaMb: number) {
  const buckets = new Map<string, Set<string>>()
  const sizeOf = (name: string) => Object.values(MODELS).find((m) => m.cacheName === name)
  const caches = {
    has: async (name: string) => buckets.has(name),
    keys: async () => [...buckets.keys()],
    delete: async (name: string) => buckets.delete(name),
    open: async (name: string) => {
      if (!buckets.has(name)) buckets.set(name, new Set())
      const urls = buckets.get(name)!
      return { match: async (url: string) => (urls.has(url) ? new Response('x') : undefined) }
    },
  } as unknown as CacheStorage
  let clock = 0
  const deps: StorageDeps = {
    caches,
    now: () => ++clock,
    estimate: async () => ({
      quota: quotaMb * 1e6,
      usage: [...buckets.keys()].reduce((sum, name) => {
        const m = sizeOf(name)
        return sum + (m ? m.files.reduce((s, f) => s + f.approxBytes, 0) : 50e6)
      }, 0),
    }),
  }
  const cacheModel = async (m: ModelSpec) => {
    buckets.set(m.cacheName, new Set(m.files.map((f) => m.baseUrl + f.name)))
    await recordModelUse(m, true, deps)
  }
  return { deps, buckets, cacheModel }
}

beforeEach(async () => {
  await db.modelAssets.clear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('model storage budget', () => {
  it('is a no-op when the model is already cached', async () => {
    const { deps, cacheModel } = fakeStorage(100) // over quota, but nothing to download
    await cacheModel(big)
    await expect(ensureRoomFor(big, deps)).resolves.toBeUndefined()
  })

  it('downloads without evicting anything when there is room', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(1000)
    await cacheModel(big)
    await cacheModel(small) // 600MB used, 400 free; fresh needs ~330 incl. headroom
    await ensureRoomFor(fresh, deps)
    expect([...buckets.keys()].sort()).toEqual(['moboflow-big', 'moboflow-small'])
  })

  it('evicts the least-recently-used model — only as many as needed', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(900)
    await cacheModel(big)
    await cacheModel(small)
    await recordModelUse(big, true, deps) // big used again → small is now LRU
    // 600MB used, 300 free < ~330 needed → evict small (LRU) → 400 free → fits; big survives
    await ensureRoomFor(fresh, deps)
    expect([...buckets.keys()]).toEqual(['moboflow-big'])
    expect(await db.modelAssets.get(small.id)).toBeUndefined()
    expect(await db.modelAssets.get(big.id)).toBeDefined()
  })

  it('throws StorageFullError when evicting everything else still would not fit', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(400)
    await cacheModel(small)
    await expect(ensureRoomFor(big, deps)).rejects.toBeInstanceOf(StorageFullError)
    expect(buckets.has(small.cacheName)).toBe(false) // it did try
  })

  it('reclaims buckets for models no longer in the registry (old versions)', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(10_000)
    await cacheModel(small)
    buckets.set('moboflow-parakeet-old-version', new Set())
    buckets.set('workbox-precache-v2', new Set()) // not ours — must survive
    expect(await removeStaleModelCaches(deps)).toEqual(['moboflow-parakeet-old-version'])
    expect([...buckets.keys()].sort()).toEqual(['moboflow-small', 'workbox-precache-v2'])
  })

  it('evictLeastRecentlyUsed returns null when nothing else is cached', async () => {
    const { deps, cacheModel } = fakeStorage(10_000)
    await cacheModel(small)
    expect(await evictLeastRecentlyUsed(small, deps)).toBeNull()
  })

  it('records use: keeps cachedAt, bumps lastUsedAt, forgets uncached models', async () => {
    const { deps } = fakeStorage(10_000)
    await recordModelUse(small, true, deps)
    const first = (await db.modelAssets.get(small.id))!
    await recordModelUse(small, true, deps)
    const second = (await db.modelAssets.get(small.id))!
    expect(second.cachedAt).toBe(first.cachedAt)
    expect(second.lastUsedAt).toBeGreaterThan(first.lastUsedAt!)
    await recordModelUse(small, false, deps)
    expect(await db.modelAssets.get(small.id)).toBeUndefined()
  })

  it('reports offline readiness only when the model and the ORT runtime are both cached', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(10_000)
    expect(await canLoadOffline(small, deps)).toBe(false)
    await cacheModel(small)
    expect(await canLoadOffline(small, deps)).toBe(false) // runtime still missing
    buckets.set(ORT_RUNTIME.cacheName, new Set(ORT_RUNTIME.files.map((f) => ORT_RUNTIME.baseUrl + f)))
    expect(await canLoadOffline(small, deps)).toBe(true)
  })

  it('never treats the ORT runtime bucket as a stale model cache', async () => {
    const { deps, buckets } = fakeStorage(10_000)
    buckets.set(ORT_RUNTIME.cacheName, new Set())
    expect(await removeStaleModelCaches(deps)).toEqual([])
  })

  it('detects a model the browser evicted (recorded as cached, files gone)', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(10_000)
    expect(await wasEvicted(small, deps)).toBe(false) // never downloaded
    await cacheModel(small)
    expect(await wasEvicted(small, deps)).toBe(false)
    buckets.delete(small.cacheName)
    expect(await wasEvicted(small, deps)).toBe(true)
  })

  it('removes a downloaded model and forgets it (so it is not reported as evicted)', async () => {
    const { deps, buckets, cacheModel } = fakeStorage(10_000)
    await cacheModel(small)
    await removeCachedModel(small, deps)
    expect(buckets.has(small.cacheName)).toBe(false)
    expect(await wasEvicted(small, deps)).toBe(false)
  })
})

describe('isQuotaError', () => {
  it('recognizes Cache API and Dexie-wrapped IndexedDB quota errors', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaError({ name: 'AbortError', inner: { name: 'QuotaExceededError' } })).toBe(true)
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true)
    expect(isQuotaError(new Error('nope'))).toBe(false)
    expect(isQuotaError(null)).toBe(false)
  })
})
