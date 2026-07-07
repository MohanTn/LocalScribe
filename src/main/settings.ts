import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings } from '../shared/types'

// Plain JSON file in userData — no store library needed for a single object.
const file = (): string => join(app.getPath('userData'), 'settings.json')

export const defaultSettings: Settings = {
  model: 'base',
  language: 'auto',
  autoPaste: true,
  hotkeyToggle: 'CommandOrControl+Shift+R',
  hotkeyPtt: '',
  micDeviceId: '',
  forceCpu: false,
  pauseMediaOnRecord: true,
  autoUpdateCheck: true,
  llm: {
    provider: 'none',
    apiKey: '',
    endpoint: 'http://localhost:11434',
    model: '',
    promptMode: 'default',
    autoPolish: false
  },
  vocabulary: []
}

// Older versions stored vocabulary as { from, to } correction pairs instead of
// a plain list of correct spellings; pull the `to` side out of any pair so
// settings.json files written before this change still load sensibly instead
// of feeding whisper/the fuzzy matcher a list of stringified objects.
function normalizeVocabulary(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && 'to' in entry) {
        return String((entry as { to: unknown }).to ?? '')
      }
      return ''
    })
    .map((s) => s.trim())
    .filter(Boolean)
}

let cached: Settings | null = null

export function getSettings(): Settings {
  if (cached) return cached
  let stored: Partial<Settings> = {}
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    // Corrupt settings file: fall back to defaults rather than crashing.
  }
  cached = {
    ...defaultSettings,
    ...stored,
    llm: { ...defaultSettings.llm, ...(stored.llm ?? {}) },
    vocabulary: normalizeVocabulary(stored.vocabulary)
  }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  cached = {
    ...current,
    ...patch,
    llm: { ...current.llm, ...(patch.llm ?? {}) }
  }
  writeFileSync(file(), JSON.stringify(cached, null, 2))
  return cached
}
