// Model registry (SPEC.md §6 Phase 8): which ONNX assets serve which language. Shared by
// the main thread (language picker, engine selection) and the ASR worker (what to
// download), so it must stay free of DOM/React imports.
//
// Today every language maps to one multilingual checkpoint: parakeet-tdt-0.6b-v3 covers
// 25 European languages and detects the spoken language itself — it takes no language
// prompt (its vocab has Canary-style <|xx|> tokens, but the TDT decoder never consumes
// them). Verified end-to-end with German/French/Spanish speech. Adding a language-
// specific model later is a registry change: add a ModelSpec and point languages at it.

export interface ModelFile {
  name: string
  /** For progress weighting before Content-Length is known, and storage budgeting. */
  approxBytes: number
}

export interface ModelSpec {
  id: string
  version: string
  label: string
  baseUrl: string
  /** Cache API bucket. Changing it (e.g. on a version bump) orphans the old bucket, which modelStorage.ts cleans up. */
  cacheName: string
  files: readonly ModelFile[]
}

export const PARAKEET_TDT_V3: ModelSpec = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  version: '1',
  label: 'Parakeet TDT 0.6B v3 (INT8, multilingual)',
  // Dev-only static server (vite.config.ts serveParakeetModels); production points at a CDN.
  baseUrl: '/models/parakeet/',
  // Pre-Phase-8 name, kept so existing installs don't re-download ~890MB.
  cacheName: 'moboflow-parakeet-tdt-0.6b-v3-int8',
  files: [
    { name: 'encoder-int8.onnx', approxBytes: 1.4e6 },
    { name: 'encoder-int8.onnx.data', approxBytes: 878e6 },
    { name: 'decoder_joint-int8.onnx', approxBytes: 53.6e6 },
    { name: 'vocab.txt', approxBytes: 94e3 },
  ],
}

export const MODELS: Record<string, ModelSpec> = { [PARAKEET_TDT_V3.id]: PARAKEET_TDT_V3 }

export const MODEL_CACHE_PREFIX = 'moboflow-'

export function modelSize(spec: ModelSpec): number {
  return spec.files.reduce((sum, f) => sum + f.approxBytes, 0)
}

/** Primary language subtags (ISO 639-1), per NVIDIA's parakeet-tdt-0.6b-v3 model card. */
const PARAKEET_V3_LANGUAGES = [
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it',
  'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk',
] as const

export const LANGUAGE_MODELS: Record<string, string> = Object.fromEntries(
  PARAKEET_V3_LANGUAGES.map((code) => [code, PARAKEET_TDT_V3.id]),
)

export const DEFAULT_LANGUAGE = 'en'

/** Normalizes any BCP-47 tag ("en-US", "PT_br") to the primary subtag the registry is keyed by. */
export function languageKey(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] || DEFAULT_LANGUAGE
}

export function isSupportedLanguage(tag: string): boolean {
  return languageKey(tag) in LANGUAGE_MODELS
}

export function modelForLanguage(tag: string): ModelSpec {
  return MODELS[LANGUAGE_MODELS[languageKey(tag)] ?? LANGUAGE_MODELS[DEFAULT_LANGUAGE]]
}

/** Best supported match for the browser's languages, else English. */
export function preferredLanguage(candidates: readonly string[] = []): string {
  return candidates.map(languageKey).find((code) => code in LANGUAGE_MODELS) ?? DEFAULT_LANGUAGE
}

/** "Deutsch", "français"… — each language named in itself, falling back to the code. */
export function nativeLanguageName(tag: string): string {
  const code = languageKey(tag)
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code
  } catch {
    return code
  }
}

let languageList: { code: string; name: string }[] | null = null

/** Supported languages by native name — computed once (25 Intl.DisplayNames lookups). */
export function supportedLanguages(): { code: string; name: string }[] {
  languageList ??= Object.keys(LANGUAGE_MODELS)
    .map((code) => ({ code, name: nativeLanguageName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return languageList
}
