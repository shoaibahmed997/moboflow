import { describe, expect, it } from 'vitest'
import type { Segment, Session } from '../db'
import { SessionSearchIndex } from './sessionSearch'

const session = (id: string, title: string, extra: Partial<Session> = {}): Session => ({
  id,
  title,
  createdAt: 0,
  updatedAt: 1,
  durationMs: 0,
  language: 'en-US',
  tags: [],
  status: 'complete',
  ...extra,
})

function setup(initial: Record<string, string[]>) {
  const segments = new Map(Object.entries(initial))
  const loads: string[][] = []
  const index = new SessionSearchIndex(async (ids) => {
    loads.push(ids)
    return ids.flatMap((id) =>
      (segments.get(id) ?? []).map(
        (text, i): Segment => ({ id: `${id}-${i}`, sessionId: id, startMs: i * 1000, endMs: i * 1000 + 800, text, isEdited: false }),
      ),
    )
  })
  return { index, segments, loads }
}

const ids = (index: SessionSearchIndex, q: string) => index.search(q).map((hit) => hit.sessionId)

describe('SessionSearchIndex', () => {
  it('finds sessions by transcript content, title and tag, ranking title hits first', async () => {
    const { index } = setup({ a: ['we talked about the roadmap'], b: ['grocery list apples'], c: ['nothing relevant'] })
    await index.sync([
      session('a', 'Monday standup'),
      session('b', 'Errands', { tags: ['personal'] }),
      session('c', 'Roadmap planning'),
    ])
    expect(ids(index, 'roadmap')).toEqual(['c', 'a'])
    expect(ids(index, 'apple')).toEqual(['b'])
    expect(ids(index, 'personal')).toEqual(['b'])
    expect(index.search('pers')[0].matchedTags).toEqual(['personal'])
    expect(ids(index, '   ')).toEqual([])
  })

  it('requires every term, but terms may span title and transcript', async () => {
    const { index } = setup({ a: ['pricing is still open'] })
    await index.sync([session('a', 'Roadmap')])
    expect(ids(index, 'roadmap pricing')).toEqual(['a'])
    expect(ids(index, 'roadmap bananas')).toEqual([])
  })

  it('returns a highlighted snippet from the formatted transcript', async () => {
    const { index } = setup({ a: ['um so the pricing is open'] })
    await index.sync([session('a', 'Notes')])
    const [hit] = index.search('pricing')
    expect(hit.snippet?.text).toBe('So the pricing is open.')
    expect(hit.snippet && hit.snippet.text.slice(...hit.snippet.highlights[0])).toBe('pricing')
  })

  it('re-indexes only changed sessions and drops deleted ones', async () => {
    const { index, segments, loads } = setup({ a: ['alpha'], b: ['bravo'] })
    await index.sync([session('a', 'A'), session('b', 'B')])
    expect(loads).toEqual([['a', 'b']])

    segments.set('a', ['alpha charlie'])
    await index.sync([session('a', 'A', { updatedAt: 2 }), session('b', 'B')])
    expect(loads[1]).toEqual(['a'])
    expect(ids(index, 'charlie')).toEqual(['a'])

    await index.sync([session('a', 'A', { updatedAt: 2 }), session('b', 'B')])
    expect(loads).toHaveLength(2) // nothing changed → no reload

    await index.sync([session('a', 'A', { updatedAt: 2 })])
    expect(ids(index, 'bravo')).toEqual([])
    expect(index.size).toBe(1)
  })

  it('builds and searches a 300-session library quickly', async () => {
    const words = ['roadmap', 'pricing', 'onboarding', 'design', 'hiring', 'budget', 'launch', 'meeting', 'travel', 'family']
    const library: Record<string, string[]> = {}
    const sessions: Session[] = []
    for (let i = 0; i < 300; i++) {
      library[`s${i}`] = Array.from({ length: 20 }, (_, j) =>
        `sentence ${j} about the ${words[(i + j) % words.length]} and the ${words[(i * 3 + j) % words.length]} plan`,
      )
      sessions.push(session(`s${i}`, `Session ${i}`, { tags: [words[i % words.length]] }))
    }
    library.s299.push('a unique zebra crossing')
    const { index } = setup(library)

    let t0 = performance.now()
    await index.sync(sessions)
    const buildMs = performance.now() - t0

    t0 = performance.now()
    for (let i = 0; i < 50; i++) index.search(words[i % words.length])
    const searchMs = (performance.now() - t0) / 50

    expect(ids(index, 'zebra')).toEqual(['s299'])
    console.log(`300 sessions × 20 segments: build ${buildMs.toFixed(0)}ms, search ${searchMs.toFixed(2)}ms/query`)
    expect(buildMs).toBeLessThan(2000)
    expect(searchMs).toBeLessThan(15) // ~1.5ms on an M-series laptop; headroom for slower CI
  })
})
