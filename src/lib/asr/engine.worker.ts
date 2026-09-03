/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu'
import { extractLogMelFeatures } from './mel'
import { loadModelAssets, type LoadProgress } from './modelCache'
import { greedyTdtDecode } from './tdtDecode'
import { parseVocab, type Tokenizer } from './tokenizer'

ort.env.wasm.wasmPaths = '/ort/'
// Deliberately single-threaded. onnxruntime-web's threaded WASM backend spawns its own
// pthread pool via nested Web Workers, and running that *inside* our own Worker (rather
// than on the main thread) deadlocks session creation indefinitely — confirmed via a
// timed A/B (numThreads>1 never completed session creation in 10+ minutes; numThreads=1
// completed in ~1.5s total) and independently reproduced in a real browser, not just
// headless Chromium. This still applies with the WebGPU-capable build below: thread-pool
// setup happens at wasm-module init time regardless of which execution provider ends up
// running a given op, so the deadlock risk exists even though WebGPU compute itself
// doesn't need CPU threads. See SPEC.md §5 risk #4 / §6 Phase 3 — revisit only by moving
// the engine off a dedicated Worker.
ort.env.wasm.numThreads = 1

// Feature-detected, not assumed: Safari/older browsers have no navigator.gpu, and even
// where it exists, requesting an adapter can still fail (blocklisted GPU, software-only
// environment) — both cases are handled by falling back to the wasm EP at session-create
// time below, not just here.
const hasWebGPU = 'gpu' in self.navigator
console.log(
  `[asr worker] crossOriginIsolated=${self.crossOriginIsolated} numThreads=${ort.env.wasm.numThreads} hardwareConcurrency=${navigator.hardwareConcurrency} hasWebGPU=${hasWebGPU}`,
)

type InboundMessage =
  | { type: 'init' }
  | { type: 'transcribe'; id: string; pcm: Float32Array; isFinal: boolean }

type OutboundMessage =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'stage'; stage: string }
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'result'; id: string; text: string; isFinal: boolean }
  | { type: 'transcribe-error'; id: string; message: string }

function post(msg: OutboundMessage, transfer?: Transferable[]) {
  // @ts-expect-error postMessage overload resolution with a transfer list
  self.postMessage(msg, transfer)
}

let encoderSession: ort.InferenceSession | null = null
let decoderJointSession: ort.InferenceSession | null = null
let tokenizer: Tokenizer | null = null

async function init() {
  console.log('[asr worker] downloading model assets...')
  const downloadStart = performance.now()
  const assets = await loadModelAssets((progress) => post({ type: 'progress', progress }))
  console.log(`[asr worker] download done in ${((performance.now() - downloadStart) / 1000).toFixed(1)}s`)

  tokenizer = parseVocab(new TextDecoder().decode(assets['vocab.txt']))

  post({ type: 'stage', stage: 'Initializing encoder…' })
  console.log('[asr worker] creating encoder session...')
  let t0 = performance.now()
  const encoderOptionsBase = {
    graphOptimizationLevel: 'disabled' as const, // already quantized/optimized at export time
    externalData: [{ path: 'encoder-int8.onnx.data', data: new Uint8Array(assets['encoder-int8.onnx.data']) }],
  }
  if (hasWebGPU) {
    try {
      // 'wasm' listed second so any op WebGPU can't run (int8-quantized kernels have
      // partial WebGPU coverage) still executes there instead of failing session
      // creation outright — ORT places each op on the first provider that supports it.
      encoderSession = await ort.InferenceSession.create(assets['encoder-int8.onnx'], {
        ...encoderOptionsBase,
        executionProviders: ['webgpu', 'wasm'],
      })
      console.log(`[asr worker] encoder session ready on webgpu(+wasm fallback) in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    } catch (err) {
      console.warn('[asr worker] webgpu encoder session creation failed, falling back to wasm', err)
    }
  }
  if (!encoderSession) {
    t0 = performance.now()
    encoderSession = await ort.InferenceSession.create(assets['encoder-int8.onnx'], {
      ...encoderOptionsBase,
      executionProviders: ['wasm'],
    })
    console.log(`[asr worker] encoder session ready on wasm in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  }

  post({ type: 'stage', stage: 'Initializing decoder…' })
  console.log('[asr worker] creating decoder_joint session...')
  t0 = performance.now()
  // Kept on wasm deliberately: the TDT decoder-joint runs many small autoregressive
  // steps per utterance, and per-step WebGPU dispatch/readback overhead tends to
  // outweigh its compute advantage at this op size — CPU wins on latency here.
  decoderJointSession = await ort.InferenceSession.create(assets['decoder_joint-int8.onnx'], {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'disabled',
  })
  console.log(`[asr worker] decoder_joint session ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

  post({ type: 'ready' })
}

async function transcribe(pcm: Float32Array): Promise<string> {
  if (!encoderSession || !decoderJointSession || !tokenizer) throw new Error('ASR engine not initialized')

  const { features, numFrames } = extractLogMelFeatures(pcm)

  const encoderResults = await encoderSession.run({
    audio_signal: new ort.Tensor('float32', features, [1, 128, numFrames]),
    length: new ort.Tensor('int64', BigInt64Array.from([BigInt(numFrames)]), [1]),
  })

  const encTime = Number((encoderResults.encoded_lengths.data as BigInt64Array)[0])
  const encoderOutput = encoderResults.outputs.data as Float32Array

  const tokens = await greedyTdtDecode(ort, decoderJointSession, encoderOutput, encTime)
  return tokenizer.decode(tokens)
}

// --- work queue: finals always run in order; a new partial supersedes any pending one ---
interface Job {
  id: string
  pcm: Float32Array
  isFinal: boolean
}
const finalQueue: Job[] = []
let latestPartial: Job | null = null
let busy = false

async function processNext() {
  if (busy) return
  const job = finalQueue.shift() ?? latestPartial
  if (!job) return
  if (job === latestPartial) latestPartial = null

  busy = true
  try {
    const text = await transcribe(job.pcm)
    post({ type: 'result', id: job.id, text, isFinal: job.isFinal })
  } catch (err) {
    post({ type: 'transcribe-error', id: job.id, message: err instanceof Error ? err.message : String(err) })
  } finally {
    busy = false
    void processNext()
  }
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data
  if (msg.type === 'init') {
    init().catch((err) => post({ type: 'load-error', message: err instanceof Error ? err.message : String(err) }))
    return
  }
  if (msg.type === 'transcribe') {
    const job: Job = { id: msg.id, pcm: msg.pcm, isFinal: msg.isFinal }
    if (msg.isFinal) finalQueue.push(job)
    else latestPartial = job
    void processNext()
  }
}
