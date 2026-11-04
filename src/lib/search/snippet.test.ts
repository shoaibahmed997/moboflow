import { describe, expect, it } from 'vitest'
import { buildSnippet, findMatches, queryTerms } from './snippet'

const highlighted = (text: string, ranges: [number, number][]) => ranges.map(([s, e]) => text.slice(s, e))

describe('queryTerms', () => {
  it('lowercases, folds accents, splits on punctuation and dedupes', () => {
    expect(queryTerms('  Café, ROADMAP road-map café ')).toEqual(['cafe', 'roadmap', 'road', 'map'])
  })
})

describe('findMatches', () => {
  it('matches words by prefix, case- and accent-insensitively, highlighting the whole word', () => {
    const text = 'The Café roadmap: road trips, not railroads.'
    expect(highlighted(text, findMatches(text, ['cafe', 'road', 'roadmap']))).toEqual(['Café', 'roadmap', 'road'])
  })

  it('maps ranges back correctly after multi-codepoint characters', () => {
    const text = 'naïve résumé review'
    expect(highlighted(text, findMatches(text, ['resume', 'rev']))).toEqual(['résumé', 'review'])
  })

  it('treats regex characters in terms literally', () => {
    expect(findMatches('aab ab', ['a+b'])).toEqual([])
    expect(findMatches('x a+b', ['a+b'])).toEqual([[2, 5]])
  })
})

describe('buildSnippet', () => {
  const long = `${'lorem ipsum '.repeat(20)}the pricing discussion went long ${'dolor sit '.repeat(20)}`

  it('centres on the first match, snaps to words and flags truncation', () => {
    const snippet = buildSnippet(long, ['pricing'])!
    expect(snippet.truncatedStart).toBe(true)
    expect(snippet.truncatedEnd).toBe(true)
    expect(snippet.text.startsWith('lorem') || snippet.text.startsWith('ipsum')).toBe(true)
    expect(highlighted(snippet.text, snippet.highlights)).toEqual(['pricing'])
  })

  it('returns the whole text untruncated when short', () => {
    const snippet = buildSnippet('Pricing is open.', ['pric'])!
    expect(snippet).toMatchObject({ text: 'Pricing is open.', truncatedStart: false, truncatedEnd: false })
  })

  it('returns null when nothing matches literally', () => {
    expect(buildSnippet('nothing here', ['pricing'])).toBeNull()
  })
})
