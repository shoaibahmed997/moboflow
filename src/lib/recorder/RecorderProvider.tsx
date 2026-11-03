import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_LANGUAGE, modelForLanguage } from '../asr/models'
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

/** A finalized utterance sent to the ASR worker, awaiting its transcript. */
interface PendingFinal {
  sessionId: string
  startMs: number
  endMs: number
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

  // Mirrors of state that async callbacks must read synchronously.
  const stateRef = useRef<RecorderState>('idle')
  const sessionIdRef = useRef<string | null>(null)
  const offsetMsRef = useRef(0)
  const spanStartRef = useRef<number | null>(null)
  const latestPartialIdRef = useRef<string | null>(null)
  /** Language of the live session — selects the model on resume/retry. */
  const languageRef = useRef<string | null>(null)
  const pendingRef = useRef(new Map<string, PendingFinal>())
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
      for (const pending of pendingRef.current.values()) if (pending.sessionId === id) return

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
      const write = trimmed
        ? appendSegment({ id, sessionId: pending.sessionId, startMs: pending.startMs, endMs: pending.endMs, text: trimmed })
        : Promise.resolve(false)
      write
        .catch((err) => setError(`Couldn't save transcript: ${errorMessage(err)}`))
        .finally(() => void settleIfDone(pending.sessionId))
    },
    [settleIfDone],
  )

  const handleLoadError = useCallback(() => {
    // Nothing queued in the dead worker will ever come back.
    for (const jobId of [...pendingRef.current.keys()]) dropPending(jobId)
    latestPartialIdRef.current = null
    setPartialText('')
  }, [dropPending])

  const asr = useAsrEngine({
    onResult: handleResult,
    onTranscribeError: dropPending,
    onLoadError: handleLoadError,
  })
  const { load: loadEngine, transcribe, wouldSwitchModel } = asr

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
      return true
    },
    [loadEngine, wouldSwitchModel],
  )

  const mic = useMicCapture({
    onSegment: (pcm, timing: SegmentTiming) => {
      const id = sessionIdRef.current
      if (!id) return
      // Any partial still queued is for this same utterance and would only flash stale text.
      latestPartialIdRef.current = null
      const jobId = transcribe(pcm, true)
      if (!jobId) return
      pendingRef.current.set(jobId, {
        sessionId: id,
        startMs: offsetMsRef.current + timing.startMs,
        endMs: offsetMsRef.current + timing.endMs,
      })
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
      if (!ensureEngine(language)) {
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
  }, [activate, beginSpan, deactivate, ensureEngine, releaseLock, setPhase])

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
    [activate, beginSpan, deactivate, ensureEngine, releaseLock, setPhase],
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
      engine: { status: asr.status, progress: asr.progress, stage: asr.stage, error: asr.error, modelId: asr.modelId },
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
      asr.status,
      asr.progress,
      asr.stage,
      asr.error,
      asr.modelId,
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
