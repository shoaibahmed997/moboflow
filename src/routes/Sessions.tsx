import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { SessionStatusBadge } from '../components/SessionStatusBadge'
import { db } from '../lib/db'
import { formatDuration } from '../lib/sessions'

export function Sessions() {
  const sessions = useLiveQuery(() => db.sessions.orderBy('updatedAt').reverse().toArray(), [])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <h1 className="mb-4 text-lg font-semibold text-slate-100">Sessions</h1>

      {sessions === undefined ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-slate-500">
          No transcripts yet.{' '}
          <Link to="/" className="text-sky-400">
            Record your first one
          </Link>{' '}
          — everything stays on this device.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                to={`/sessions/${session.id}`}
                className="block rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 hover:border-slate-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium text-slate-200">{session.title}</p>
                  <SessionStatusBadge status={session.status} />
                </div>
                <p className="text-xs text-slate-500">
                  {new Date(session.updatedAt).toLocaleString()} · {formatDuration(session.durationMs)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
