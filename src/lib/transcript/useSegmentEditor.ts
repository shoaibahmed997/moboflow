import { useCallback, useEffect, useRef, useState } from 'react'
import type { Segment } from '../db'
import { editedSegment, revertedSegment, writeSegmentState } from '../sessions'
import { createEditHistory } from './editHistory'

/** One undoable step: the segment's full state before and after (null = didn't exist). */
interface SegmentChange {
  segmentId: string
  before: Segment | null
  after: Segment | null
}

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  )
}

/**
 * Manual transcript edits for one session, with undo/redo. Writes are serialized
 * through a promise chain so rapid edit/undo/redo taps can't interleave and leave
 * IndexedDB out of step with the history stack. History is per page visit — mount
 * this under a component keyed by session id.
 */
export function useSegmentEditor(sessionId: string) {
  const historyRef = useRef(createEditHistory<SegmentChange>())
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const [{ canUndo, canRedo }, setFlags] = useState({ canUndo: false, canRedo: false })
  const [error, setError] = useState<string | null>(null)
  const refresh = () => setFlags({ canUndo: historyRef.current.canUndo, canRedo: historyRef.current.canRedo })

  const enqueue = useCallback((task: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(task).catch((err) => {
      setError(`Couldn't save edit: ${err instanceof Error ? err.message : String(err)}`)
    })
    return queueRef.current
  }, [])

  const apply = useCallback(
    (segment: Segment, after: Segment | null) =>
      enqueue(async () => {
        await writeSegmentState(sessionId, segment.id, after)
        historyRef.current.push({ segmentId: segment.id, before: segment, after })
        setError(null)
        refresh()
      }),
    [enqueue, sessionId],
  )

  /** Saves new text for a segment; empty text deletes it. `shownText` is what the user started from. */
  const edit = useCallback(
    (segment: Segment, text: string, shownText: string) => {
      const trimmed = text.replace(/\s+/g, ' ').trim()
      if (trimmed === shownText) return Promise.resolve()
      return apply(segment, trimmed ? editedSegment(segment, trimmed) : null)
    },
    [apply],
  )

  const remove = useCallback((segment: Segment) => apply(segment, null), [apply])

  const revert = useCallback(
    (segment: Segment) => (segment.isEdited ? apply(segment, revertedSegment(segment)) : Promise.resolve()),
    [apply],
  )

  const step = useCallback(
    (direction: 'undo' | 'redo') =>
      enqueue(async () => {
        const history = historyRef.current
        const change = direction === 'undo' ? history.undo() : history.redo()
        if (!change) return
        try {
          await writeSegmentState(sessionId, change.segmentId, direction === 'undo' ? change.before : change.after)
        } catch (err) {
          // Put the stack back so it still matches what's stored.
          if (direction === 'undo') history.redo()
          else history.undo()
          throw err
        } finally {
          refresh()
        }
      }),
    [enqueue, sessionId],
  )

  const undo = useCallback(() => step('undo'), [step])
  const redo = useCallback(() => step('redo'), [step])

  // ⌘Z / ⇧⌘Z / Ctrl+Y — but not while typing, where the textarea's native undo applies.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || isTextInput(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) void undo()
      else if ((key === 'z' && event.shiftKey) || key === 'y') void redo()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  return {
    edit,
    remove,
    revert,
    undo,
    redo,
    canUndo,
    canRedo,
    error,
  }
}
