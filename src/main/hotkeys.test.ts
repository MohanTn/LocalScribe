import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../shared/types'

const registerMock = vi.fn()
const unregisterAllMock = vi.fn()

vi.mock('electron', () => ({
  globalShortcut: {
    register: (...args: unknown[]) => registerMock(...args),
    unregisterAll: () => unregisterAllMock()
  }
}))

vi.mock('./hotkeysPortal', () => ({
  stopPortalHotkeys: vi.fn(),
  tryStartPortalHotkeys: vi.fn(async () => false)
}))

// uiohook-napi is an optionalDependency that can legitimately be missing
// (install failure on an unsupported platform); hotkeys.ts consumes it via
// the mockable ./uiohookLoader indirection. Each test controls whether the
// module "exists".
const fakeHook = new EventEmitter() as EventEmitter & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
fakeHook.start = vi.fn()
fakeHook.stop = vi.fn()
const uiohookModule = { uIOhook: fakeHook, UiohookKey: { F9: 67, Space: 57 } }
let uiohookAvailable = true

vi.mock('./uiohookLoader', () => ({
  loadUiohookModule: () => (uiohookAvailable ? uiohookModule : null)
}))

const settings = { hotkeyToggle: 'Ctrl+Shift+Space', hotkeyPtt: 'F9' } as Settings

function key(keycode: number): Record<string, unknown> {
  return { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
}

const originalPlatform = process.platform

describe('push-to-talk hotkey', () => {
  let handlers: { onToggle: ReturnType<typeof vi.fn<() => void>>; onPttDown: ReturnType<typeof vi.fn<() => void>>; onPttUp: ReturnType<typeof vi.fn<() => void>> }
  // Fresh module per test: loadUiohook() caches the require() result, so
  // present/absent scenarios need separate module instances.
  let hotkeys: typeof import('./hotkeys')

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    fakeHook.removeAllListeners()
    uiohookAvailable = true
    // The reported bug environment: packaged Windows build.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    handlers = { onToggle: vi.fn<() => void>(), onPttDown: vi.fn<() => void>(), onPttUp: vi.fn<() => void>() }
    vi.resetModules()
    hotkeys = await import('./hotkeys')
  })

  afterEach(() => {
    hotkeys.unregisterHotkeys()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('holds while the key is down and stops on release (uiohook available)', () => {
    hotkeys.applyHotkeys(settings, handlers)

    expect(fakeHook.start).toHaveBeenCalled()
    // With uiohook handling both hotkeys, nothing may fall back to the
    // press-only globalShortcut API — that fallback is what turns PTT into
    // a second toggle.
    expect(registerMock).not.toHaveBeenCalled()

    fakeHook.emit('keydown', key(67))
    expect(handlers.onPttDown).toHaveBeenCalledTimes(1)
    expect(handlers.onPttUp).not.toHaveBeenCalled()
    expect(handlers.onToggle).not.toHaveBeenCalled()

    fakeHook.emit('keyup', key(67))
    vi.advanceTimersByTime(80) // past the 70 ms repeat-artifact debounce
    expect(handlers.onPttUp).toHaveBeenCalledTimes(1)
  })

  it('ignores OS key-repeat artifacts while the key is held', () => {
    hotkeys.applyHotkeys(settings, handlers)

    fakeHook.emit('keydown', key(67))
    // Auto-repeat: rapid keyup+keydown pairs well inside the debounce window.
    for (let i = 0; i < 5; i++) {
      fakeHook.emit('keyup', key(67))
      vi.advanceTimersByTime(20)
      fakeHook.emit('keydown', key(67))
    }
    expect(handlers.onPttDown).toHaveBeenCalledTimes(1)
    expect(handlers.onPttUp).not.toHaveBeenCalled()

    fakeHook.emit('keyup', key(67))
    vi.advanceTimersByTime(80)
    expect(handlers.onPttUp).toHaveBeenCalledTimes(1)
  })

  it('fires toggle once per physical press without touching PTT handlers', () => {
    hotkeys.applyHotkeys(settings, handlers)

    const toggleKey = { keycode: 57, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }
    fakeHook.emit('keydown', toggleKey)
    fakeHook.emit('keyup', toggleKey)
    vi.advanceTimersByTime(80)
    fakeHook.emit('keydown', toggleKey)

    expect(handlers.onToggle).toHaveBeenCalledTimes(2)
    expect(handlers.onPttDown).not.toHaveBeenCalled()
  })

  it('degrades PTT to a globalShortcut toggle only when uiohook-napi is missing', async () => {
    uiohookAvailable = false
    vi.resetModules()
    hotkeys = await import('./hotkeys')

    hotkeys.applyHotkeys(settings, handlers)

    expect(fakeHook.start).not.toHaveBeenCalled()
    const pttCall = registerMock.mock.calls.find(([accel]) => accel === 'F9')
    expect(pttCall).toBeDefined()
    ;(pttCall![1] as () => void)()
    expect(handlers.onToggle).toHaveBeenCalledTimes(1)
    expect(handlers.onPttDown).not.toHaveBeenCalled()
  })
})
