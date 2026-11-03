import { useEffect, useMemo, useState } from 'react'
import type { Session } from '../db'
import { sessionSearch, type SearchHit } from './sessionSearch'

/**
 * Keeps the shared search index synced to `sessions` (pass the live-query result) and
 * returns hits for `query` — null when there's no query, or the index isn't built yet.
 */
export function useSessionSearch(sessions: Session[] | undefined, query: string) {
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState(sessionSearch.isPrimed)

  useEffect(() => {
    if (!sessions) return
    let cancelled = false
    sessionSearch
      .sync(sessions)
      .then(() => {
        if (cancelled) return
        setReady(true)
        setRevision((n) => n + 1)
      })
      .catch((err) => console.warn('[search] index sync failed', err))
    return () => {
      cancelled = true
    }
  }, [sessions])

  const hits = useMemo<SearchHit[] | null>(
    () => (ready && query.trim() ? sessionSearch.search(query) : null),
    // revision: re-run when the index content changes, not just the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, query, revision],
  )

  return { ready, hits }
}
