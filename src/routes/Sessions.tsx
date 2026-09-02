import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '../lib/db'

export function Sessions() {
  const sessions = useLiveQuery(() => db.sessions.orderBy('updatedAt').reverse().toArray(), [])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <h1 className="mb-4 text-lg font-semibold text-slate-100">Sessions</h1>

      {sessions === undefined ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-slate-500">
          No transcripts yet. Recording &amp; saving arrives in Phase 4 — for now this list
          reads live from IndexedDB and will populate automatically once sessions are written.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                to={`/sessions/${session.id}`}
                className="block rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 hover:border-slate-700"
              >
                <p className="font-medium text-slate-200">{session.title}</p>
                <p className="text-xs text-slate-500">
                  {new Date(session.updatedAt).toLocaleString()} · {session.status}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
