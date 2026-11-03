import { useLiveQuery } from 'dexie-react-hooks'
import { useDeferredValue, useMemo, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FolderBar, UNFILED, type FolderFilter } from '../components/FolderBar'
import { Highlighted } from '../components/Highlighted'
import { SessionStatusBadge } from '../components/SessionStatusBadge'
import { db, type Session } from '../lib/db'
import type { SearchHit } from '../lib/search/sessionSearch'
import { useSessionSearch } from '../lib/search/useSessionSearch'
import { formatDuration } from '../lib/sessions'

type SortKey = 'relevance' | 'newest' | 'oldest' | 'updated'

const SORT_LABELS: Record<SortKey, string> = {
  relevance: 'Best match',
  newest: 'Newest first',
  oldest: 'Oldest first',
  updated: 'Recently updated',
}

const comparators: Record<Exclude<SortKey, 'relevance'>, (a: Session, b: Session) => number> = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  updated: (a, b) => b.updatedAt - a.updatedAt,
}

export function Sessions() {
  // Filters live in the URL so Back from a session returns to the same view.
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const folderParam = params.get('folder')
  const tag = params.get('tag')
  const language = params.get('lang')
  const requestedSort = params.get('sort') as SortKey | null
  const sort: SortKey =
    requestedSort && requestedSort in SORT_LABELS && (requestedSort !== 'relevance' || query)
      ? requestedSort
      : query
        ? 'relevance'
        : 'newest'

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )

  const sessions = useLiveQuery(() => db.sessions.toArray(), [])
  const folders = useLiveQuery(
    async () => (await db.folders.toArray()).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  )

  // A stale folder id (folder deleted, e.g. in another tab) falls back to All.
  const folder: FolderFilter =
    folderParam === UNFILED || folders?.some((f) => f.id === folderParam) ? folderParam : null

  const deferredQuery = useDeferredValue(query)
  const { ready, hits } = useSessionSearch(sessions, deferredQuery)

  const facets = useMemo(() => {
    const byFolder = new Map<string, number>()
    const tags = new Map<string, number>()
    const languages = new Set<string>()
    let unfiled = 0
    for (const session of sessions ?? []) {
      if (session.folderId) byFolder.set(session.folderId, (byFolder.get(session.folderId) ?? 0) + 1)
      else unfiled++
      for (const t of session.tags) tags.set(t, (tags.get(t) ?? 0) + 1)
      languages.add(session.language)
    }
    return {
      counts: { all: sessions?.length ?? 0, unfiled, byFolder },
      tags: [...tags].sort(([a], [b]) => a.localeCompare(b)),
      languages: [...languages].sort(),
    }
  }, [sessions])

  const results = useMemo(() => {
    if (!sessions) return undefined
    const hitById = hits ? new Map(hits.map((hit, rank) => [hit.sessionId, { hit, rank }])) : null
    const matches = sessions.filter(
      (session) =>
        (!hitById || hitById.has(session.id)) &&
        (folder === null || (folder === UNFILED ? !session.folderId : session.folderId === folder)) &&
        (!tag || session.tags.includes(tag)) &&
        (!language || session.language === language),
    )
    if (sort === 'relevance' && hitById) matches.sort((a, b) => hitById.get(a.id)!.rank - hitById.get(b.id)!.rank)
    else if (sort !== 'relevance') matches.sort(comparators[sort])
    return matches.map((session) => ({ session, hit: hitById?.get(session.id)?.hit ?? null }))
  }, [sessions, hits, folder, tag, language, sort])

  const folderNames = useMemo(() => new Map(folders?.map((f) => [f.id, f.name])), [folders])
  const hasFilters = !!(query || folder || tag || language)
  const searching = !!query.trim() && !ready

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <h1 className="mb-4 text-lg font-semibold text-slate-100">Sessions</h1>

      <div className="relative mb-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setParam('q', event.target.value || null)}
          placeholder="Search transcripts, titles, tags…"
          aria-label="Search sessions"
          className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pr-3 pl-9 text-base text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none sm:text-sm"
        />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
      </div>

      {folders && (
        <FolderBar folders={folders} counts={facets.counts} active={folder} onChange={(f) => setParam('folder', f)} />
      )}

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {facets.tags.length > 0 && (
          <FilterSelect label="Tag" value={tag ?? ''} onChange={(v) => setParam('tag', v || null)}>
            <option value="">All tags</option>
            {facets.tags.map(([name, count]) => (
              <option key={name} value={name}>
                #{name} ({count})
              </option>
            ))}
          </FilterSelect>
        )}
        {facets.languages.length > 1 && (
          <FilterSelect label="Language" value={language ?? ''} onChange={(v) => setParam('lang', v || null)}>
            <option value="">All languages</option>
            {facets.languages.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </FilterSelect>
        )}
        <FilterSelect label="Sort" value={sort} onChange={(v) => setParam('sort', v)}>
          {(Object.keys(SORT_LABELS) as SortKey[])
            .filter((key) => key !== 'relevance' || query)
            .map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
        </FilterSelect>
        {hasFilters && (
          <button type="button" onClick={() => setParams({}, { replace: true })} className="px-1 text-sky-400">
            Clear
          </button>
        )}
      </div>

      {results === undefined ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : facets.counts.all === 0 ? (
        <p className="text-sm text-slate-500">
          No transcripts yet.{' '}
          <Link to="/" className="text-sky-400">
            Record your first one
          </Link>{' '}
          — everything stays on this device.
        </p>
      ) : searching ? (
        <p className="text-sm text-slate-500">Building search index…</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-slate-500">No sessions match{query.trim() ? ` “${query.trim()}”` : ''}.</p>
      ) : (
        <>
          {hasFilters && (
            <p className="mb-2 text-xs text-slate-500" aria-live="polite">
              {results.length} {results.length === 1 ? 'session' : 'sessions'}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {results.map(({ session, hit }) => (
              <SessionRow
                key={session.id}
                session={session}
                hit={hit}
                listSearch={params.toString()}
                folderName={folder === null && session.folderId ? folderNames.get(session.folderId) : undefined}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface SessionRowProps {
  session: Session
  hit: SearchHit | null
  /** The list's query string, so the detail page's back link returns to this exact view. */
  listSearch: string
  folderName?: string
}

function SessionRow({ session, hit, listSearch, folderName }: SessionRowProps) {
  const snippet = hit?.snippet
  return (
    <li>
      <Link
        to={`/sessions/${session.id}`}
        state={{ listSearch }}
        className="block rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 hover:border-slate-700"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-medium text-slate-200">
            <Highlighted text={session.title} ranges={hit?.titleHighlights ?? []} />
          </p>
          <SessionStatusBadge status={session.status} />
        </div>
        <p className="truncate text-xs text-slate-500">
          {new Date(session.createdAt).toLocaleString()} · {formatDuration(session.durationMs)}
          {folderName && ` · ${folderName}`}
        </p>
        {snippet && (
          <p className="mt-1.5 line-clamp-2 text-sm text-slate-400">
            {snippet.truncatedStart && '…'}
            <Highlighted text={snippet.text} ranges={snippet.highlights} />
            {snippet.truncatedEnd && '…'}
          </p>
        )}
        {session.tags.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {session.tags.map((t) => (
              <span
                key={t}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  hit?.matchedTags.includes(t) ? 'bg-sky-400/25 text-sky-100' : 'bg-slate-800 text-slate-400'
                }`}
              >
                #{t}
              </span>
            ))}
          </p>
        )}
      </Link>
    </li>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-slate-400">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-transparent text-slate-300 focus:outline-none"
      >
        {children}
      </select>
    </label>
  )
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  )
}
