import type { Range } from '../lib/search/snippet'

/** Renders `text` with `ranges` wrapped in <mark>. Ranges must be sorted and non-overlapping. */
export function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
  if (!ranges.length) return <>{text}</>
  const pieces = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    if (start > cursor) pieces.push(text.slice(cursor, start))
    pieces.push(
      <mark key={start} className="rounded-sm bg-sky-400/25 px-0.5 text-sky-100">
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  }
  if (cursor < text.length) pieces.push(text.slice(cursor))
  return <>{pieces}</>
}
