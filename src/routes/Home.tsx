import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../lib/db'
import { useMicLevel, useRecorder, type RecorderState } from '../lib/recorder/RecorderContext'
import { completeSession, formatDuration, getSessionSegments } from '../lib/sessions'

export function Home() {
  const recorder = useRecorder()
  const { state, engine } = recorder
  const isLive = state === 'recording' || state === 'paused'

  // Finalized text is read back from IndexedDB, the single source of truth — so a
  // resumed/recovered session renders exactly like one recorded in this tab.
  const displayId = recorder.sessionId ?? recorder.lastSessionId
  const displaySession = useLiveQuery(
    async () => (displayId ? ((await db.sessions.get(displayId)) ?? null) : null),
    [displayId],
  )
  const segments = useLiveQuery(
    async () => (displayId ? getSessionSegments(displayId) : []),
    [displayId],
  )
  const latestDraft = useLiveQuery(async () => {
    const drafts = await db.sessions.where('status').equals('draft').reverse().sortBy('updatedAt')
    return drafts[0] ?? null
  }, [])

  const partialText = isLive ? recorder.partialText : ''
  const transcriptRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [segments?.length, partialText])

  const modelLoading = engine.status === 'loading'
  const showSavedLink = !isLive && displaySession && !recorder.isFinalizing

  const onPrimary = () => {
    if (state === 'idle') void recorder.start()
    else if (state === 'recording') recorder.pause()
    else if (state === 'paused') void recorder.resume()
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-between gap-4 overflow-y-auto px-4 py-6 text-center">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Moboflow</h1>
        <p className="mt-1 text-xs text-slate-500">Let your thoughts flow into your mobile.</p>
      </div>

      {state === 'idle' && latestDraft && (
        <div className="w-full max-w-md rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left text-sm">
          <p className="font-medium text-amber-200">Recovered an interrupted recording</p>
          <p className="mt-0.5 truncate text-xs text-amber-200/70">
            {latestDraft.title} · {formatDuration(latestDraft.durationMs)}
          </p>
          <div className="mt-2 flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => void recorder.resume(latestDraft.id)}
              className="rounded bg-amber-400 px-3 py-1 font-medium text-slate-950"
            >
              Resume
            </button>
            <button
              type="button"
              onClick={() => void completeSession(latestDraft.id)}
              className="rounded px-3 py-1 text-amber-200"
            >
              Save as is
            </button>
            <Link to={`/sessions/${latestDraft.id}`} className="rounded px-3 py-1 text-amber-200/70">
              View
            </Link>
          </div>
        </div>
      )}

      <div
        ref={transcriptRef}
        className="flex w-full max-w-md flex-1 flex-col gap-2 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-left text-sm leading-relaxed text-slate-200"
      >
        {!segments?.length && !partialText ? (
          <p className="text-slate-500">
            {isLive ? 'Start speaking — your words will appear here.' : 'Transcript will appear here as you speak.'}
          </p>
        ) : (
          <>
            {segments?.map((segment) => (
              <p key={segment.id}>{segment.text}</p>
            ))}
            {partialText && <p className="text-slate-400 italic">{partialText}…</p>}
          </>
        )}
      </div>

      {recorder.isFinalizing && !isLive && (
        <p className="text-xs text-slate-400">Finishing transcription — saving shortly…</p>
      )}
      {showSavedLink && (
        <p className="text-xs text-slate-400">
          Saved ·{' '}
          <Link to={`/sessions/${displaySession.id}`} className="text-sky-400">
            View “{displaySession.title}”
          </Link>
        </p>
      )}

      {modelLoading && engine.progress && !engine.stage && (
        <div className="w-full max-w-md text-xs text-slate-400">
          <div className="mb-1 flex justify-between">
            <span>Downloading transcription model ({engine.progress.file})…</span>
            <span>{Math.round(engine.progress.overall * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-sky-500 transition-all"
              style={{ width: `${engine.progress.overall * 100}%` }}
            />
          </div>
          <p className="mt-1 text-slate-500">
            One-time ~890MB download, cached on this device for offline use afterward. You can
            keep talking — speech is queued and transcribed once it's ready.
          </p>
        </div>
      )}

      {modelLoading && engine.stage && (
        <div className="w-full max-w-md text-xs text-slate-400">
          <p>{engine.stage}</p>
          <p className="mt-1 text-slate-500">
            First-time setup only — this can take a minute or two on-device, then it's cached.
          </p>
        </div>
      )}

      {engine.error && (
        <p className="text-xs text-red-400">
          Transcription engine error: {engine.error}
          {engine.status === 'error' && (
            <button type="button" onClick={recorder.retryEngine} className="ml-2 text-sky-400 underline">
              Retry
            </button>
          )}
        </p>
      )}
      {recorder.micError && <p className="text-xs text-red-400">Microphone error: {recorder.micError}</p>}
      {recorder.error && <p className="text-xs text-red-400">{recorder.error}</p>}

      <div className="flex flex-col items-center gap-2">
        {isLive && (
          <p className="font-mono text-sm text-slate-300 tabular-nums">{formatDuration(recorder.elapsedMs)}</p>
        )}
        <div className="flex items-center gap-6">
          {isLive && <div className="h-12 w-12" aria-hidden />}
          <RecordButton state={state} onClick={onPrimary} />
          {isLive && (
            <button
              type="button"
              onClick={() => void recorder.stop()}
              aria-label="Stop and save"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800 text-slate-200 hover:bg-slate-700"
            >
              <span className="h-4 w-4 rounded-sm bg-current" />
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {state === 'starting'
            ? 'Requesting microphone…'
            : state === 'recording'
              ? recorder.isSpeaking
                ? 'Listening…'
                : 'Recording — waiting for speech'
              : state === 'paused'
                ? 'Paused — tap to resume'
                : modelLoading
                  ? (engine.stage ?? `Downloading model — ${Math.round((engine.progress?.overall ?? 0) * 100)}%`)
                  : 'Tap to start'}
        </p>
      </div>
    </div>
  )
}

function RecordButton({ state, onClick }: { state: RecorderState; onClick: () => void }) {
  const level = useMicLevel()
  const isRecording = state === 'recording'
  const label = state === 'recording' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start recording'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'starting'}
      aria-label={label}
      className={`flex h-24 w-24 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed ${
        isRecording ? 'bg-red-500/90 text-white' : 'bg-sky-500 text-slate-950'
      }`}
      style={isRecording ? { boxShadow: `0 0 0 ${8 + level * 16}px rgba(239,68,68,0.15)` } : undefined}
    >
      {isRecording ? <PauseIcon className="h-9 w-9" /> : <MicIcon className="h-9 w-9" />}
    </button>
  )
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" strokeLinecap="round" />
      <path d="M12 18v4" strokeLinecap="round" />
      <path d="M8 22h8" strokeLinecap="round" />
    </svg>
  )
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </svg>
  )
}
