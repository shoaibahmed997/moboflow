import { describe, expect, it } from 'vitest'
import type { Segment } from '../db'
import { cleanText, formatTranscript } from './format'

let nextId = 0
const seg = (startMs: number, endMs: number, text: string, extra: Partial<Segment> = {}): Segment => ({
  id: `s${nextId++}`,
  sessionId: 'session',
  startMs,
  endMs,
  text,
  isEdited: false,
  ...extra,
})

describe('cleanText', () => {
  it.each([
    ['already clean output is untouched', 'Quick brown fox jumps over the lazy dog.', 'Quick brown fox jumps over the lazy dog.'],
    ['capitalizes and terminates', 'so this is a test', 'So this is a test.'],
    ['collapses whitespace and fixes space before punctuation', '  hello ,  world  !', 'Hello, world!'],
    ['capitalizes standalone i and contractions', "i think i'm right and i've won", "I think I'm right and I've won."],
    ['leaves i.e. alone', 'fruit, i.e. apples', 'Fruit, i.e. apples.'],
    ['does not treat abbreviations as sentence ends', 'ask dr. smith vs. the others', 'Ask dr. smith vs. the others.'],
    ['capitalizes after sentence ends', 'first one. second one? third', 'First one. Second one? Third.'],
    ['removes fillers and their commas', 'So, um, I was, uh, thinking um about it', 'So, I was, thinking about it.'],
    ['removes a leading filler', 'Um, so here we go', 'So here we go.'],
    ['removes a trailing filler', 'and then uh.', 'And then.'],
    ['keeps words that merely start like fillers', 'my umbrella and uh-huh', 'My umbrella and uh-huh.'],
    ['keeps existing terminal punctuation', 'Really?', 'Really?'],
  ])('%s', (_, input, expected) => {
    expect(cleanText(input)).toBe(expected)
  })

  it('returns empty for filler-only input', () => {
    expect(cleanText('Um.')).toBe('')
    expect(cleanText('  uh,  ')).toBe('')
  })

  it('can skip capitalization and termination for continuation segments', () => {
    expect(cleanText('and then we left', { capitalizeStart: false, terminate: false })).toBe('and then we left')
  })
})

describe('cleanText per language', () => {
  it('only applies English rules to English', () => {
    expect(cleanText('i bin müde', { language: 'de' })).toBe('I bin müde.') // sentence start, not "i" → "I"
    expect(cleanText('und i bin müde', { language: 'de' })).toBe('Und i bin müde.')
    expect(cleanText('ok um sure', { language: 'de' })).toBe('Ok um sure.') // "um" is a German word
    expect(cleanText('ok um sure', { language: 'en' })).toBe('Ok sure.')
  })

  it.each([
    ['de', 'Also, äh, wir müssen ähm das Budget prüfen', 'Also, wir müssen das Budget prüfen.'],
    ['de', 'Ähm, guten Morgen', 'Guten Morgen.'],
    ['de', 'die Fähre fährt', 'Die Fähre fährt.'], // "äh" inside words untouched
    ['fr', 'euh, nous allons euh parler', 'Nous allons parler.'],
    ['nl', 'eh, we gaan uhm beginnen', 'We gaan beginnen.'],
    ['es', 'eh bueno, vamos', 'Eh bueno, vamos.'], // no Spanish filler list: left alone
    ['ru', 'привет. как дела', 'Привет. Как дела.'], // universal capitalization works in Cyrillic
  ])('%s: %s', (language, input, expected) => {
    expect(cleanText(input, { language })).toBe(expected)
  })

  it('uses language-specific abbreviations', () => {
    expect(cleanText('das ist ca. drei meter', { language: 'de' })).toBe('Das ist ca. drei meter.')
    expect(cleanText('das ist ca. drei meter', { language: 'en' })).toBe('Das ist ca. Drei meter.')
  })
})

describe('formatTranscript', () => {
  it('starts a new paragraph after a long pause', () => {
    const paragraphs = formatTranscript([
      seg(0, 2000, 'first sentence'),
      seg(2800, 4000, 'second sentence'),
      seg(7000, 8000, 'after a long pause'),
    ])
    expect(paragraphs.map((p) => p.parts.map((part) => part.text))).toEqual([
      ['First sentence.', 'Second sentence.'],
      ['After a long pause.'],
    ])
    expect(paragraphs.map((p) => p.startMs)).toEqual([0, 7000])
  })

  it('joins segments split by the VAD max-length cut into one sentence', () => {
    const paragraphs = formatTranscript([seg(0, 30000, 'we kept talking and'), seg(30100, 32000, 'talking some more')])
    expect(paragraphs[0].parts.map((p) => p.text)).toEqual(['We kept talking and', 'talking some more.'])
  })

  it('shows edited segments verbatim', () => {
    const paragraphs = formatTranscript([seg(0, 1000, 'lowercase on purpose', { isEdited: true, originalText: 'x' })])
    expect(paragraphs[0].parts[0].text).toBe('lowercase on purpose')
  })

  it('drops segments that are empty after cleanup', () => {
    const paragraphs = formatTranscript([seg(0, 1000, 'hello'), seg(1600, 2000, 'um'), seg(2600, 3000, 'world')])
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0].parts.map((p) => p.text)).toEqual(['Hello.', 'World.'])
  })

  it('returns no paragraphs for no segments', () => {
    expect(formatTranscript([])).toEqual([])
  })
})
