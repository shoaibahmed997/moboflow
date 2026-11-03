import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { isSupportedLanguage, nativeLanguageName, supportedLanguages } from '../lib/asr/models'
import { db, type Session } from '../lib/db'
import { createFolder, MAX_FOLDER_NAME_LENGTH, moveSessionToFolder, setSessionTags } from '../lib/library'
import { setSessionLanguage } from '../lib/sessions'
import { InlineNameForm } from './InlineNameForm'
import { TagEditor } from './TagEditor'

const NEW_FOLDER = '__new__'

/**
 * Folder, language and tags controls for one session. The language is relabel-only:
 * the model auto-detects what was spoken, so changing it re-applies the right
 * formatting rules (and search/export) rather than re-transcribing.
 */
export function SessionOrganizer({ session, languageLocked }: { session: Session; languageLocked: boolean }) {
  const [creatingFolder, setCreatingFolder] = useState(false)
  const folders = useLiveQuery(
    async () => (await db.folders.toArray()).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  )
  const allTags = useLiveQuery(() => db.sessions.orderBy('tags').uniqueKeys(), []) as string[] | undefined
  const suggestions = useMemo(() => (allTags ?? []).map(String), [allTags])

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-slate-500">Folder</span>
        {creatingFolder ? (
          <InlineNameForm
            label="New folder name"
            placeholder="Folder name"
            submitLabel="Create"
            maxLength={MAX_FOLDER_NAME_LENGTH}
            onCancel={() => setCreatingFolder(false)}
            onSubmit={async (name) => {
              const folder = await createFolder(name)
              if (folder) await moveSessionToFolder(session.id, folder.id)
              setCreatingFolder(false)
            }}
          />
        ) : (
          <select
            value={session.folderId ?? ''}
            aria-label="Folder"
            onChange={(event) => {
              const value = event.target.value
              if (value === NEW_FOLDER) setCreatingFolder(true)
              else void moveSessionToFolder(session.id, value || undefined)
            }}
            className="min-w-0 flex-1 rounded bg-transparent py-0.5 text-slate-200 focus:outline-none"
          >
            <option value="">Unfiled</option>
            {folders?.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
            <option value={NEW_FOLDER}>+ New folder…</option>
          </select>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-slate-500">Language</span>
        <select
          value={session.language}
          aria-label="Session language"
          disabled={languageLocked}
          title={languageLocked ? 'Stop the recording to change its language' : undefined}
          onChange={(event) => void setSessionLanguage(session.id, event.target.value)}
          className="min-w-0 flex-1 rounded bg-transparent py-0.5 text-slate-200 focus:outline-none disabled:opacity-50"
        >
          {!isSupportedLanguage(session.language) && (
            <option value={session.language}>{nativeLanguageName(session.language)}</option>
          )}
          {supportedLanguages().map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-start gap-2">
        <span className="w-16 shrink-0 pt-1 text-slate-500">Tags</span>
        <div className="min-w-0 flex-1">
          <TagEditor
            tags={session.tags}
            suggestions={suggestions}
            onChange={(tags) => void setSessionTags(session.id, tags)}
          />
        </div>
      </div>
    </div>
  )
}
