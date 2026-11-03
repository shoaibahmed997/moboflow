import type { Session } from '../lib/db'

const styles: Record<Session['status'], { label: string; className: string } | null> = {
  complete: null,
  recording: { label: 'Recording', className: 'bg-red-500/15 text-red-300' },
  draft: { label: 'Interrupted', className: 'bg-amber-500/15 text-amber-300' },
}

export function SessionStatusBadge({ status }: { status: Session['status'] }) {
  const style = styles[status]
  if (!style) return null
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style.className}`}>
      {style.label}
    </span>
  )
}
