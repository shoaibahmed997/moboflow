import { useState } from 'react'
import type { Folder } from '../lib/db'
import { createFolder, deleteFolder, MAX_FOLDER_NAME_LENGTH, renameFolder } from '../lib/library'
import { InlineNameForm } from './InlineNameForm'

/** null = all sessions; 'unfiled' = sessions without a folder; otherwise a folder id. */
export type FolderFilter = string | null
export const UNFILED = 'unfiled'

interface FolderBarProps {
  folders: Folder[]
  counts: { all: number; unfiled: number; byFolder: Map<string, number> }
  active: FolderFilter
  onChange: (filter: FolderFilter) => void
}

export function FolderBar({ folders, counts, active, onChange }: FolderBarProps) {
  const [mode, setMode] = useState<'idle' | 'creating' | 'renaming'>('idle')
  const activeFolder = folders.find((folder) => folder.id === active)

  const chip = (key: string, label: string, count: number, filter: FolderFilter) => {
    const selected = active === filter
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange(filter)}
        aria-pressed={selected}
        className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
          selected
            ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
            : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700'
        }`}
      >
        <span className="max-w-[10rem] truncate">{label}</span>
        <span className="text-slate-500 tabular-nums">{count}</span>
      </button>
    )
  }

  return (
    <div className="mb-3">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Folders">
        {chip('all', 'All', counts.all, null)}
        {folders.length > 0 && chip(UNFILED, 'Unfiled', counts.unfiled, UNFILED)}
        {folders.map((folder) => chip(folder.id, folder.name, counts.byFolder.get(folder.id) ?? 0, folder.id))}
        <button
          type="button"
          onClick={() => setMode('creating')}
          className="shrink-0 rounded-full border border-dashed border-slate-700 px-3 py-1 text-xs text-slate-400 hover:text-slate-200"
        >
          + Folder
        </button>
      </div>

      {mode === 'creating' && (
        <div className="mt-2">
          <InlineNameForm
            label="New folder name"
            placeholder="Folder name"
            submitLabel="Create"
            maxLength={MAX_FOLDER_NAME_LENGTH}
            onCancel={() => setMode('idle')}
            onSubmit={async (name) => {
              const folder = await createFolder(name)
              setMode('idle')
              if (folder) onChange(folder.id)
            }}
          />
        </div>
      )}

      {activeFolder && mode === 'renaming' && (
        <div className="mt-2">
          <InlineNameForm
            key={activeFolder.id}
            label="Folder name"
            placeholder="Folder name"
            initialValue={activeFolder.name}
            maxLength={MAX_FOLDER_NAME_LENGTH}
            onCancel={() => setMode('idle')}
            onSubmit={async (name) => {
              await renameFolder(activeFolder.id, name)
              setMode('idle')
            }}
          />
        </div>
      )}

      {activeFolder && mode === 'idle' && (
        <div className="mt-1 flex gap-3 text-xs">
          <button type="button" onClick={() => setMode('renaming')} className="text-sky-400">
            Rename folder
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = window.confirm(
                `Delete the folder “${activeFolder.name}”? Its sessions are kept and moved to Unfiled.`,
              )
              if (!ok) return
              await deleteFolder(activeFolder.id)
              onChange(null)
            }}
            className="text-red-400"
          >
            Delete folder
          </button>
        </div>
      )}
    </div>
  )
}
