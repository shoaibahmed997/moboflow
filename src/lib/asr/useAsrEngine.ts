import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoadProgress } from './modelCache'

export type AsrEngineStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AsrResult {
  id: string
  text: string
  isFinal: boolean
}

interface UseAsrEngineOptions {
  onResult?: (result: AsrResult) => void
}

/**
 * Spawns the ASR Web Worker (src/lib/asr/engine.worker.ts) and exposes its lifecycle.
 * `load()` must be called explicitly (e.g. on the user's first tap of record) — it
 * triggers a ~890MB one-time download, so it must never happen silently on page load.
 */
export function useAsrEngine({ onResult }: UseAsrEngineOptions = {}) {
  const [status, setStatus] = useState<AsrEngineStatus>('idle')
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const onResultRef = useRef(onResult)

  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const load = useCallback(() => {
    if (workerRef.current) return
    setStatus('loading')
    setError(null)
    setStage(null)

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
          break
        case 'load-error':
          setStatus('error')
          setError(msg.message)
          break
        case 'result':
          onResultRef.current?.({ id: msg.id, text: msg.text, isFinal: msg.isFinal })
          break
        case 'transcribe-error':
          setError(msg.message)
          break
      }
    }
    worker.onerror = (event) => {
      setStatus('error')
      setError(event.message)
    }

    worker.postMessage({ type: 'init' })
  }, [])

  const transcribe = useCallback((pcm: Float32Array, isFinal: boolean): string => {
    const id = crypto.randomUUID()
    // Transfer the buffer — the worker owns it from here, main thread doesn't need it back.
    workerRef.current?.postMessage({ type: 'transcribe', id, pcm, isFinal }, [pcm.buffer])
    return id
  }, [])

  return { status, progress, stage, error, load, transcribe }
}
