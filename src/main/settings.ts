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
    llm: { ...defaultSettings.llm, ...(stored.llm ?? {}) }
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
