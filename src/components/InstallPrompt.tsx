import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault()
      setDeferredPrompt(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (!deferredPrompt || dismissed) return null

  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2 text-sm">
      <span className="text-slate-300">Install Moboflow for offline access.</span>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={async () => {
            await deferredPrompt.prompt()
            await deferredPrompt.userChoice
            setDeferredPrompt(null)
          }}
          className="rounded bg-sky-500 px-3 py-1 font-medium text-slate-950"
        >
          Install
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded px-3 py-1 text-slate-400"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
