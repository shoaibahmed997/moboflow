// Snippet extraction + match highlighting for search results. Done by hand rather than
// with FlexSearch's highlighter so results render as React elements (no innerHTML) and
// matching mirrors the index: case- and accent-insensitive, prefix-of-word.

/** Half-open [start, end) character range into the original text. */
export type Range = [number, number]

export interface Snippet {
  text: string
  highlights: Range[]
  truncatedStart: boolean
  truncatedEnd: boolean
}

/**
 * Text lowercased with diacritics stripped, plus a map from each folded char back to its
 * index in the original. Precomputed once per transcript at index time (see
 * sessionSearch.ts) — folding every hit's full transcript per keystroke was the hot path.
 */
export interface FoldedText {
  text: string
  folded: string
  sourceIndex: Uint32Array
}

export function foldText(text: string): FoldedText {
  let folded = ''
  const indices: number[] = []
  for (let i = 0; i < text.length; i++) {
    const piece = text[i].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (const ch of piece) {
      folded += ch
      indices.push(i)
    }
  }
  indices.push(text.length)
  return { text, folded, sourceIndex: Uint32Array.from(indices) }
}

export function queryTerms(query: string): string[] {
  const { folded } = foldText(query)
  return [...new Set(folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean))]
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches any word starting with one of `terms`; build once per query and reuse across hits. */
export function createMatcher(terms: string[]): RegExp | null {
  if (!terms.length) return null
  // Longest first so "road" + "roadmap" highlights the whole "roadmap".
  const alternatives = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})`, 'gu')
}

type Source = string | FoldedText
type Terms = string[] | RegExp | null

const asFolded = (source: Source) => (typeof source === 'string' ? foldText(source) : source)
const asMatcher = (terms: Terms) => (Array.isArray(terms) ? createMatcher(terms) : terms)

/** Ranges of every word in `source` that starts with one of the terms, in order. */
export function findMatches(source: Source, terms: Terms): Range[] {
  const matcher = asMatcher(terms)
  if (!matcher) return []
  const { folded, sourceIndex } = asFolded(source)
  const ranges: Range[] = []
  for (const match of folded.matchAll(matcher)) {
    const start = match.index
    ranges.push([sourceIndex[start], sourceIndex[start + match[0].length]])
  }
  return ranges
}

/**
 * A window of roughly `radius` characters either side of the first match, snapped to
 * word boundaries. Null when nothing in `text` matches (e.g. the hit was on the title,
 * or a stemmed/phonetic index match that isn't a literal prefix).
 */
export function buildSnippet(source: Source, terms: Terms, radius = 70): Snippet | null {
  const folded = asFolded(source)
  const matches = findMatches(folded, terms)
  if (!matches.length) return null
  const { text } = folded

  const [firstStart] = matches[0]
  let start = Math.max(0, firstStart - radius)
  let end = Math.min(text.length, firstStart + radius * 2)
  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space !== -1 && space < firstStart) start = space + 1
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > firstStart) end = space
  }

  return {
    text: text.slice(start, end).replace(/\s+/g, ' '),
    highlights: matches
      .filter(([s, e]) => s >= start && e <= end)
      .map(([s, e]) => [s - start, e - start] as Range),
    truncatedStart: start > 0,
    truncatedEnd: end < text.length,
  }
}
