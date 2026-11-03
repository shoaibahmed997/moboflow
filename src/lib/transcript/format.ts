// Display-time cleanup of raw ASR output (SPEC.md §6 Phase 5). Non-destructive: the
// stored segment text stays exactly what the model emitted, so formatting rules can
// improve later (or be replaced by a cleanup model) without migrating data, and
// exports can reuse the same pass. Segments the user edited are shown verbatim.
import { DEFAULT_LANGUAGE, languageKey } from '../asr/models'
import type { Segment } from '../db'

/** A pause at least this long between segments starts a new paragraph. */
export const PARAGRAPH_GAP_MS = 2000
/**
 * Segments closer together than this are one utterance split by the VAD's max-length
 * cut (see vad.ts `maxSegmentMs`), not a real pause — so no sentence boundary is
 * inserted between them. Real VAD endpoints need ≥600ms of silence.
 */
export const CONTINUATION_GAP_MS = 300

export interface TranscriptPart {
  segment: Segment
  /** Text as displayed: formatted for raw segments, verbatim for edited ones. */
  text: string
}

export interface TranscriptParagraph {
  startMs: number
  parts: TranscriptPart[]
}

// Per-language rules, keyed by primary language subtag. Languages without an entry get
// only the universal pass (whitespace, punctuation spacing, sentence capitalization,
// terminal period) — conservative on purpose: a wrong "filler" removal deletes words.
interface LanguageRules {
  /** Hesitation-filler stems (regex source), matched as whole words, case-insensitive. */
  fillers?: string[]
  /** A period after these doesn't end a sentence (dotted forms like "i.e"/"z.B" are caught generically). */
  abbreviations?: string[]
  /** Standalone lowercase "i" → "I" (English only, obviously). */
  capitalizeI?: boolean
}

const RULES: Record<string, LanguageRules> = {
  en: {
    fillers: ['u+m+', 'u+h+m*', 'e+r+m+'],
    abbreviations: ['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'approx', 'jr', 'sr'],
    capitalizeI: true,
  },
  de: { fillers: ['ä+h+m*', 'ö+h+m*'], abbreviations: ['dr', 'prof', 'bzw', 'usw', 'ca', 'nr', 'str', 'vgl', 'etc'] },
  fr: { fillers: ['eu+h+', 'heu+'], abbreviations: ['m', 'mme', 'mlle', 'dr', 'etc', 'cf'] },
  nl: { fillers: ['e+h+m*', 'u+h+m+'], abbreviations: ['dhr', 'mevr', 'dr', 'bijv', 'etc'] },
  it: { fillers: ['e+h+m+'], abbreviations: ['sig', 'dott', 'prof', 'ecc', 'etc'] },
  es: { abbreviations: ['sr', 'sra', 'srta', 'dr', 'dra', 'ud', 'uds', 'etc'] },
  pt: { abbreviations: ['sr', 'sra', 'dr', 'dra', 'etc'] },
}

interface CompiledRules {
  filler: RegExp | null
  abbreviations: Set<string>
  capitalizeI: boolean
}

const compiled = new Map<string, CompiledRules>()

function rulesFor(language: string): CompiledRules {
  const key = languageKey(language)
  let rules = compiled.get(key)
  if (!rules) {
    const source = RULES[key] ?? {}
    rules = {
      // Unicode-aware word boundaries (JS \b is ASCII-only, so it can't bound "ähm").
      // The trailing lookahead keeps "uh-huh"/"um's" intact; the leading one keeps "umbrella".
      filler: source.fillers?.length
        ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${source.fillers.join('|')})(?![\\p{L}\\p{N}\\-'’])[,]?\\s*`, 'giu')
        : null,
      abbreviations: new Set(source.abbreviations),
      capitalizeI: !!source.capitalizeI,
    }
    compiled.set(key, rules)
  }
  return rules
}

export interface CleanTextOptions {
  /** Capitalize the first letter (false when continuing the previous segment's sentence). */
  capitalizeStart?: boolean
  /** Add a period if the text doesn't end in punctuation (false when the next segment continues it). */
  terminate?: boolean
  /** Selects language-specific rules (fillers, abbreviations, "i" → "I"). */
  language?: string
}

export function cleanText(
  raw: string,
  { capitalizeStart = true, terminate = true, language = DEFAULT_LANGUAGE }: CleanTextOptions = {},
): string {
  const rules = rulesFor(language)
  let text = raw.replace(/\s+/g, ' ').trim()

  if (rules.filler) text = text.replace(rules.filler, '')
  text = text
    .replace(/^[\s,;:]+/, '') // filler removal can leave a dangling leading comma
    .replace(/,(\s*,)+/g, ',')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,([.!?])/g, '$1')
    .trim()
  if (!/[\p{L}\p{N}]/u.test(text)) return ''

  // Standalone lowercase "i" (also covers i'm / i've / i'll / i'd), but not "i.e.".
  if (rules.capitalizeI) text = text.replace(/\bi\b(?!\.\w)/g, 'I')
  text = text.replace(
    /([\p{L}.]*)([.!?])(\s+)(\p{Ll})/gu,
    (match, word: string, mark: string, space: string, letter: string) =>
      mark === '.' && (word.includes('.') || rules.abbreviations.has(word.toLowerCase()))
        ? match
        : word + mark + space + letter.toUpperCase(),
  )

  if (capitalizeStart) {
    text = text.replace(/^([^\p{L}]*)(\p{Ll})/u, (_, lead: string, letter: string) => lead + letter.toUpperCase())
  }
  if (terminate && /[\p{L}\p{N}]$/u.test(text)) text += '.'
  return text
}

export function endsSentence(text: string): boolean {
  return /[.!?…]["'”’)\]]*$/.test(text)
}

/** Groups segments (sorted by startMs) into paragraphs on long pauses and formats each one in context. */
export function formatTranscript(segments: Segment[], language: string = DEFAULT_LANGUAGE): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = []
  let previous: { segment: Segment; text: string } | null = null

  segments.forEach((segment, i) => {
    const next = segments[i + 1]
    const gapBefore = previous ? segment.startMs - previous.segment.endMs : Infinity
    const gapAfter = next ? next.startMs - segment.endMs : Infinity

    const text = segment.isEdited
      ? segment.text.trim()
      : cleanText(segment.text, {
          capitalizeStart: !(previous && gapBefore < CONTINUATION_GAP_MS && !endsSentence(previous.text)),
          terminate: !(next && gapAfter < CONTINUATION_GAP_MS),
          language,
        })
    if (!text) return // nothing left after cleanup (e.g. a lone "um")

    const current = paragraphs.at(-1)
    if (!current || gapBefore >= PARAGRAPH_GAP_MS) {
      paragraphs.push({ startMs: segment.startMs, parts: [{ segment, text }] })
    } else {
      current.parts.push({ segment, text })
    }
    previous = { segment, text }
  })

  return paragraphs
}

/** Paragraph text exactly as the user reads it — formatted, fillers removed, edits applied. */
export function paragraphText(paragraph: TranscriptParagraph): string {
  return paragraph.parts.map((part) => part.text).join(' ')
}

/** The whole transcript as plain paragraphs. Accepts segments in any order. */
export function transcriptText(segments: Segment[], language: string = DEFAULT_LANGUAGE): string {
  return formatTranscript([...segments].sort((a, b) => a.startMs - b.startMs), language)
    .map(paragraphText)
    .join('\n\n')
}
