import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineBackend } from './engine.worker'
import type { LoadProgress } from './modelCache'

export type AsrEngineStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Shown instead of a bare "Failed to fetch" when a load fails without a connection. */
export const OFFLINE_LOAD_MESSAGE =
  "You're offline, and the transcription model isn't fully downloaded on this device yet. " +
  'Connect to the internet to finish the one-time download — anything you said is kept and will be transcribed then.'

export interface AsrResult {
  id: string
  text: string
  isFinal: boolean
}

interface UseAsrEngineOptions {
  onResult?: (result: AsrResult) => void
  /** A single transcription job failed; the engine itself is still usable. */
  onTranscribeError?: (id: string, message: string) => void
  /** The engine failed to load; every job queued so far will never produce a result. */
  onLoadError?: (message: string) => void
}

/**
 * Spawns the ASR Web Worker (src/lib/asr/engine.worker.ts) and exposes its lifecycle.
 * `load()` must be called explicitly (e.g. on the user's first tap of record) — it
 * triggers a ~890MB one-time download, so it must never happen silently on page load.
 */
export function useAsrEngine({ onResult, onTranscribeError, onLoadError }: UseAsrEngineOptions = {}) {
  const [status, setStatus] = useState<AsrEngineStatus>('idle')
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The model the running worker was started with. */
  const [modelId, setModelId] = useState<string | null>(null)
  /** Where the encoder ended up running, once ready. */
  const [backend, setBackend] = useState<EngineBackend | null>(null)
  /** The browser had evicted this model's cached files, so it's downloading again. */
  const [reDownloading, setReDownloading] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const modelIdRef = useRef<string | null>(null)
  const onResultRef = useRef(onResult)
  const onTranscribeErrorRef = useRef(onTranscribeError)
  const onLoadErrorRef = useRef(onLoadError)

  useEffect(() => {
    onResultRef.current = onResult
    onTranscribeErrorRef.current = onTranscribeError
    onLoadErrorRef.current = onLoadError
  }, [onResult, onTranscribeError, onLoadError])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  /**
   * Starts the worker for `targetModelId`. A no-op if that model is already loading or
   * loaded; if a different model is running, it's replaced (callers must make sure no
   * queued jobs still need the old one — see RecorderProvider).
   */
  const load = useCallback((targetModelId: string) => {
    if (workerRef.current) {
      if (modelIdRef.current === targetModelId) return
      workerRef.current.terminate()
      workerRef.current = null
    }
    modelIdRef.current = targetModelId
    setModelId(targetModelId)
    // Ask for persistent storage so the browser doesn't silently evict hundreds of MB of
    // weights under pressure (best-effort; main-thread-only API, often auto-granted for
    // installed PWAs).
    void navigator.storage
      ?.persisted?.()
      .then((persisted) => persisted || navigator.storage.persist())
      .catch(() => {})
    setProgress(null)
    setStatus('loading')
    setError(null)
    setStage(null)
    setBackend(null)
    setReDownloading(false)

    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data
      switch (msg.type) {
        case 'progress':
          setProgress(msg.progress)
          break
        case 'stage':
          setStage(msg.stage)
          break
        case 'ready':
          setStatus('ready')
          setStage(null)
          setBackend(msg.backend)
          setReDownloading(false)
          break
        case 'notice':
          if (msg.notice === 'model-evicted') setReDownloading(true)
          break
        case 'load-error':
          fail(msg.message)
          break
        case 'result':
          onResultRef.current?.({ id: msg.id, text: msg.text, isFinal: msg.isFinal })
          break
        case 'transcribe-error':
          setError(msg.message)
          onTranscribeErrorRef.current?.(msg.id, msg.message)
          break
      }
    }
    worker.onerror = (event) => fail(event.message)

    // Tear the worker down on load failure so a later load() call can retry from scratch.
    function fail(message: string) {
      worker.terminate()
      if (workerRef.current !== worker) return // already replaced by a load() for another model
      workerRef.current = null
      if (!navigator.onLine) console.warn('[asr] load failed while offline:', message)
      const shown = navigator.onLine ? message : OFFLINE_LOAD_MESSAGE
      setStatus('error')
      setError(shown)
      onLoadErrorRef.current?.(shown)
    }

    worker.postMessage({ type: 'init', modelId: targetModelId })
  }, [])

  /**
   * Queues a job and returns its id, or null if no engine is running (never loaded, or
   * load failed). Jobs sent while the model is still loading are held by the worker.
   */
  const transcribe = useCallback((pcm: Float32Array, isFinal: boolean): string | null => {
    const worker = workerRef.current
    if (!worker) return null
    const id = crypto.randomUUID()
    // Transfer the buffer — the worker owns it from here, main thread doesn't need it back.
    worker.postMessage({ type: 'transcribe', id, pcm, isFinal }, [pcm.buffer])
    return id
  }, [])

  /** Whether queued work would be lost by switching to `targetModelId`. */
  const wouldSwitchModel = useCallback(
    (targetModelId: string) => workerRef.current !== null && modelIdRef.current !== targetModelId,
    [],
  )

  return { status, progress, stage, error, modelId, backend, reDownloading, load, transcribe, wouldSwitchModel }
}
