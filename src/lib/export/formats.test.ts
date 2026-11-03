import { HtmlRenderer, Parser } from 'commonmark'
import { describe, expect, it } from 'vitest'
import type { Segment, Session } from '../db'
import { escapeMarkdown, exportFilename, markdownTag, toMarkdown, toPlainText } from './formats'

const session = (extra: Partial<Session> = {}): Session => ({
  id: 's',
  title: 'Roadmap sync',
  createdAt: new Date(2026, 10, 3, 14, 5).getTime(),
  updatedAt: 0,
  durationMs: 75_000,
  language: 'en-US',
  tags: [],
  status: 'complete',
  ...extra,
})

let n = 0
const seg = (startMs: number, endMs: number, text: string): Segment => ({
  id: `g${n++}`,
  sessionId: 's',
  startMs,
  endMs,
  text,
  isEdited: false,
})

// Two paragraphs (3s+ gap), given out of order to check sorting.
const segments = [
  seg(9000, 11000, 'second topic is pricing'),
  seg(0, 2000, 'um so first the roadmap'),
  seg(2700, 5000, 'we ship in march'),
]

/** Top-level block structure as a CommonMark renderer (and so a notes app) sees it. */
function blocks(markdown: string) {
  const doc = new Parser().parse(markdown)
  const out: { type: string; text: string; inline: string[] }[] = []
  for (let node = doc.firstChild; node; node = node.next) {
    let text = ''
    const inline = new Set<string>()
    const walker = node.walker()
    for (let event = walker.next(); event; event = walker.next()) {
      if (!event.entering) continue
      if (event.node.literal) text += event.node.literal
      if (event.node.type !== 'text' && event.node !== node) inline.add(event.node.type)
    }
    out.push({ type: node.type, text, inline: [...inline] })
  }
  return out
}

describe('toMarkdown', () => {
  it('renders as one heading, a metadata line, then plain paragraphs', () => {
    const md = toMarkdown(session({ tags: ['work', 'big ideas'] }), segments, { folderName: 'Work' })
    const parsed = blocks(md)

    expect(parsed.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'paragraph'])
    expect(parsed[0].text).toBe('Roadmap sync')
    expect(parsed[1].inline).toEqual(['emph'])
    expect(parsed[1].text).toMatch(/^Recorded .+ · 1:15 · Folder: Work$/)
    expect(parsed[2].text).toBe('#work #big-ideas')
    expect(parsed[3]).toMatchObject({ text: 'So first the roadmap. We ship in march.', inline: [] })
    expect(parsed[4]).toMatchObject({ text: 'Second topic is pricing.', inline: [] })
  })

  it('keeps transcript text literal even when it looks like Markdown', () => {
    const tricky = [
      seg(0, 1000, '# not a heading'),
      seg(4000, 5000, '1. not a list'),
      seg(8000, 9000, '- or this'),
      seg(12000, 13000, '> nor a quote'),
      seg(16000, 17000, 'use *stars* and _underscores_ and `ticks` and [brackets](x) <b>html</b>'),
      seg(20000, 21000, 'snake_case_names stay readable'),
    ]
    const md = toMarkdown(session({ title: '*Draft* # notes' }), tricky)
    const parsed = blocks(md)

    expect(parsed.map((b) => b.type)).toEqual(['heading', 'paragraph', ...Array(6).fill('paragraph')])
    expect(parsed[0]).toMatchObject({ text: '*Draft* # notes', inline: [] })
    expect(parsed.slice(2).map((b) => b.text)).toEqual([
      '# Not a heading.',
      '1. Not a list.',
      '- Or this.',
      '> Nor a quote.',
      'Use *stars* and _underscores_ and `ticks` and [brackets](x) <b>html</b>',
      'Snake_case_names stay readable.',
    ])
    expect(parsed.slice(2).every((b) => b.inline.length === 0)).toBe(true)
    expect(md).toContain('Snake_case_names') // not needlessly escaped
    expect(new HtmlRenderer({ safe: true }).render(new Parser().parse(md))).not.toContain('<b>')
  })

  it('optionally prefixes paragraphs with bold timestamps', () => {
    const parsed = blocks(toMarkdown(session(), segments, { timestamps: true }))
    expect(parsed.at(-1)).toMatchObject({ text: '[0:09] Second topic is pricing.', inline: ['strong'] })
  })
})

describe('toPlainText', () => {
  it('has title, metadata and blank-line-separated paragraphs', () => {
    const text = toPlainText(session({ tags: ['work'] }), segments, { timestamps: true })
    const [title, meta, p1, p2, ...rest] = text.trimEnd().split('\n\n')
    expect(title).toBe('Roadmap sync')
    expect(meta).toMatch(/^Recorded .+ · 1:15\nTags: work$/)
    expect(p1).toBe('[0:00] So first the roadmap. We ship in march.')
    expect(p2).toBe('[0:09] Second topic is pricing.')
    expect(rest).toEqual([])
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('helpers', () => {
  it('escapeMarkdown leaves ordinary prose untouched', () => {
    expect(escapeMarkdown("It's 5-10 minutes, isn't it? Yes — 100%.")).toBe("It's 5-10 minutes, isn't it? Yes — 100%.")
  })

  it('markdownTag makes tags usable in Obsidian/Bear', () => {
    expect(markdownTag('big ideas')).toBe('#big-ideas')
    expect(markdownTag('q3/okr')).toBe('#q3/okr')
    expect(markdownTag('café!')).toBe('#café')
  })

  it.each([
    ['Roadmap sync', 'Roadmap sync 2026-11-03.md'],
    ['Recording · Nov 3, 2:05 PM', 'Recording Nov 3, 2 05 PM 2026-11-03.md'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j 2026-11-03.md'],
    ['...hidden', 'hidden 2026-11-03.md'],
    ['   ', 'Transcript 2026-11-03.md'],
    ['Встреча по плану', 'Встреча по плану 2026-11-03.md'],
  ])('exportFilename(%j)', (title, expected) => {
    expect(exportFilename(session({ title }), 'md')).toBe(expected)
  })
})
