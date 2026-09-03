// Fetches the Parakeet ONNX model assets with Cache API persistence, so the ~890MB
// download only happens once per browser. Deliberately NOT part of the Workbox
// app-shell precache (see vite.config.ts) — this is a separate, on-demand strategy
// with its own progress reporting, matching SPEC.md §5.2's requirement that the
// first-run download experience be a first-class concern, not bolted on.
//
// MODEL_BASE_URL points at the dev-only static server (vite.config.ts's
// serveParakeetModels plugin) for local development. Shipping this app means hosting
// parakeet/'s contents on real static storage/a CDN and changing this constant —
// see SPEC.md §6 Phase 3 and §7.

export const MODEL_BASE_URL = '/models/parakeet/'
export const CACHE_NAME = 'moboflow-parakeet-tdt-0.6b-v3-int8'

export const MODEL_FILES = ['encoder-int8.onnx', 'encoder-int8.onnx.data', 'decoder_joint-int8.onnx', 'vocab.txt'] as const

export interface LoadProgress {
  file: string
  loadedBytes: number
  totalBytesKnown: number
  /** Combined progress across all files in this load call, 0..1 (best-effort if sizes are unknown up front). */
  overall: number
}

async function fetchWithCache(
  url: string,
  onChunk: (loadedDelta: number, totalBytes: number) => void,
): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(url)
  if (cached) {
    const buf = await cached.arrayBuffer()
    onChunk(buf.byteLength, buf.byteLength)
    return buf
  }

  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch model asset ${url}: ${response.status}`)
  }
  const totalBytes = Number(response.headers.get('content-length') ?? 0)

  // cache.put() needs an unread Response — clone before consuming the body for progress.
  void cache.put(url, response.clone()).catch(() => {
    // Cache API storage can fail under quota pressure (Safari especially, see SPEC.md
    // §5.5) — the app still works, it just re-downloads next time.
  })

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

export async function loadModelAssets(
  onProgress?: (progress: LoadProgress) => void,
): Promise<Record<(typeof MODEL_FILES)[number], ArrayBuffer>> {
  // Rough known sizes (bytes) to weight overall progress before real content-length
  // headers are seen — see parakeet/README.md for provenance.
  const approxSizes: Record<string, number> = {
    'encoder-int8.onnx': 1.4e6,
    'encoder-int8.onnx.data': 838e6,
    'decoder_joint-int8.onnx': 52e6,
    'vocab.txt': 92e3,
  }
  const approxTotal = Object.values(approxSizes).reduce((a, b) => a + b, 0)
  const loadedByFile: Record<string, number> = {}

  // Sequential, not parallel: these total ~890MB, and downloading them concurrently
  // would be unfriendly to mobile connections and double-peak memory (each file is
  // buffered fully in memory until handed to onnxruntime). One at a time is gentler
  // and gives a more predictable progress readout.
  const results: Array<[string, ArrayBuffer]> = []
  for (const file of MODEL_FILES) {
    const buf = await fetchWithCache(MODEL_BASE_URL + file, (loadedDelta, totalBytes) => {
      loadedByFile[file] = (loadedByFile[file] ?? 0) + loadedDelta
      const knownTotal = totalBytes || approxSizes[file]
      const overallLoaded = MODEL_FILES.reduce((sum, f) => sum + (loadedByFile[f] ?? 0), 0)
      onProgress?.({
        file,
        loadedBytes: loadedByFile[file],
        totalBytesKnown: knownTotal,
        overall: Math.min(1, overallLoaded / approxTotal),
      })
    })
    results.push([file, buf])
  }

  return Object.fromEntries(results) as Record<(typeof MODEL_FILES)[number], ArrayBuffer>
}
