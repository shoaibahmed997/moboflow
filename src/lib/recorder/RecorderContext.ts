import { createContext, useContext } from 'react'
import type { LoadProgress } from '../asr/modelCache'
import type { AsrEngineStatus } from '../asr/useAsrEngine'

/**
 * - idle: no live session in this tab
 * - starting: acquiring the mic / creating or reopening the session
 * - recording: mic live, utterances being transcribed and persisted
 * - paused: session still owned by this tab, mic released
 */
export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused'

export interface RecorderContextValue {
  state: RecorderState
  /** The live (recording or paused) session, if any. */
  sessionId: string | null
  /** The most recent session this tab recorded — still set after stop, for a "view transcript" link. */
  lastSessionId: string | null
  /** Interim hypothesis for the utterance in progress; not persisted. */
  partialText: string
  elapsedMs: number
  isSpeaking: boolean
  /** True while stopped sessions still have queued utterances awaiting transcription. */
  isFinalizing: boolean
  error: string | null
  micError: string | null
  engine: {
    status: AsrEngineStatus
    progress: LoadProgress | null
    stage: string | null
    error: string | null
    /** Model the engine is running (or loading), if any. */
    modelId: string | null
  }
  start: () => Promise<void>
  /** Resumes the paused session, or — when idle — reopens an earlier session by id. */
  resume: (sessionId?: string) => Promise<void>
  pause: () => void
  stop: () => Promise<void>
  retryEngine: () => void
}

export const RecorderContext = createContext<RecorderContextValue | null>(null)

// Split out because it updates ~30×/s while recording; only the level meter needs it.
export const MicLevelContext = createContext(0)

export function useRecorder(): RecorderContextValue {
  const ctx = useContext(RecorderContext)
  if (!ctx) throw new Error('useRecorder must be used inside <RecorderProvider>')
  return ctx
}

export function useMicLevel(): number {
  return useContext(MicLevelContext)
}
