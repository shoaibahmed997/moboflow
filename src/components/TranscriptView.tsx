import { useMemo, type ReactNode } from 'react'
import type { Segment } from '../lib/db'
import { formatDuration } from '../lib/sessions'
import { formatTranscript, type TranscriptPart } from '../lib/transcript/format'

interface TranscriptViewProps {
  segments: Segment[]
  /** The session's language — selects formatting rules. */
  language: string
  /** Interim text for the utterance in progress, appended to the last paragraph. */
  partialText?: string
  showTimestamps?: boolean
  /** Makes each sentence tappable; the part being edited is replaced by `renderEditor`. */
  editing?: {
    activeId: string | null
    onSelect: (part: TranscriptPart) => void
    renderEditor: (part: TranscriptPart) => ReactNode
  }
}

export function TranscriptView({ segments, language, partialText, showTimestamps = false, editing }: TranscriptViewProps) {
  const paragraphs = useMemo(() => formatTranscript(segments, language), [segments, language])

  return (
    <div className="flex flex-col gap-4">
      {paragraphs.map((paragraph, index) => {
        const isLast = index === paragraphs.length - 1
        return (
          <div key={paragraph.parts[0].segment.id} className="flex gap-3">
            {showTimestamps && (
              <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[11px] text-slate-600 tabular-nums">
                {formatDuration(paragraph.startMs)}
              </span>
            )}
            <p className="min-w-0 flex-1">
              {paragraph.parts.map((part, partIndex) => (
                <PartText key={part.segment.id} part={part} leadingSpace={partIndex > 0} editing={editing} />
              ))}
              {isLast && partialText && <span className="text-slate-400 italic"> {partialText}…</span>}
            </p>
          </div>
        )
      })}
      {paragraphs.length === 0 && partialText && <p className="text-slate-400 italic">{partialText}…</p>}
    </div>
  )
}

function PartText({
  part,
  leadingSpace,
  editing,
}: {
  part: TranscriptPart
  leadingSpace: boolean
  editing: TranscriptViewProps['editing']
}) {
  const space = leadingSpace ? ' ' : ''
  if (!editing) return <>{space + part.text}</>
  if (editing.activeId === part.segment.id) return <>{editing.renderEditor(part)}</>

  return (
    <>
      {space}
      <span
        role="button"
        tabIndex={0}
        onClick={() => editing.onSelect(part)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            editing.onSelect(part)
          }
        }}
        className="cursor-text rounded-sm hover:bg-slate-800/70 focus-visible:bg-slate-800 focus-visible:outline-none"
      >
        {part.text}
      </span>
    </>
  )
}
