/** Linear undo/redo stack. Pushing a new change discards anything that was undone. */
export interface EditHistory<T> {
  push: (change: T) => void
  undo: () => T | undefined
  redo: () => T | undefined
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export function createEditHistory<T>(limit = 200): EditHistory<T> {
  const done: T[] = []
  const undone: T[] = []

  return {
    push(change) {
      done.push(change)
      if (done.length > limit) done.shift()
      undone.length = 0
    },
    undo() {
      const change = done.pop()
      if (change !== undefined) undone.push(change)
      return change
    },
    redo() {
      const change = undone.pop()
      if (change !== undefined) done.push(change)
      return change
    },
    get canUndo() {
      return done.length > 0
    },
    get canRedo() {
      return undone.length > 0
    },
  }
}
