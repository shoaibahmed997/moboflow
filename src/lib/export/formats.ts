// Transcript → .txt / .md (SPEC.md §6 Phase 7). Pure and DOM-free so it's unit-testable
// and reusable (e.g. a future bulk export). Uses the same formatted paragraphs the app
// displays, so what you export is what you read.
import type { Segment, Session } from '../db'
import { formatDuration } from '../sessions'
import { formatTranscript, paragraphText } from '../transcript/format'

export interface ExportOptions {
  /** Prefix each paragraph with its offset into the recording, e.g. [1:05]. */
  timestamps?: boolean
  /** Folder name for the metadata line, if the session is filed. */
  folderName?: string
}

function paragraphs(segments: Segment[]) {
  return formatTranscript([...segments].sort((a, b) => a.startMs - b.startMs))
}

function recordedLine(session: Session): string {
  const date = new Date(session.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `Recorded ${date} · ${formatDuration(session.durationMs)}`
}

export function toPlainText(session: Session, segments: Segment[], options: ExportOptions = {}): string {
  const meta = [recordedLine(session), options.folderName && `Folder: ${options.folderName}`]
  if (session.tags.length) meta.push(`Tags: ${session.tags.join(', ')}`)
  const body = paragraphs(segments).map(
    (p) => (options.timestamps ? `[${formatDuration(p.startMs)}] ` : '') + paragraphText(p),
  )
  return [session.title, meta.filter(Boolean).join('\n'), ...body].join('\n\n') + '\n'
}

/**
 * Escapes only what would actually change how CommonMark renders transcript prose:
 * block markers at the start of a paragraph (#, >, -, +, *, "1.") and inline markup
 * characters. Underscores inside words (snake_case) are left alone since they never
 * trigger emphasis — keeping the file readable in notes apps that show it unrendered.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*[\]<>|~])/g, '\\$1')
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (match) => match.replace('_', '\\_'))
    .replace(/^(\s*)([#>+-])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
}

/** `#tag` form understood by Obsidian/Bear/Logseq: no spaces, limited punctuation. */
export function markdownTag(tag: string): string {
  return '#' + tag.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '')
}

export function toMarkdown(session: Session, segments: Segment[], options: ExportOptions = {}): string {
  const title = escapeMarkdown(session.title.replace(/\s+/g, ' ').trim()) || 'Transcript'
  const meta = [recordedLine(session), options.folderName && `Folder: ${escapeMarkdown(options.folderName)}`]
    .filter(Boolean)
    .join(' · ')
  const lines = [`# ${title}`, `*${meta}*`]
  const tags = session.tags.map(markdownTag).filter((t) => t.length > 1)
  if (tags.length) lines.push(tags.join(' '))

  for (const p of paragraphs(segments)) {
    const stamp = options.timestamps ? `**[${formatDuration(p.startMs)}]** ` : ''
    lines.push(stamp + escapeMarkdown(paragraphText(p)))
  }
  return lines.join('\n\n') + '\n'
}

/**
 * A filename safe on every major OS: drops path separators/reserved characters and
 * control chars, keeps letters in any script, appends the recording date so exports
 * of identically-titled sessions don't collide.
 */
export function exportFilename(session: Session, extension: 'txt' | 'md'): string {
  const d = new Date(session.createdAt)
  const date = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
  const base = session.title
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim()
  return `${base || 'Transcript'} ${date}.${extension}`
}
