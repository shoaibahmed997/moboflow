// In-memory full-text index over sessions (SPEC.md §6 Phase 6), built from IndexedDB and
// kept current incrementally: `sync()` is handed the latest session rows (from a Dexie
// live query, so it also sees other tabs' writes) and re-indexes only the sessions whose
// signature changed. Every write path in sessions.ts/library.ts bumps `updatedAt`, so
// segment edits are caught too; title/tags are in the signature for good measure.
import { Charset, Index } from 'flexsearch'
import { db, type Segment, type Session } from '../db'
import { formatTranscript } from '../transcript/format'
import { buildSnippet, createMatcher, findMatches, foldText, queryTerms, type FoldedText, type Range, type Snippet } from './snippet'

export interface SearchHit {
  sessionId: string
  titleHighlights: Range[]
  /** Tags that match a query term, so the UI can show why a tag-only hit matched. */
  matchedTags: string[]
  snippet: Snippet | null
}

type SegmentLoader = (sessionIds: string[]) => Promise<Segment[]>

const loadSegmentsFromDb: SegmentLoader = (sessionIds) => db.segments.where('sessionId').anyOf(sessionIds).toArray()

const signature = (session: Session) => `${session.updatedAt}\u0000${session.title}\u0000${session.tags.join(',')}`

/** The transcript exactly as the user reads it — formatted, fillers removed, edits applied. */
export function transcriptText(segments: Segment[]): string {
  return formatTranscript([...segments].sort((a, b) => a.startMs - b.startMs))
    .map((paragraph) => paragraph.parts.map((part) => part.text).join(' '))
    .join('\n\n')
}

const createIndex = () => new Index({ tokenize: 'forward', encoder: Charset.LatinBalance })

export class SessionSearchIndex {
  /** Title + tags only, so title hits can rank above body-only hits. */
  private headings = createIndex()
  /** Title + tags + transcript; multi-word queries must all match somewhere in here. */
  private content = createIndex()
  private signatures = new Map<string, string>()
  private titles = new Map<string, string>()
  private tags = new Map<string, string[]>()
  private bodies = new Map<string, FoldedText>()
  private queue: Promise<void> = Promise.resolve()
  private primed = false

  private readonly loadSegments: SegmentLoader

  constructor(loadSegments: SegmentLoader = loadSegmentsFromDb) {
    this.loadSegments = loadSegments
  }

  /** True once at least one sync has completed. */
  get isPrimed(): boolean {
    return this.primed
  }

  get size(): number {
    return this.signatures.size
  }

  /** Brings the index in line with `sessions` (the full current set). Calls are serialized. */
  sync(sessions: Session[]): Promise<void> {
    this.queue = this.queue.then(() => this.applySync(sessions))
    return this.queue
  }

  private async applySync(sessions: Session[]) {
    const current = new Set(sessions.map((s) => s.id))
    for (const id of [...this.signatures.keys()]) if (!current.has(id)) this.remove(id)

    const stale = sessions.filter((s) => this.signatures.get(s.id) !== signature(s))
    if (stale.length) {
      const bySession = new Map<string, Segment[]>()
      for (const segment of await this.loadSegments(stale.map((s) => s.id))) {
        const list = bySession.get(segment.sessionId)
        if (list) list.push(segment)
        else bySession.set(segment.sessionId, [segment])
      }
      for (const session of stale) {
        const body = transcriptText(bySession.get(session.id) ?? [])
        const heading = `${session.title}\n${session.tags.join(' ')}`
        this.headings.update(session.id, heading)
        this.content.update(session.id, `${heading}\n${body}`)
        this.titles.set(session.id, session.title)
        this.tags.set(session.id, session.tags)
        this.bodies.set(session.id, foldText(body))
        this.signatures.set(session.id, signature(session))
      }
    }
    this.primed = true
  }

  private remove(id: string) {
    this.headings.remove(id)
    this.content.remove(id)
    this.signatures.delete(id)
    this.titles.delete(id)
    this.tags.delete(id)
    this.bodies.delete(id)
  }

  /** Matching sessions, most relevant first (title/tag hits, then transcript-only hits). */
  search(query: string): SearchHit[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    const limit = Math.max(1, this.signatures.size)
    const matched = this.content.search(trimmed, { limit }) as string[]
    if (!matched.length) return []

    const headingHits = new Set(this.headings.search(trimmed, { limit }) as string[])
    const ordered = [...matched.filter((id) => headingHits.has(id)), ...matched.filter((id) => !headingHits.has(id))]
    const matcher = createMatcher(queryTerms(trimmed))

    return ordered.map((sessionId) => {
      const body = this.bodies.get(sessionId)
      return {
        sessionId,
        titleHighlights: findMatches(this.titles.get(sessionId) ?? '', matcher),
        matchedTags: (this.tags.get(sessionId) ?? []).filter((tag) => findMatches(tag, matcher).length > 0),
        snippet: body ? buildSnippet(body, matcher) : null,
      }
    })
  }
}

/** App-wide instance, so the index survives route changes instead of rebuilding per visit. */
export const sessionSearch = new SessionSearchIndex()
