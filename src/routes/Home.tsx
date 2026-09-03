import { useCallback, useRef, useState } from 'react'
import { useMicCapture } from '../lib/audio/useMicCapture'
import { useAsrEngine } from '../lib/asr/useAsrEngine'

export function Home() {
  const [finalSegments, setFinalSegments] = useState<string[]>([])
  const [partialText, setPartialText] = useState('')
  const isRecordingRef = useRef(false)

  const asr = useAsrEngine({
    onResult: ({ text, isFinal }) => {
      if (isFinal) {
        setPartialText('')
        if (text.trim()) setFinalSegments((prev) => [...prev, text.trim()])
      } else {
        setPartialText(text)
      }
    },
  })

  const mic = useMicCapture({
    onSegment: (pcm) => {
      if (asr.status === 'ready') asr.transcribe(pcm, true)
    },
    onPartial: (pcm) => {
      if (asr.status === 'ready') asr.transcribe(pcm, false)
    },
  })

  const toggleRecording = useCallback(async () => {
    if (isRecordingRef.current) {
      mic.stop()
      isRecordingRef.current = false
      return
    }
    asr.load() // no-op if already loading/loaded
    await mic.start()
    isRecordingRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic, asr])

  const isBusy = mic.status === 'requesting'
  const isRecording = mic.status === 'active'
  const modelLoading = asr.status === 'loading'

  return (
    <div className="flex flex-1 flex-col items-center justify-between gap-4 overflow-y-auto px-4 py-6 text-center">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Moboflow</h1>
        <p className="mt-1 text-xs text-slate-500">Let your thoughts flow into your mobile.</p>
      </div>

      <div className="flex w-full max-w-md flex-1 flex-col gap-2 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-left text-sm leading-relaxed text-slate-200">
        {finalSegments.length === 0 && !partialText ? (
          <p className="text-slate-500">Transcript will appear here as you speak.</p>
        ) : (
          <>
            {finalSegments.map((seg, i) => (
              <p key={i}>{seg}</p>
            ))}
            {partialText && <p className="text-slate-400 italic">{partialText}…</p>}
          </>
        )}
      </div>

      {modelLoading && asr.progress && !asr.stage && (
        <div className="w-full max-w-md text-xs text-slate-400">
          <div className="mb-1 flex justify-between">
            <span>Downloading transcription model ({asr.progress.file})…</span>
            <span>{Math.round(asr.progress.overall * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-sky-500 transition-all"
              style={{ width: `${asr.progress.overall * 100}%` }}
            />
          </div>
          <p className="mt-1 text-slate-500">
            One-time ~890MB download, cached on this device for offline use afterward.
          </p>
        </div>
      )}

      {modelLoading && asr.stage && (
        <div className="w-full max-w-md text-xs text-slate-400">
          <p>{asr.stage}</p>
          <p className="mt-1 text-slate-500">
            First-time setup only — this can take a minute or two on-device, then it's cached.
          </p>
        </div>
      )}

      {asr.error && <p className="text-xs text-red-400">Transcription engine error: {asr.error}</p>}
      {mic.error && <p className="text-xs text-red-400">Microphone error: {mic.error}</p>}

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={toggleRecording}
          disabled={isBusy}
          className={`flex h-24 w-24 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed ${
            isRecording ? 'bg-red-500/90 text-white' : 'bg-sky-500 text-slate-950'
          }`}
          style={
            isRecording
              ? { boxShadow: `0 0 0 ${8 + mic.level * 16}px rgba(239,68,68,0.15)` }
              : undefined
          }
        >
          <MicIcon className="h-9 w-9" />
        </button>
        <p className="text-xs text-slate-500">
          {isBusy
            ? 'Requesting microphone…'
            : isRecording
              ? mic.isSpeaking
                ? 'Listening…'
                : 'Recording — waiting for speech'
              : modelLoading
                ? (asr.stage ?? `Downloading model — ${Math.round((asr.progress?.overall ?? 0) * 100)}%`)
                : 'Tap to start'}
        </p>
      </div>
    </div>
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
