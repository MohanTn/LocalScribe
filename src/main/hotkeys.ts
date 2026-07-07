import { globalShortcut } from 'electron'
import { stopPortalHotkeys, tryStartPortalHotkeys } from './hotkeysPortal'
import { loadUiohookModule } from './uiohookLoader'
import type { Settings } from '../shared/types'

export interface HotkeyHandlers {
  onToggle: () => void
  onPttDown: () => void
  onPttUp: () => void
}

// Electron's globalShortcut fires on key *press* only — fine for the toggle
// hotkey in principle, but two things push both hotkeys onto the optional
// uiohook-napi native hook (see README) when it's installed: (1) push-to-talk
// needs the key-*up* event, which globalShortcut can't observe at all, and
// (2) globalShortcut grabs keys via X11 (through XWayland on a Wayland
// session), which silently misses native-Wayland client windows. uiohook's
// Linux backend is also X11-only (XRecord — see libuiohook/src/x11), so it
// has the *same* native-Wayland blind spot as globalShortcut; it only fixes
// the key-release limitation. Without uiohook, PTT degrades gracefully to a
// second toggle shortcut, and the toggle hotkey falls back to globalShortcut
// (fine on X11, flaky on Wayland — see README's hotkey reliability table).
//
// On Linux, applyHotkeys also tries the xdg-desktop-portal GlobalShortcuts
// backend (hotkeysPortal.ts) in the background after registering the tiers
// above. That portal is implemented by the compositor itself, so it has no
// X11/native-Wayland blind spot at all — but it only accepts calls from a
// process the compositor can attribute to an installed app (a systemd
// app-id cgroup scope, which GNOME assigns when launched from a .desktop
// entry). If it binds successfully, the globalShortcut/uiohook registration
// above is torn down so hotkeys don't double-fire; if it fails (dev mode, no
// portal, older desktop), that registration is left in place untouched.

