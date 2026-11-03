import { useLiveQuery } from 'dexie-react-hooks'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { SegmentEditor } from '../components/SegmentEditor'
import { ExportMenu } from '../components/ExportMenu'
import { SessionOrganizer } from '../components/SessionOrganizer'
import { SessionStatusBadge } from '../components/SessionStatusBadge'
import { TranscriptView } from '../components/TranscriptView'
import { db, type Segment, type Session } from '../lib/db'
import { nativeLanguageName } from '../lib/asr/models'
import { useRecorder } from '../lib/recorder/RecorderContext'
import { useSegmentEditor } from '../lib/transcript/useSegmentEditor'
import { completeSession, deleteSession, formatDuration, getSessionSegments, renameSession } from '../lib/sessions'

export function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const recorder = useRecorder()
  const listSearch = (location.state as { listSearch?: string } | null)?.listSearch
  const backTo = listSearch ? `/sessions?${listSearch}` : '/sessions'

  const session = useLiveQuery(async () => (await db.sessions.get(sessionId!)) ?? null, [sessionId])
  const segments = useLiveQuery(() => getSessionSegments(sessionId!), [sessionId])
  const folderId = session?.folderId
  const folderName = useLiveQuery(async () => (folderId ? (await db.folders.get(folderId))?.name : undefined), [folderId])

  if (session === undefined) {
    return <p className="flex-1 px-4 py-6 text-sm text-slate-500">Loading…</p>
  }

  if (session === null) {
    return (
      <div className="flex-1 px-4 py-6">
        <p className="text-sm text-slate-500">Session not found.</p>
        <Link to={backTo} className="mt-2 inline-block text-sm text-sky-400">
          Back to sessions
        </Link>
      </div>
    )
  }

  const isLiveHere = recorder.sessionId === session.id
  // 'recording' but not ours: another tab owns it (or it's about to be recovered as a draft).
  const isLiveElsewhere = session.status === 'recording' && !isLiveHere

  const onDelete = async () => {
    if (!window.confirm(`Delete “${session.title}”? This can't be undone.`)) return
    await deleteSession(session.id)
    navigate(backTo, { replace: true })
  }

  const onResume = async () => {
    navigate('/')
    await recorder.resume(session.id)
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <Link to={backTo} className="text-sm text-sky-400">
        ← Sessions
      </Link>

      <SessionTitle key={session.id} session={session} />
      <p className="mb-4 flex items-center gap-2 text-xs text-slate-500">
        <span>
          {new Date(session.createdAt).toLocaleString()} · {formatDuration(session.durationMs)} · {nativeLanguageName(session.language)}
        </span>
        <SessionStatusBadge status={session.status} />
      </p>
      <SessionOrganizer session={session} languageLocked={isLiveHere || isLiveElsewhere} />
      <div className="mb-4">
        <ExportMenu session={session} segments={segments ?? []} folderName={folderName} />
      </div>

      {isLiveHere && (
        <Notice>
          This session is being recorded.{' '}
          <Link to="/" className="text-sky-400">
            Go to recorder
          </Link>
        </Notice>
      )}
      {isLiveElsewhere && <Notice>This session is being recorded in another tab.</Notice>}
      {session.status === 'draft' && (
        <Notice tone="warning">
          This recording was interrupted before it was stopped. Everything up to the last
          finished sentence was saved.
          <span className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onResume}
              disabled={recorder.state !== 'idle'}
              className="rounded bg-amber-400 px-3 py-1 text-xs font-medium text-slate-950 disabled:opacity-50"
            >
              Resume recording
            </button>
            <button
              type="button"
              onClick={() => void completeSession(session.id)}
              className="rounded px-3 py-1 text-xs text-amber-200"
            >
              Save as is
            </button>
          </span>
        </Notice>
      )}

      {segments === undefined ? null : segments.length ? (
        <EditableTranscript key={session.id} sessionId={session.id} language={session.language} segments={segments} />
      ) : (
        <p className="text-sm text-slate-500">No transcript segments yet.</p>
      )}

      <div className="mt-8 border-t border-slate-800 pt-4">
        <button
          type="button"
          onClick={onDelete}
          disabled={isLiveHere || isLiveElsewhere}
          title={isLiveHere || isLiveElsewhere ? 'Stop the recording before deleting it' : undefined}
          className="text-sm text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete session
        </button>
      </div>
    </div>
  )
}

function EditableTranscript({
  sessionId,
  language,
  segments,
}: {
  sessionId: string
  language: string
  segments: Segment[]
}) {
  const editor = useSegmentEditor(sessionId)
  const [activeId, setActiveId] = useState<string | null>(null)

  return (
    <section aria-label="Transcript">
      <div className="mb-3 flex items-center gap-1 text-xs">
        <p className="flex-1 text-slate-500">Tap a sentence to edit it.</p>
        <button
          type="button"
          onClick={() => void editor.undo()}
          disabled={!editor.canUndo}
          aria-keyshortcuts="Meta+Z Control+Z"
          className="rounded px-2 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => void editor.redo()}
          disabled={!editor.canRedo}
          aria-keyshortcuts="Meta+Shift+Z Control+Y"
          className="rounded px-2 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          Redo
        </button>
      </div>
      {editor.error && <p className="mb-3 text-xs text-red-400">{editor.error}</p>}

      <div className="text-base leading-relaxed text-slate-300">
        <TranscriptView
          segments={segments}
          language={language}
          showTimestamps
          editing={{
            activeId,
            onSelect: (part) => setActiveId(part.segment.id),
            renderEditor: (part) => (
              <SegmentEditor
                part={part}
                onSave={(text) => void editor.edit(part.segment, text, part.text)}
                onDelete={() => void editor.remove(part.segment)}
                onRevert={() => void editor.revert(part.segment)}
                onClose={() => setActiveId(null)}
              />
            ),
          }}
        />
      </div>
    </section>
  )
}

function SessionTitle({ session }: { session: Session }) {
  const [draft, setDraft] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (draft !== null) await renameSession(session.id, draft)
    setDraft(null)
  }

  if (draft === null) {
    return (
      <div className="mt-2 mb-1 flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-semibold break-words text-slate-100">{session.title}</h1>
        <button
          type="button"
          onClick={() => setDraft(session.title)}
          className="shrink-0 pt-1 text-xs text-sky-400"
        >
          Rename
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 mb-1 flex gap-2">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setDraft(null)}
        aria-label="Session title"
        maxLength={120}
        className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-base text-slate-100 focus:border-sky-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!draft.trim()}
        className="rounded bg-sky-500 px-3 text-sm font-medium text-slate-950 disabled:opacity-50"
      >
        Save
      </button>
      <button type="button" onClick={() => setDraft(null)} className="px-1 text-sm text-slate-400">
        Cancel
      </button>
    </form>
  )
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }) {
  const className =
    tone === 'warning'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
      : 'border-slate-800 bg-slate-900 text-slate-300'
  return <div className={`mb-4 flex flex-col rounded-lg border px-4 py-3 text-sm ${className}`}>{children}</div>
}
