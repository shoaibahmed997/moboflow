// Fetches a model's ONNX assets with Cache API persistence, so each model downloads once
// per browser. Deliberately NOT part of the Workbox app-shell precache (see
// vite.config.ts) — this is a separate, on-demand strategy with its own progress
// reporting, matching SPEC.md §5.2's requirement that the first-run download experience
// be a first-class concern. Storage budgeting/eviction lives in modelStorage.ts.
import { modelSize, type ModelSpec } from './models'
import { evictLeastRecentlyUsed, isQuotaError } from './modelStorage'

export interface LoadProgress {
  file: string
  loadedBytes: number
  totalBytesKnown: number
  /** Combined progress across all files in this load call, 0..1 (best-effort if sizes are unknown up front). */
  overall: number
}

export interface LoadedModel {
  assets: Record<string, ArrayBuffer>
  /** False if any file couldn't be stored (quota) — it works now but re-downloads next time. */
  cached: boolean
}

async function download(url: string, onChunk: (loadedDelta: number, totalBytes: number) => void): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch model asset ${url}: ${response.status}`)
  }
  const totalBytes = Number(response.headers.get('content-length') ?? 0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  let unreported = 0
  let lastReportAt = performance.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    unreported += value.byteLength

    // Network chunks can be tens of thousands for an ~890MB download — throttle how
    // often we cross the worker/main-thread boundary and trigger a React re-render.
    const now = performance.now()
    if (now - lastReportAt >= 150) {
      onChunk(unreported, totalBytes)
      unreported = 0
      lastReportAt = now
    }
  }
  if (unreported > 0) onChunk(unreported, totalBytes)

  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}

/** Stores a downloaded file; on quota errors evicts the LRU other model and retries once. */
async function store(spec: ModelSpec, cache: Cache, url: string, buf: ArrayBuffer): Promise<boolean> {
  const put = () =>
    cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) } }))
  try {
    await put()
    return true
  } catch (err) {
    if (!isQuotaError(err)) throw err
    if (await evictLeastRecentlyUsed(spec)) {
      try {
        await put()
        return true
      } catch (retryErr) {
        if (!isQuotaError(retryErr)) throw retryErr
      }
    }
    // Storage is genuinely full (Safari evicts aggressively, see SPEC.md §5.5): carry on
    // uncached — transcription still works this session, it just re-downloads next time.
    console.warn(`[model cache] couldn't store ${url}: storage quota exceeded`)
    return false
  }
}

export async function loadModelAssets(spec: ModelSpec, onProgress?: (progress: LoadProgress) => void): Promise<LoadedModel> {
  const approxTotal = modelSize(spec)
  const loadedByFile: Record<string, number> = {}
  const cache = await caches.open(spec.cacheName)
  let cached = true

  // Sequential, not parallel: these total ~890MB, and downloading them concurrently
  // would be unfriendly to mobile connections and double-peak memory (each file is
  // buffered fully in memory until handed to onnxruntime). One at a time is gentler
  // and gives a more predictable progress readout.
  const assets: Record<string, ArrayBuffer> = {}
  for (const file of spec.files) {
    const url = spec.baseUrl + file.name
    const report = (loadedDelta: number, totalBytes: number) => {
      loadedByFile[file.name] = (loadedByFile[file.name] ?? 0) + loadedDelta
      const overallLoaded = Object.values(loadedByFile).reduce((sum, n) => sum + n, 0)
      onProgress?.({
        file: file.name,
        loadedBytes: loadedByFile[file.name],
        totalBytesKnown: totalBytes || file.approxBytes,
        overall: Math.min(1, overallLoaded / approxTotal),
      })
    }

    const hit = await cache.match(url)
    if (hit) {
      assets[file.name] = await hit.arrayBuffer()
      report(assets[file.name].byteLength, assets[file.name].byteLength)
      continue
    }
    assets[file.name] = await download(url, report)
    cached = (await store(spec, cache, url, assets[file.name])) && cached
  }
  return { assets, cached }
}
