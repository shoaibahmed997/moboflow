import { useLiveQuery } from 'dexie-react-hooks'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { SessionStatusBadge } from '../components/SessionStatusBadge'
import { db, type Session } from '../lib/db'
import { useRecorder } from '../lib/recorder/RecorderContext'
import { completeSession, deleteSession, formatDuration, getSessionSegments, renameSession } from '../lib/sessions'

export function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const recorder = useRecorder()

  const session = useLiveQuery(async () => (await db.sessions.get(sessionId!)) ?? null, [sessionId])
  const segments = useLiveQuery(() => getSessionSegments(sessionId!), [sessionId])

  if (session === undefined) {
    return <p className="flex-1 px-4 py-6 text-sm text-slate-500">Loading…</p>
  }

  if (session === null) {
    return (
      <div className="flex-1 px-4 py-6">
        <p className="text-sm text-slate-500">Session not found.</p>
        <Link to="/sessions" className="mt-2 inline-block text-sm text-sky-400">
          Back to sessions
        </Link>
      </div>
    )
  }

  const isLiveHere = recorder.sessionId === session.id
  // 'recording' but not ours: another tab owns it (or it's about to be recovered as a draft).
  const isLiveElsewhere = session.status === 'recording' && !isLiveHere

  const onDelete = async () => {
    if (!window.confirm(`Delete “${session.title}”? This can't be undone.`)) return
    await deleteSession(session.id)
    navigate('/sessions', { replace: true })
  }

  const onResume = async () => {
    navigate('/')
    await recorder.resume(session.id)
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <Link to="/sessions" className="text-sm text-sky-400">
        ← Sessions
      </Link>

      <SessionTitle key={session.id} session={session} />
      <p className="mb-4 flex items-center gap-2 text-xs text-slate-500">
        <span>
          {new Date(session.createdAt).toLocaleString()} · {formatDuration(session.durationMs)} · {session.language}
        </span>
        <SessionStatusBadge status={session.status} />
      </p>

      {isLiveHere && (
        <Notice>
          This session is being recorded.{' '}
          <Link to="/" className="text-sky-400">
            Go to recorder
          </Link>
        </Notice>
      )}
      {isLiveElsewhere && <Notice>This session is being recorded in another tab.</Notice>}
      {session.status === 'draft' && (
        <Notice tone="warning">
          This recording was interrupted before it was stopped. Everything up to the last
          finished sentence was saved.
          <span className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onResume}
              disabled={recorder.state !== 'idle'}
              className="rounded bg-amber-400 px-3 py-1 text-xs font-medium text-slate-950 disabled:opacity-50"
            >
              Resume recording
            </button>
            <button
              type="button"
              onClick={() => void completeSession(session.id)}
              className="rounded px-3 py-1 text-xs text-amber-200"
            >
              Save as is
            </button>
          </span>
        </Notice>
      )}

      <ol className="flex flex-col gap-3 text-sm leading-relaxed text-slate-300">
        {segments?.length ? (
          segments.map((segment) => (
            <li key={segment.id} className="flex gap-3">
              <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[11px] text-slate-600 tabular-nums">
                {formatDuration(segment.startMs)}
              </span>
              <p>{segment.text}</p>
            </li>
          ))
        ) : (
          <li className="text-slate-500">No transcript segments yet.</li>
        )}
      </ol>

      <div className="mt-8 border-t border-slate-800 pt-4">
        <button
          type="button"
          onClick={onDelete}
          disabled={isLiveHere || isLiveElsewhere}
          title={isLiveHere || isLiveElsewhere ? 'Stop the recording before deleting it' : undefined}
          className="text-sm text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete session
        </button>
      </div>
    </div>
  )
}

function SessionTitle({ session }: { session: Session }) {
  const [draft, setDraft] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (draft !== null) await renameSession(session.id, draft)
    setDraft(null)
  }

  if (draft === null) {
    return (
      <div className="mt-2 mb-1 flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-semibold break-words text-slate-100">{session.title}</h1>
        <button
          type="button"
          onClick={() => setDraft(session.title)}
          className="shrink-0 pt-1 text-xs text-sky-400"
        >
          Rename
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 mb-1 flex gap-2">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setDraft(null)}
        aria-label="Session title"
        maxLength={120}
        className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-base text-slate-100 focus:border-sky-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!draft.trim()}
        className="rounded bg-sky-500 px-3 text-sm font-medium text-slate-950 disabled:opacity-50"
      >
        Save
      </button>
      <button type="button" onClick={() => setDraft(null)} className="px-1 text-sm text-slate-400">
        Cancel
      </button>
    </form>
  )
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }) {
  const className =
    tone === 'warning'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
      : 'border-slate-800 bg-slate-900 text-slate-300'
  return <div className={`mb-4 flex flex-col rounded-lg border px-4 py-3 text-sm ${className}`}>{children}</div>
}