interface KeyBinding {
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

interface UiohookKeyEvent {
  keycode: number
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

// The subset of uiohook-napi's surface this file uses.
interface UiohookModule {
  UiohookKey: Record<string, number>
  uIOhook: {
    on(event: 'keydown' | 'keyup', cb: (e: UiohookKeyEvent) => void): void
    start(): void
    stop(): void
  }
}

let uiohook: UiohookModule | null | undefined = undefined
let uiohookListening = false
let ptt: KeyBinding | null = null
let pttHeld = false
let pttReleaseTimer: NodeJS.Timeout | null = null
let toggleBinding: KeyBinding | null = null
let toggleHeld = false
let toggleReleaseTimer: NodeJS.Timeout | null = null
let toggleFallback: FallbackDebouncer | null = null
let pttFallback: FallbackDebouncer | null = null
let handlers: HotkeyHandlers | null = null
// Bumped on every applyHotkeys call so a slow, superseded portal-bind
// attempt (see below) can tell it's stale once it resolves and back off
// instead of tearing down whatever a newer call already set up.
let applyEpoch = 0

// Without XKB "detectable autorepeat" (not guaranteed on every X server/DE),
// holding a key past the OS repeat delay makes X11 emit rapid keyup+keydown
// pairs for that key instead of only repeated keydowns. Read literally, that
// looks like the combo being released and re-pressed, which would flap
// toggle/PTT on and off while the user is still holding it down. Delaying the
// "released" transition briefly — and cancelling it if the same combo comes
// back down first — absorbs those repeat artifacts while adding no
// perceptible lag to a genuine release.
const REPEAT_DEBOUNCE_MS = 70

// Without uiohook, both hotkeys fall back to Electron's globalShortcut,
// which on Windows is backed by RegisterHotKey. Electron registers it
// without MOD_NOREPEAT, so Windows' OS-level key-repeat keeps re-firing the
// accelerator for as long as the combo is physically held (there's no
// release event to tell us otherwise) — read literally, that's a storm of
// presses instead of one, which turns "hold to talk" into recording
// flickering on/off for as long as the key is down. A held key's repeats
// are always faster than the OS's own repeat-delay setting, and Windows'
// maximum configurable initial repeat delay is 1000 ms (SPI_GETKEYBOARDDELAY
// tops out at that), so any cooldown comfortably above that reliably tells
// "still the same physical hold" apart from "a deliberate new press" without
// needing to query the OS setting.
const FALLBACK_REPEAT_COOLDOWN_MS = 1200

interface FallbackDebouncer {
  /** Call on every accelerator invocation; only the first in a burst runs `fn`. */
  pulse: () => void
  clear: () => void
}

/**
 * Wraps a globalShortcut fallback callback so repeated invocations caused by
 * OS auto-repeat (arriving well within FALLBACK_REPEAT_COOLDOWN_MS of the
 * previous one) collapse into a single call, while an invocation that arrives
 * after the cooldown — a genuinely new press — still fires normally.
 */
function makeFallbackDebouncer(fn: () => void): FallbackDebouncer {
  let cooldownTimer: NodeJS.Timeout | null = null
  return {
    pulse: () => {
      if (cooldownTimer) {
        clearTimeout(cooldownTimer)
      } else {
        fn()
      }
      cooldownTimer = setTimeout(() => {
        cooldownTimer = null
      }, FALLBACK_REPEAT_COOLDOWN_MS)
    },
    clear: () => {
      if (cooldownTimer) {
        clearTimeout(cooldownTimer)
        cooldownTimer = null
      }
    }
  }
}

function loadUiohook(): UiohookModule | null {
  if (uiohook !== undefined) return uiohook
  uiohook = loadUiohookModule() as UiohookModule | null
  return uiohook
}

/**
 * Binds one hotkey: with uiohook available, parses the combo for the shared
 * keydown/keyup listener (returned binding); otherwise registers the
 * press-only globalShortcut fallback and returns null.
 */
function bindCombo(
  combo: string,
  mod: UiohookModule | null,
  label: string,
  fallback: () => void
): KeyBinding | null {
  if (mod) {
    const binding = parseCombo(combo, mod.UiohookKey)
    if (!binding) console.warn(`Could not parse ${label} hotkey: ${combo}`)
    return binding
  }
  try {
    globalShortcut.register(combo, fallback)
  } catch {
    console.warn(`Invalid ${label} hotkey: ${combo}`)
  }
  return null
}

/** (Re-)binds all global shortcuts from settings. Safe to call repeatedly. */
export function applyHotkeys(settings: Settings, h: HotkeyHandlers): void {
  handlers = h
  const epoch = ++applyEpoch
  stopPortalHotkeys()
  globalShortcut.unregisterAll()
  clearHeldState()
  ptt = null
  toggleBinding = null
  toggleFallback = null
  pttFallback = null

  const mod = loadUiohook()

  if (settings.hotkeyToggle) {
    toggleFallback = makeFallbackDebouncer(() => handlers?.onToggle())
    toggleBinding = bindCombo(settings.hotkeyToggle, mod, 'toggle', () => toggleFallback?.pulse())
  }

  if (settings.hotkeyPtt) {
    // Fallback without uiohook: hold-to-talk becomes press-to-start / press-to-stop,
    // debounced against OS auto-repeat so holding it down fires onToggle once,
    // not on every repeat.
    pttFallback = makeFallbackDebouncer(() => handlers?.onToggle())
    ptt = bindCombo(settings.hotkeyPtt, mod, 'PTT', () => pttFallback?.pulse())
  }

  if (mod && (toggleBinding || ptt)) startUiohook(mod)

  if (process.platform === 'linux' && (settings.hotkeyToggle || settings.hotkeyPtt)) {
    tryStartPortalHotkeys(settings, {
      onToggle: () => handlers?.onToggle(),
      onPttDown: () => handlers?.onPttDown(),
      onPttUp: () => handlers?.onPttUp()
    }).then((active) => {
      if (epoch !== applyEpoch) {
        // A newer applyHotkeys call already superseded this attempt — don't
        // leave an orphaned portal session/listeners running.
        if (active) stopPortalHotkeys()
        return
      }
      if (active) stopFallbackHotkeys()
    })
  }
}

/** Tears down the globalShortcut/uiohook tier once the portal has bound
 *  successfully, so hotkeys don't fire twice. */
function stopFallbackHotkeys(): void {
  globalShortcut.unregisterAll()
  clearHeldState()
  if (uiohook && uiohookListening) {
    try {
      uiohook.uIOhook.stop()
    } catch {
      /* already stopped */
    }
    uiohookListening = false
  }
}

export function unregisterHotkeys(): void {
  applyEpoch++
  stopPortalHotkeys()
  stopFallbackHotkeys()
}

/** Cancels pending release-debounce timers so a stale one can't fire onPttUp
 *  (or resurrect toggleHeld) after hotkeys are unregistered or rebound. */
function clearHeldState(): void {
  if (toggleReleaseTimer) {
    clearTimeout(toggleReleaseTimer)
    toggleReleaseTimer = null
  }
  if (pttReleaseTimer) {
    clearTimeout(pttReleaseTimer)
    pttReleaseTimer = null
  }
  toggleHeld = false
  pttHeld = false
  toggleFallback?.clear()
  pttFallback?.clear()
}

function matchesBinding(e: UiohookKeyEvent, binding: KeyBinding): boolean {
  return (
    e.keycode === binding.keycode &&
    !!e.ctrlKey === binding.ctrl &&
    !!e.altKey === binding.alt &&
    !!e.shiftKey === binding.shift &&
    !!e.metaKey === binding.meta
  )
}

function startUiohook(mod: UiohookModule): void {
  if (uiohookListening) return
  uiohookListening = true
  mod.uIOhook.on('keydown', (e) => {
    // Toggle fires once per physical press, guarded the same way PTT guards
    // against repeat keydowns while a key is held. A pending release is
    // cancelled here too: if it fires, this keydown is a repeat artifact for
    // an already-held combo, not a fresh press.
    if (toggleBinding && matchesBinding(e, toggleBinding)) {
      if (toggleReleaseTimer) {
        clearTimeout(toggleReleaseTimer)
        toggleReleaseTimer = null
      } else if (!toggleHeld) {
        toggleHeld = true
        handlers?.onToggle()
      }
    }
    if (ptt && matchesBinding(e, ptt)) {
      if (pttReleaseTimer) {
        clearTimeout(pttReleaseTimer)
        pttReleaseTimer = null
      } else if (!pttHeld) {
        pttHeld = true
        handlers?.onPttDown()
      }
    }
  })
  mod.uIOhook.on('keyup', (e) => {
    if (toggleHeld && toggleBinding && e.keycode === toggleBinding.keycode) {
      toggleReleaseTimer = setTimeout(() => {
        toggleHeld = false
        toggleReleaseTimer = null
      }, REPEAT_DEBOUNCE_MS)
    }
    if (pttHeld && ptt && e.keycode === ptt.keycode) {
      pttReleaseTimer = setTimeout(() => {
        pttHeld = false
        pttReleaseTimer = null
        handlers?.onPttUp()
      }, REPEAT_DEBOUNCE_MS)
    }
  })
  mod.uIOhook.start()
}

/** Parses "Ctrl+Shift+Space" style combos into a uiohook keycode + modifiers. */
function parseCombo(combo: string, keyTable: Record<string, number>): KeyBinding | null {
  const parts = combo.split('+').map((p) => p.trim())
  const binding: KeyBinding = { keycode: -1, ctrl: false, alt: false, shift: false, meta: false }
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
