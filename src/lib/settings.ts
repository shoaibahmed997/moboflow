// User preferences, persisted in IndexedDB alongside everything else (so they travel
// with any future backup/export of the database, unlike localStorage).
import { useLiveQuery } from 'dexie-react-hooks'
import { languageKey, preferredLanguage } from './asr/models'
import { db } from './db'

export interface Settings {
  /** Language for new recordings (primary subtag, e.g. "de"). */
  language: string
}

const defaults = (): Settings => ({
  language: preferredLanguage(typeof navigator === 'undefined' ? [] : navigator.languages),
})

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const row = await db.settings.get(key)
  return (row?.value as Settings[K] | undefined) ?? defaults()[key]
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await db.settings.put({ key, value })
}

export function setLanguagePreference(language: string): Promise<void> {
  return setSetting('language', languageKey(language))
}

/** Live value; undefined only for the first render while IndexedDB is read. */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return useLiveQuery(() => getSetting(key), [key])
}
