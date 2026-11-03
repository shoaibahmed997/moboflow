import { useEffect, useId, useRef, useState } from 'react'
import type { Segment, Session } from '../lib/db'
import {
  canShare,
  canShareFiles,
  copyText,
  downloadText,
  shareFile,
  shareText,
  type DeliveryOutcome,
} from '../lib/export/deliver'
import { exportFilename, toMarkdown, toPlainText } from '../lib/export/formats'

interface ExportMenuProps {
  session: Session
  segments: Segment[]
  folderName?: string
}

const FEEDBACK: Record<Exclude<DeliveryOutcome, 'cancelled'>, string> = {
  done: '',
  unsupported: 'Sharing isn’t supported in this browser.',
  failed: 'That didn’t work — try again.',
}

/** Copy / download / share actions for a whole transcript. */
export function ExportMenu({ session, segments, folderName }: ExportMenuProps) {
  const [open, setOpen] = useState(false)
  const [timestamps, setTimestamps] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const empty = segments.length === 0

  // Close on outside tap or Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 2500)
    return () => clearTimeout(timer)
  }, [status])

  const options = { timestamps, folderName }
  const plain = () => toPlainText(session, segments, options)
  const markdown = () => toMarkdown(session, segments, options)

  const run = async (action: () => DeliveryOutcome | Promise<DeliveryOutcome>, success: string) => {
    const outcome = await action()
    if (outcome === 'cancelled') return
    setStatus(outcome === 'done' ? success : FEEDBACK[outcome])
    if (outcome === 'done') setOpen(false)
  }

  const item = (label: string, onClick: () => void, hint?: string) => (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-baseline justify-between gap-4 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
    >
      {label}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </button>
  )

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => void run(() => copyText(plain()), 'Transcript copied')}
        disabled={empty}
        className="rounded-md border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-700 disabled:opacity-40"
      >
        Copy
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={empty}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="rounded-md border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-700 disabled:opacity-40"
      >
        Export ▾
      </button>
      <span role="status" aria-live="polite" className="text-xs text-slate-400">
        {status}
      </span>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute top-full left-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl"
        >
          {item('Copy as Markdown', () => void run(() => copyText(markdown()), 'Markdown copied'))}
          {item('Download .md', () => void run(() => downloadText(markdown(), exportFilename(session, 'md')), 'Downloaded'), 'notes apps')}
          {item('Download .txt', () => void run(() => downloadText(plain(), exportFilename(session, 'txt')), 'Downloaded'), 'plain text')}
          {canShare() && (
            <>
              <div className="my-1 border-t border-slate-800" />
              {item('Share…', () => void run(() => shareText(session.title, plain()), 'Shared'), 'as text')}
              {canShareFiles() &&
                item(
                  'Share .md file…',
                  () => void run(() => shareFile(session.title, markdown(), exportFilename(session, 'md')), 'Shared'),
                )}
            </>
          )}
          <div className="my-1 border-t border-slate-800" />
          <label className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={timestamps}
              onChange={(event) => setTimestamps(event.target.checked)}
              className="accent-sky-500"
            />
            Include paragraph timestamps
          </label>
        </div>
      )}
    </div>
  )
}
