import { globalShortcut } from 'electron'
import type { Settings } from '../shared/types'

export interface HotkeyHandlers {
  onToggle: () => void
  onPttDown: () => void
  onPttUp: () => void
}

// Electron's globalShortcut fires on key *press* only — fine for the toggle
// hotkey, but push-to-talk needs the key-up event. For that we use the
// optional uiohook-napi native hook when it is installed (see README); when it
// isn't, the PTT combo degrades gracefully to a second toggle shortcut.

interface PttBinding {
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UiohookModule = any

let uiohook: UiohookModule = undefined
let uiohookListening = false
let ptt: PttBinding | null = null
let pttHeld = false
let handlers: HotkeyHandlers | null = null

function loadUiohook(): UiohookModule {
  if (uiohook !== undefined) return uiohook
  try {
    // Optional native dependency: present only if the user installed it.
    uiohook = require('uiohook-napi')
  } catch {
    uiohook = null
  }
  return uiohook
}

/** (Re-)binds all global shortcuts from settings. Safe to call repeatedly. */
export function applyHotkeys(settings: Settings, h: HotkeyHandlers): void {
  handlers = h
  globalShortcut.unregisterAll()
  ptt = null

  if (settings.hotkeyToggle) {
    try {
      globalShortcut.register(settings.hotkeyToggle, () => handlers?.onToggle())
    } catch {
      console.warn(`Invalid toggle hotkey: ${settings.hotkeyToggle}`)
    }
  }

  if (!settings.hotkeyPtt) return
  const mod = loadUiohook()
  if (mod) {
    ptt = parseCombo(settings.hotkeyPtt, mod.UiohookKey)
    if (ptt) startUiohook(mod)
    else console.warn(`Could not parse PTT hotkey: ${settings.hotkeyPtt}`)
  } else {
    // Fallback: hold-to-talk becomes press-to-start / press-to-stop.
    try {
      globalShortcut.register(settings.hotkeyPtt, () => handlers?.onToggle())
    } catch {
      console.warn(`Invalid PTT hotkey: ${settings.hotkeyPtt}`)
    }
  }
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
  if (uiohook && uiohookListening) {
    try {
      uiohook.uIOhook.stop()
    } catch {
      /* already stopped */
    }
    uiohookListening = false
  }
}

function startUiohook(mod: UiohookModule): void {
  if (uiohookListening) return
  uiohookListening = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mod.uIOhook.on('keydown', (e: any) => {
    if (!ptt || pttHeld) return
    if (
      e.keycode === ptt.keycode &&
      !!e.ctrlKey === ptt.ctrl &&
      !!e.altKey === ptt.alt &&
      !!e.shiftKey === ptt.shift &&
      !!e.metaKey === ptt.meta
    ) {
      pttHeld = true
      handlers?.onPttDown()
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mod.uIOhook.on('keyup', (e: any) => {
    if (pttHeld && ptt && e.keycode === ptt.keycode) {
      pttHeld = false
      handlers?.onPttUp()
    }
  })
  mod.uIOhook.start()
}

/** Parses "Ctrl+Shift+Space" style combos into a uiohook keycode + modifiers. */
function parseCombo(combo: string, keyTable: Record<string, number>): PttBinding | null {
  const parts = combo.split('+').map((p) => p.trim())
  const binding: PttBinding = { keycode: -1, ctrl: false, alt: false, shift: false, meta: false }
  for (const part of parts) {
    const p = part.toLowerCase()
    if (p === 'ctrl' || p === 'control' || p === 'commandorcontrol') binding.ctrl = true
    else if (p === 'alt' || p === 'option') binding.alt = true
    else if (p === 'shift') binding.shift = true
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') binding.meta = true
    else {
      // Key names in uiohook's table are capitalized: A..Z, F1..F24, Space...
      const name = part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)
      const code = keyTable[name] ?? keyTable[part]
      if (typeof code !== 'number') return null
      binding.keycode = code
    }
  }
  return binding.keycode >= 0 ? binding : null
}
