import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_LANGUAGE, modelForLanguage, modelSize } from '../asr/models'
import { canLoadOffline, isQuotaError } from '../asr/modelStorage'
import { useAsrEngine, type AsrResult } from '../asr/useAsrEngine'
import { useMicCapture, type SegmentTiming } from '../audio/useMicCapture'
import { db } from '../db'
import {
  acquireSessionLock,
  createLivenessCheck,
  HEARTBEAT_INTERVAL_MS,
  type ReleaseLock,
} from '../sessionLock'
import { getSetting } from '../settings'
import {
  appendSegment,
  completeSession,
  createSession,
  deleteSession,
  recoverInterruptedSessions,
  saveSessionProgress,
  setSessionStatus,
} from '../sessions'
import { MicLevelContext, RecorderContext, type RecorderContextValue, type RecorderState } from './RecorderContext'

/**
 * A finalized utterance awaiting its transcript. The audio is retained (the worker gets
 * a copy) until the transcript is saved, so an engine failure never loses speech: the
 * utterance is held and resubmitted when the engine comes back.
 */
interface PendingFinal {
  sessionId: string
  startMs: number
  endMs: number
  pcm: Float32Array
}

/** A transcribed sentence that couldn't be written to IndexedDB yet (e.g. quota). */
interface UnsavedSegment {
  id: string
  sessionId: string
  startMs: number
  endMs: number
  text: string
}

const UNSAVED_RETRY_MS = 5_000

