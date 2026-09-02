export function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">Moboflow</h1>
        <p className="mt-1 text-sm text-slate-400">Let your thoughts flow into your mobile.</p>
      </div>

      <button
        type="button"
        disabled
        title="Transcription engine arrives in Phase 3"
        className="flex h-24 w-24 items-center justify-center rounded-full bg-slate-800 text-slate-500 disabled:cursor-not-allowed"
      >
        <MicIcon className="h-9 w-9" />
      </button>

      <p className="max-w-xs text-xs text-slate-500">
        Recording and live transcription aren&apos;t wired up yet — this is the Phase 1 app
        shell. The mic pipeline lands in Phase 2, on-device transcription in Phase 3.
      </p>
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
