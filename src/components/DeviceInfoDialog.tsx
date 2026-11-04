import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { MODELS, modelSize, type ModelSpec } from '../lib/asr/models'
import { canLoadOffline, removeCachedModel } from '../lib/asr/modelStorage'
import { useRecorder } from '../lib/recorder/RecorderContext'
import { useOnline } from '../lib/useOnline'

interface StorageInfo {
  usage?: number
  quota?: number
  persisted: boolean | null
  models: { spec: ModelSpec; offline: boolean }[]
}

const mb = (bytes?: number) => (bytes === undefined ? '?' : `${Math.round(bytes / 1e6).toLocaleString()} MB`)

async function readStorage(): Promise<StorageInfo> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
  const persisted = (await navigator.storage?.persisted?.().catch(() => null)) ?? null
  const models = await Promise.all(
    Object.values(MODELS).map(async (spec) => ({ spec, offline: await canLoadOffline(spec).catch(() => false) })),
  )
  return { usage: estimate?.usage, quota: estimate?.quota, persisted, models }
}

/**
 * "Device & storage": what's stored, whether it's protected from eviction, whether the
 * app can transcribe offline, and which compute backend the engine actually uses —
 * the information a user needs when storage runs out or something behaves differently
 * on their browser (see docs/browser-support.md).
 */
export function DeviceInfoButton() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => {
          dialogRef.current?.showModal()
          setOpen(true)
        }}
        aria-label="Device & storage"
        className="rounded-full p-2 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
      >
        <InfoIcon className="h-5 w-5" />
      </button>
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        aria-labelledby="device-info-title"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-900 p-0 text-left text-sm text-slate-300 backdrop:bg-black/60"
      >
        {open && <DeviceInfo onClose={() => dialogRef.current?.close()} />}
      </dialog>
    </>
  )
}

function DeviceInfo({ onClose }: { onClose: () => void }) {
  const recorder = useRecorder()
  const online = useOnline()
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(() => void readStorage().then(setInfo), [])
  useEffect(refresh, [refresh])

  const requestPersistence = async () => {
    const granted = await navigator.storage?.persist?.().catch(() => false)
    setMessage(
      granted
        ? 'Your recordings and the model are now protected from automatic cleanup.'
        : 'The browser declined. Installing Moboflow (Add to Home Screen) usually makes it allow this.',
    )
    refresh()
  }

  const engineBusy = recorder.state !== 'idle' || recorder.engine.status === 'loading'
  const removeModel = async (spec: ModelSpec) => {
    if (!window.confirm(`Remove the downloaded ${spec.label} model? It will download again (~${mb(modelSize(spec))}) the next time you record.`)) return
    await removeCachedModel(spec)
    setMessage('Model removed. Recording will download it again when needed.')
    refresh()
  }

  const backend = recorder.engine.backend
  const hasWebGpu = 'gpu' in navigator
  const usedPct = info?.usage !== undefined && info.quota ? Math.min(100, (info.usage / info.quota) * 100) : null

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 id="device-info-title" className="font-semibold text-slate-100">
          Device &amp; storage
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 text-lg text-slate-400 hover:text-slate-100">
          ×
        </button>
      </div>

      <div className="flex flex-col gap-4 overflow-y-auto px-4 py-3">
        <Section title="Storage">
          {info === null ? (
            <p className="text-slate-500">Checking…</p>
          ) : (
            <>
              <Row label="Used">
                {mb(info.usage)} of {mb(info.quota)} available to this app
              </Row>
              {usedPct !== null && (
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800" aria-hidden>
                  <div
                    className={`h-full rounded-full ${usedPct > 90 ? 'bg-red-500' : 'bg-sky-500'}`}
                    style={{ width: `${Math.max(usedPct, 1)}%` }}
                  />
                </div>
              )}
              <Row label="Protected">
                {info.persisted === null ? (
                  'Not supported by this browser'
                ) : info.persisted ? (
                  'Yes — the browser won’t clear it automatically'
                ) : (
                  <span>
                    No — the browser may clear it when space runs low.{' '}
                    <button type="button" onClick={requestPersistence} className="text-sky-400 underline">
                      Protect my data
                    </button>
                  </span>
                )}
              </Row>
              {info.models.map(({ spec, offline }) => (
                <Row key={spec.id} label="Model">
                  <span className="block">{spec.label}</span>
                  <span className="block text-slate-500">
                    {offline ? `Downloaded (~${mb(modelSize(spec))}) — works offline` : 'Not downloaded — downloads when you first record'}
                  </span>
                  {offline && (
                    <button
                      type="button"
                      onClick={() => void removeModel(spec)}
                      disabled={engineBusy}
                      title={engineBusy ? 'Stop recording first' : undefined}
                      className="mt-1 text-red-400 underline disabled:opacity-40"
                    >
                      Remove downloaded model
                    </button>
                  )}
                </Row>
              ))}
            </>
          )}
        </Section>

        <Section title="Transcription engine">
          <Row label="Status">
            {recorder.engine.status === 'ready'
              ? 'Loaded'
              : recorder.engine.status === 'loading'
                ? 'Loading…'
                : recorder.engine.status === 'error'
                  ? 'Failed to load'
                  : 'Not loaded yet (starts with your first recording)'}
          </Row>
          <Row label="Runs on">
            {backend === 'webgpu'
              ? 'GPU (WebGPU)'
              : backend === 'wasm'
                ? 'CPU (WebAssembly)'
                : hasWebGpu
                  ? 'GPU if available (WebGPU detected)'
                  : 'CPU (WebAssembly) — no WebGPU in this browser'}
          </Row>
          <Row label="Connection">{online ? 'Online' : 'Offline'}</Row>
        </Section>

        <p className="text-xs text-slate-500">
          Everything stays on this device: audio is never uploaded, and transcripts live in this browser’s storage.
        </p>
        {message && (
          <p role="status" className="rounded-md bg-slate-800 px-3 py-2 text-xs text-slate-200">
            {message}
          </p>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-20 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-slate-300">{children}</span>
    </div>
  )
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
    </svg>
  )
}
