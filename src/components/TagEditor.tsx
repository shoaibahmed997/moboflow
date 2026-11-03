import { useId, useState } from 'react'
import { MAX_TAG_LENGTH, normalizeTag, normalizeTags } from '../lib/library'

interface TagEditorProps {
  tags: string[]
  /** Existing tags across the library, offered as autocomplete. */
  suggestions: string[]
  onChange: (tags: string[]) => void
}

/** Chip-style tag input: Enter or comma adds, Backspace on an empty field removes the last tag. */
export function TagEditor({ tags, suggestions, onChange }: TagEditorProps) {
  const [draft, setDraft] = useState('')
  const listId = useId()

  const commit = (raw = draft) => {
    const tag = normalizeTag(raw)
    setDraft('')
    if (tag && !tags.includes(tag)) onChange(normalizeTags([...tags, tag]))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 rounded bg-slate-800 py-0.5 pr-1 pl-2 text-xs text-slate-300">
          #{tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
            className="rounded px-1 text-slate-500 hover:text-slate-200"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        list={listId}
        maxLength={MAX_TAG_LENGTH + 1}
        onChange={(event) => {
          const value = event.target.value
          if (value.endsWith(',')) commit(value.slice(0, -1))
          else setDraft(value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            commit()
          } else if (event.key === 'Backspace' && !draft && tags.length) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={() => commit()}
        placeholder={tags.length ? 'Add tag' : 'Add tags…'}
        aria-label="Add tag"
        className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-base text-slate-200 placeholder:text-slate-600 focus:outline-none sm:text-xs"
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !tags.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  )
}
