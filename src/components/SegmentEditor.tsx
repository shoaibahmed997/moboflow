import { useLayoutEffect, useRef, useState } from 'react'
import { copyText } from '../lib/export/deliver'
import type { TranscriptPart } from '../lib/transcript/format'

interface SegmentEditorProps {
  part: TranscriptPart
  onSave: (text: string) => void
  onDelete: () => void
  onRevert: () => void
  onClose: () => void
}

/**
 * Inline editor for one transcript sentence. Saves on Enter or blur, cancels on Escape.
 * Toolbar buttons use onMouseDown + preventDefault so tapping them doesn't blur the
 * textarea first (which would commit the text before the button's own action runs).
 */
export function SegmentEditor({ part, onSave, onDelete, onRevert, onClose }: SegmentEditorProps) {
  const [text, setText] = useState(part.text)
  const [copied, setCopied] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const doneRef = useRef(false)

  const finish = (action: () => void) => {
    if (doneRef.current) return
    doneRef.current = true
    action()
    onClose()
  }

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  useLayoutEffect(() => {
    const el = textareaRef.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const toolbarButton = (label: string, action: () => void, className = 'text-slate-300') => (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => finish(action)}
      className={`rounded px-2 py-1 ${className} hover:bg-slate-800`}
    >
      {label}
    </button>
  )

  return (
    <span className="my-1 block rounded-md border border-sky-500/50 bg-slate-900 p-2">
      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        aria-label="Edit sentence"
        onChange={(event) => {
          setText(event.target.value)
          setCopied(false)
        }}
        onBlur={() => finish(() => onSave(text))}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            finish(() => {})
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            finish(() => onSave(text))
          }
        }}
        className="block w-full resize-none overflow-hidden bg-transparent text-base leading-relaxed text-slate-100 focus:outline-none"
      />
      <span className="mt-1 flex flex-wrap items-center gap-1 text-xs">
        {toolbarButton('Done', () => onSave(text), 'font-medium text-sky-400')}
        {toolbarButton('Cancel', () => {})}
        {part.segment.isEdited && toolbarButton('Revert to original', onRevert)}
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={async () => setCopied((await copyText(text.trim())) === 'done')}
          className="rounded px-2 py-1 text-slate-300 hover:bg-slate-800"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="flex-1" />
        {toolbarButton('Delete sentence', onDelete, 'text-red-400')}
      </span>
    </span>
  )
}
