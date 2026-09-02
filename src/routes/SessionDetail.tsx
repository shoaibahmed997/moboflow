import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router-dom'
import { db } from '../lib/db'

export function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>()

  const session = useLiveQuery(() => db.sessions.get(sessionId!), [sessionId])
  const segments = useLiveQuery(
    () => db.segments.where('sessionId').equals(sessionId!).sortBy('startMs'),
    [sessionId],
  )

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

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <Link to="/sessions" className="text-sm text-sky-400">
        ← Sessions
      </Link>
      <h1 className="mt-2 mb-1 text-lg font-semibold text-slate-100">{session.title}</h1>
      <p className="mb-4 text-xs text-slate-500">
        {new Date(session.createdAt).toLocaleString()} · {session.language}
      </p>

      <div className="flex flex-col gap-2 text-sm leading-relaxed text-slate-300">
        {segments?.length ? (
          segments.map((segment) => <p key={segment.id}>{segment.text}</p>)
        ) : (
          <p className="text-slate-500">No transcript segments yet.</p>
        )}
      </div>
    </div>
  )
}
