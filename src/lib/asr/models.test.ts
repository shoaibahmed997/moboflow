import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_MODELS,
  languageKey,
  modelForLanguage,
  nativeLanguageName,
  PARAKEET_TDT_V3,
  preferredLanguage,
  supportedLanguages,
} from './models'

describe('model registry', () => {
  it('covers the 25 Parakeet v3 languages, all served by the one multilingual model', () => {
    expect(Object.keys(LANGUAGE_MODELS)).toHaveLength(25)
    expect(new Set(Object.values(LANGUAGE_MODELS))).toEqual(new Set([PARAKEET_TDT_V3.id]))
  })

  it('normalizes BCP-47 tags to primary subtags', () => {
    expect(languageKey('en-US')).toBe('en')
    expect(languageKey(' PT_br ')).toBe('pt')
    expect(languageKey('')).toBe('en')
  })

  it('switching between supported languages never changes the model (no re-download)', () => {
    const models = ['en', 'de-DE', 'fr', 'es', 'uk'].map((l) => modelForLanguage(l).id)
    expect(new Set(models).size).toBe(1)
  })

  it('falls back to the default model for unsupported languages', () => {
    expect(modelForLanguage('ja').id).toBe(PARAKEET_TDT_V3.id)
  })

  it('picks the first supported browser language', () => {
    expect(preferredLanguage(['ja-JP', 'de-AT', 'en-US'])).toBe('de')
    expect(preferredLanguage(['ja', 'zh'])).toBe('en')
    expect(preferredLanguage([])).toBe('en')
  })

  it('names languages in themselves', () => {
    expect(nativeLanguageName('de')).toBe('Deutsch')
    expect(nativeLanguageName('fr-FR')).toBe('Français')
    expect(supportedLanguages().find((l) => l.code === 'uk')?.name).toBe('Українська')
  })
})
