import { describe, expect, it } from 'vitest'
import { createEditHistory } from './editHistory'

describe('createEditHistory', () => {
  it('undoes and redoes in order', () => {
    const history = createEditHistory<number>()
    history.push(1)
    history.push(2)
    expect(history.undo()).toBe(2)
    expect(history.undo()).toBe(1)
    expect(history.undo()).toBeUndefined()
    expect(history.canUndo).toBe(false)
    expect(history.redo()).toBe(1)
    expect(history.redo()).toBe(2)
    expect(history.canRedo).toBe(false)
  })

  it('clears redo when a new change is pushed', () => {
    const history = createEditHistory<number>()
    history.push(1)
    history.undo()
    history.push(2)
    expect(history.canRedo).toBe(false)
    expect(history.undo()).toBe(2)
  })

  it('drops the oldest change past the limit', () => {
    const history = createEditHistory<number>(2)
    history.push(1)
    history.push(2)
    history.push(3)
    expect([history.undo(), history.undo(), history.undo()]).toEqual([3, 2, undefined])
  })
})
