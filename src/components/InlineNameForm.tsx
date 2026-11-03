import { useState, type FormEvent } from 'react'

interface InlineNameFormProps {
  initialValue?: string
  placeholder: string
  label: string
  submitLabel?: string
  maxLength?: number
  onSubmit: (value: string) => void | Promise<void>
  onCancel: () => void
}

/** Small single-field form for naming things (new folder, rename folder). Esc cancels. */
export function InlineNameForm({
  initialValue = '',
  placeholder,
  label,
  submitLabel = 'Save',
  maxLength,
  onSubmit,
  onCancel,
}: InlineNameFormProps) {
  const [value, setValue] = useState(initialValue)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!value.trim()) return
    await onSubmit(value)
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 gap-2">
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        placeholder={placeholder}
        aria-label={label}
        maxLength={maxLength}
        className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-base text-slate-100 focus:border-sky-500 focus:outline-none sm:text-sm"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="rounded bg-sky-500 px-3 text-sm font-medium text-slate-950 disabled:opacity-50"
      >
        {submitLabel}
      </button>
      <button type="button" onClick={onCancel} className="px-1 text-sm text-slate-400">
        Cancel
      </button>
    </form>
  )
}