function offlineStartMessage(language: string): string {
  const mb = Math.round(modelSize(modelForLanguage(language)) / 1e6)
  return (
    "You're offline, and the transcription model isn't downloaded on this device yet. " +
    `Connect once to download it (~${mb}MB) — after that, recording works fully offline.`
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Owns the recording lifecycle (start/pause/resume/stop) for the whole app, so a live
 * session — and the loaded ASR engine — survive route changes. Finalized utterances are
 * written to IndexedDB as soon as they're transcribed, and the session row gets an
 * autosave heartbeat, so killing the tab loses at most the utterance in progress.
 *
 * Session timeline: each capture span's VAD timestamps restart at 0, so segment times
 * are offset by the session's accumulated duration at the moment that span began.
 */
export function RecorderProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RecorderState>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [lastSessionId, setLastSessionId] = useState<string | null>(null)
  const [partialText, setPartialText] = useState('')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [finalizingCount, setFinalizingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** Utterances waiting for a working engine (load failed / offline). */
  const [heldCount, setHeldCount] = useState(0)
  /** Transcribed sentences not yet written to storage, and whether storage is full. */
  const [unsaved, setUnsaved] = useState({ count: 0, quota: false })

  // Mirrors of state that async callbacks must read synchronously.
  const stateRef = useRef<RecorderState>('idle')
  const sessionIdRef = useRef<string | null>(null)
  const offsetMsRef = useRef(0)
  const spanStartRef = useRef<number | null>(null)
  const latestPartialIdRef = useRef<string | null>(null)
  /** Language of the live session — selects the model on resume/retry. */
  const languageRef = useRef<string | null>(null)
  const pendingRef = useRef(new Map<string, PendingFinal>())
  const heldRef = useRef<PendingFinal[]>([])
  const unsavedRef = useRef<UnsavedSegment[]>([])
  /** Stopped sessions waiting on pendingRef to drain before being marked complete. */
  const finalizingRef = useRef(new Set<string>())
  const locksRef = useRef(new Map<string, ReleaseLock>())

  const setPhase = useCallback((next: RecorderState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const currentDurationMs = useCallback(
    () => offsetMsRef.current + (spanStartRef.current === null ? 0 : Date.now() - spanStartRef.current),
    [],
  )

  const releaseLock = useCallback((id: string) => {
    locksRef.current.get(id)?.()
    locksRef.current.delete(id)
  }, [])

  const settleIfDone = useCallback(
    async (id: string) => {
      if (!finalizingRef.current.has(id)) return
      const belongs = (item: { sessionId: string }) => item.sessionId === id
      if ([...pendingRef.current.values()].some(belongs) || heldRef.current.some(belongs)) return
      if (unsavedRef.current.some(belongs)) return

      finalizingRef.current.delete(id)
      setFinalizingCount(finalizingRef.current.size)
      try {
        const kept = await completeSession(id)
        if (!kept) setLastSessionId((prev) => (prev === id ? null : prev))
      } catch (err) {
        // Left as 'recording'; the next app load recovers it as a draft.
        setError(`Couldn't finish saving the recording: ${errorMessage(err)}`)
      } finally {
        releaseLock(id)
      }
    },
    [releaseLock],
  )

  const dropPending = useCallback(
    (jobId: string) => {
      const pending = pendingRef.current.get(jobId)
      if (!pending) return
      pendingRef.current.delete(jobId)
      void settleIfDone(pending.sessionId)
    },
    [settleIfDone],
  )

  const syncUnsaved = useCallback(() => {
    setUnsaved((prev) => ({ count: unsavedRef.current.length, quota: unsavedRef.current.length > 0 && prev.quota }))
  }, [])

  /**
   * Writes a transcribed sentence; on failure keeps it in memory for retry rather than
   * dropping it. Resolves true once it's stored (or its session no longer exists).
   */
  const persistSegment = useCallback(
    async (segment: UnsavedSegment): Promise<boolean> => {
      try {
        await appendSegment(segment)
        return true
      } catch (err) {
        const quota = isQuotaError(err)
        if (!unsavedRef.current.some((s) => s.id === segment.id)) unsavedRef.current.push(segment)
        setUnsaved({ count: unsavedRef.current.length, quota })
        if (!quota) console.warn('[recorder] segment write failed; will retry', err)
        return false
      }
    },
    [],
  )

  const flushUnsaved = useCallback(async () => {
    for (const segment of [...unsavedRef.current]) {
      try {
        await appendSegment(segment)
      } catch {
        return // still failing — keep the rest queued, in order
      }
      unsavedRef.current = unsavedRef.current.filter((s) => s.id !== segment.id)
      syncUnsaved()
      void settleIfDone(segment.sessionId)
    }
  }, [settleIfDone, syncUnsaved])

  const handleResult = useCallback(
    ({ id, text, isFinal }: AsrResult) => {
      if (!isFinal) {
        if (id === latestPartialIdRef.current) setPartialText(text.trim())
        return
      }
      const pending = pendingRef.current.get(id)
      if (!pending) return
      pendingRef.current.delete(id)
      if (pending.sessionId === sessionIdRef.current) setPartialText('')

      const trimmed = text.trim()
      const { sessionId: owner, startMs, endMs } = pending
      const write = trimmed ? persistSegment({ id, sessionId: owner, startMs, endMs, text: trimmed }) : Promise.resolve(true)
      void write.then(() => settleIfDone(owner))
    },
    [persistSegment, settleIfDone],
  )

  const handleLoadError = useCallback(() => {
    // The dead worker will never answer: move its queue (oldest first) back to held, so
    // it's resubmitted on the next successful load instead of being lost.
    heldRef.current = [...pendingRef.current.values(), ...heldRef.current]
    pendingRef.current.clear()
    setHeldCount(heldRef.current.length)
    latestPartialIdRef.current = null
    setPartialText('')
  }, [])

  const asr = useAsrEngine({
    onResult: handleResult,
    onTranscribeError: dropPending,
    onLoadError: handleLoadError,
  })
  const { load: loadEngine, transcribe, wouldSwitchModel } = asr
  const engineStatusRef = useRef(asr.status)
  useEffect(() => {
    engineStatusRef.current = asr.status
  }, [asr.status])

  /** Sends a final utterance to the engine (a copy — we keep the audio), or holds it. */
  const submitFinal = useCallback(
    (entry: PendingFinal) => {
      const jobId = transcribe(entry.pcm.slice(), true)
      if (jobId) pendingRef.current.set(jobId, entry)
      else heldRef.current.push(entry)
    },
    [transcribe],
  )

  const resubmitHeld = useCallback(() => {
    const held = heldRef.current
    heldRef.current = []
    for (const entry of held) submitFinal(entry)
    setHeldCount(heldRef.current.length)
  }, [submitFinal])

  /**
   * Loads the model serving `language` (a no-op when it's already the running one).
   * Refuses to swap models while utterances queued on the current one are still
   * awaiting transcription, since replacing the worker would drop them.
   */
  const ensureEngine = useCallback(
    (language: string): boolean => {
      const model = modelForLanguage(language)
      if (wouldSwitchModel(model.id) && pendingRef.current.size > 0) {
        setError('Still transcribing the previous recording with another model — try again in a moment.')
        return false
      }
      loadEngine(model.id)
      resubmitHeld() // the worker queues these until the model is ready
      return true
    },
    [loadEngine, resubmitHeld, wouldSwitchModel],
  )

  /**
   * Whether recording in `language` can produce transcripts. Offline, that needs the
   * model and runtime already cached (or already loaded) — otherwise refuse up front
   * rather than record speech that has nowhere to go.
   */
  const canTranscribe = useCallback(
    async (language: string): Promise<boolean> => {
      if (navigator.onLine) return true
      const model = modelForLanguage(language)
      if (!wouldSwitchModel(model.id) && engineStatusRef.current === 'ready') return true
      if (await canLoadOffline(model).catch(() => false)) return true
      setError(offlineStartMessage(language))
      return false
    },
    [wouldSwitchModel],
  )

  const mic = useMicCapture({
    onSegment: (pcm, timing: SegmentTiming) => {
      const id = sessionIdRef.current
      if (!id) return
      // Any partial still queued is for this same utterance and would only flash stale text.
      latestPartialIdRef.current = null
      submitFinal({
        sessionId: id,
        startMs: offsetMsRef.current + timing.startMs,
        endMs: offsetMsRef.current + timing.endMs,
        pcm,
      })
      setHeldCount(heldRef.current.length)
    },
    onPartial: (pcm) => {
      if (!sessionIdRef.current) return
      latestPartialIdRef.current = transcribe(pcm, false)
    },
  })
  const { start: startMic, stop: stopMic } = mic

  const activate = useCallback((id: string, offsetMs: number, language: string) => {
    sessionIdRef.current = id
    languageRef.current = language
    offsetMsRef.current = offsetMs
    spanStartRef.current = null
    setSessionId(id)
    setElapsedMs(offsetMs)
  }, [])

  const deactivate = useCallback(() => {
    sessionIdRef.current = null
    languageRef.current = null
    offsetMsRef.current = 0
    spanStartRef.current = null
    latestPartialIdRef.current = null
    setSessionId(null)
    setPartialText('')
  }, [])

  const beginSpan = useCallback(async (): Promise<boolean> => {
    if (!(await startMic())) return false
    spanStartRef.current = Date.now()
    setLastSessionId(sessionIdRef.current)
    setPhase('recording')
    return true
  }, [startMic, setPhase])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    setPhase('starting')
    setError(null)
    let createdId: string | null = null
    try {
      const language = await getSetting('language')
      if (!(await canTranscribe(language)) || !ensureEngine(language)) {
        setPhase('idle')
        return
      }
      const session = await createSession(language)
      createdId = session.id
      const release = await acquireSessionLock(session.id)
      if (release) locksRef.current.set(session.id, release)
      activate(session.id, 0, session.language)
      if (await beginSpan()) return
    } catch (err) {
      setError(`Couldn't start recording: ${errorMessage(err)}`)
    }
    // Mic denied/unavailable (surfaced via micError) or storage failure: undo the empty session.
    deactivate()
    if (createdId) {
      releaseLock(createdId)
      await deleteSession(createdId).catch(() => {})
    }
    setPhase('idle')
  }, [activate, beginSpan, canTranscribe, deactivate, ensureEngine, releaseLock, setPhase])

  const resume = useCallback(
    async (targetId?: string) => {
      if (stateRef.current === 'paused') {
        setPhase('starting')
        // Also retries the load if the engine failed earlier.
        if (!ensureEngine(languageRef.current ?? DEFAULT_LANGUAGE) || !(await beginSpan())) setPhase('paused')
        return
      }
      if (stateRef.current !== 'idle' || !targetId) return

      setPhase('starting')
      setError(null)
      if (finalizingRef.current.has(targetId)) {
        setError('That recording is still being transcribed — try again in a moment.')
        setPhase('idle')
        return
      }
      const release = await acquireSessionLock(targetId)
      if (!release) {
        setError('That recording is open in another tab.')
        setPhase('idle')
        return
      }
      locksRef.current.set(targetId, release)

      let previousStatus: 'draft' | 'complete' | 'recording' | null = null
      try {
        const session = await db.sessions.get(targetId)
        if (!session) throw new Error('recording not found')
        previousStatus = session.status
        if (!(await canTranscribe(session.language))) throw new Error('offline without the transcription model')
        if (!ensureEngine(session.language)) throw new Error('the transcription engine is busy')
        await setSessionStatus(targetId, 'recording')
        activate(targetId, session.durationMs, session.language)
        if (await beginSpan()) return
      } catch (err) {
        setError(`Couldn't resume recording: ${errorMessage(err)}`)
      }
      deactivate()
      if (previousStatus && previousStatus !== 'recording') {
        await setSessionStatus(targetId, previousStatus).catch(() => {})
      }
      releaseLock(targetId)
      setPhase('idle')
    },
    [activate, beginSpan, canTranscribe, deactivate, ensureEngine, releaseLock, setPhase],
  )

  const retryEngine = useCallback(() => {
    void getSetting('language').then((preferred) => ensureEngine(languageRef.current ?? preferred))
  }, [ensureEngine])

  const pause = useCallback(() => {
    const id = sessionIdRef.current
    if (stateRef.current !== 'recording' || !id) return
    stopMic() // flushes the in-progress utterance through onSegment synchronously
    offsetMsRef.current = currentDurationMs()
    spanStartRef.current = null
    latestPartialIdRef.current = null
    setPartialText('')
    setElapsedMs(offsetMsRef.current)
    setPhase('paused')
    saveSessionProgress(id, offsetMsRef.current).catch(() => {}) // heartbeat retries
  }, [currentDurationMs, setPhase, stopMic])

  const stop = useCallback(async () => {
    const id = sessionIdRef.current
    const phase = stateRef.current
    if ((phase !== 'recording' && phase !== 'paused') || !id) return
    if (phase === 'recording') stopMic() // flush first, while id/offset still apply
    const durationMs = currentDurationMs()
    deactivate()
    setPhase('idle')

    finalizingRef.current.add(id)
    setFinalizingCount(finalizingRef.current.size)
    try {
      await saveSessionProgress(id, durationMs)
    } catch (err) {
      setError(`Couldn't save the recording length: ${errorMessage(err)}`)
    }
    await settleIfDone(id)
  }, [currentDurationMs, deactivate, setPhase, settleIfDone, stopMic])

  // Live timer.
  useEffect(() => {
    if (state !== 'recording') return
    const timer = setInterval(() => setElapsedMs(currentDurationMs()), 500)
    return () => clearInterval(timer)
  }, [state, currentDurationMs])

  // Autosave heartbeat while a session is live (recording or paused), plus a
  // best-effort save when the page is hidden — often the last chance on mobile.
  useEffect(() => {
    if (!sessionId) return
    const save = () => void saveSessionProgress(sessionId, currentDurationMs()).catch(() => {})
    const timer = setInterval(save, HEARTBEAT_INTERVAL_MS)
    const onHide = () => {
      if (document.visibilityState === 'hidden') save()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', save)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', save)
    }
  }, [sessionId, currentDurationMs])

  // Unsaved sentences (storage full / write errors): keep retrying until they land.
  useEffect(() => {
    if (unsaved.count === 0) return
    const timer = setInterval(() => void flushUnsaved(), UNSAVED_RETRY_MS)
    return () => clearInterval(timer)
  }, [unsaved.count, flushUnsaved])

  // Back online with speech waiting on a failed engine: retry the load automatically.
  useEffect(() => {
    const onOnline = () => {
      if (heldRef.current.length > 0 && engineStatusRef.current === 'error') retryEngine()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [retryEngine])

  // Closing the tab now would lose speech that isn't saved yet — ask first.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingRef.current.size + heldRef.current.length + unsavedRef.current.length === 0) return
      event.preventDefault()
      event.returnValue = '' // still required by some browsers to show the prompt
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Crash recovery: demote sessions left 'recording' by a dead tab to 'draft'.
  useEffect(() => {
    let cancelled = false
    void createLivenessCheck()
      .then((isLive) => {
        if (cancelled) return
        return recoverInterruptedSessions((session) => locksRef.current.has(session.id) || isLive(session))
      })
      .catch((err) => console.warn('[recorder] session recovery failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const locks = locksRef.current
    return () => {
      for (const release of locks.values()) release()
      locks.clear()
    }
  }, [])

  const value = useMemo<RecorderContextValue>(
    () => ({
      state,
      sessionId,
      lastSessionId,
      partialText,
      elapsedMs,
      isSpeaking: mic.isSpeaking,
      isFinalizing: finalizingCount > 0,
      error,
      micError: mic.error,
      heldCount,
      unsavedCount: unsaved.count,
      storageFull: unsaved.quota,
      engine: {
        status: asr.status,
        progress: asr.progress,
        stage: asr.stage,
        error: asr.error,
        modelId: asr.modelId,
        backend: asr.backend,
        reDownloading: asr.reDownloading,
      },
      start,
      resume,
      pause,
      stop,
      retryEngine,
    }),
    [
      state,
      sessionId,
      lastSessionId,
      partialText,
      elapsedMs,
      mic.isSpeaking,
      mic.error,
      finalizingCount,
      error,
      heldCount,
      unsaved,
      asr.status,
      asr.progress,
      asr.stage,
      asr.error,
      asr.modelId,
      asr.backend,
      asr.reDownloading,
      start,
      resume,
      pause,
      stop,
      retryEngine,
    ],
  )

  return (
    <RecorderContext.Provider value={value}>
      <MicLevelContext.Provider value={mic.level}>{children}</MicLevelContext.Provider>
    </RecorderContext.Provider>
  )
}
