import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appendSwitchMock = vi.fn()
const requestSingleInstanceLockMock = vi.fn(() => false)
const whenReadyMock = vi.fn(() => new Promise(() => {}))

interface WindowMock {
  on: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  isVisible: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  setPosition: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  webContents: { setWindowOpenHandler: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
  handlers: Record<string, (...args: never[]) => void>
}

function createWindowMock(): WindowMock {
  const handlers: Record<string, (...args: never[]) => void> = {}
  return {
    on: vi.fn((event: string, cb: (...args: never[]) => void) => {
      handlers[event] = cb
    }),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    setPosition: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn() },
    handlers
  }
}

// Must be a real function (not an arrow function) so `new BrowserWindow(...)`
// in index.ts's constructor-style usage picks up its returned object.
const browserWindowMock = vi.fn(function BrowserWindowCtor() {
  return createWindowMock()
}) as unknown as ReturnType<typeof vi.fn> & { getAllWindows: ReturnType<typeof vi.fn> }
browserWindowMock.getAllWindows = vi.fn(() => [])

// `requestSingleInstanceLock` denies the lock by default so the rest of the
// startup chain (window/tray/hotkey/history bootstrap) never runs for the
// sandbox-switch tests below; the minimize-redirect test overrides it to
// actually exercise window creation.
vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: appendSwitchMock },
    requestSingleInstanceLock: requestSingleInstanceLockMock,
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: whenReadyMock,
    exit: vi.fn(),
    getVersion: vi.fn()
  },
  BrowserWindow: browserWindowMock,
  screen: { getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })) },
  shell: { openExternal: vi.fn() }
}))

vi.mock('./history', () => ({ initHistory: vi.fn() }))
vi.mock('./hotkeys', () => ({ applyHotkeys: vi.fn(), unregisterHotkeys: vi.fn() }))
vi.mock('./ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('./llm', () => ({ warmupOllama: vi.fn() }))
vi.mock('./models', () => ({ modelPath: vi.fn(() => '/fake/model.bin') }))
vi.mock('./settings', () => ({ getSettings: vi.fn(() => ({})) }))
vi.mock('./status', () => ({ onStatus: vi.fn() }))
vi.mock('./tray', () => ({ createTray: vi.fn() }))
vi.mock('./updater', () => ({ initUpdater: vi.fn(), checkForUpdates: vi.fn(() => Promise.resolve()) }))
vi.mock('./whisper-server', () => ({ ensureServer: vi.fn(() => Promise.resolve()), stopServer: vi.fn() }))

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('Linux sandbox switches', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    appendSwitchMock.mockClear()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('disables the Chromium sandbox and /dev/shm usage on Linux', async () => {
    setPlatform('linux')
    await import('./index')
    expect(appendSwitchMock).toHaveBeenCalledWith('no-sandbox')
    expect(appendSwitchMock).toHaveBeenCalledWith('disable-dev-shm-usage')
  })

  it('leaves the sandbox enabled on macOS', async () => {
    setPlatform('darwin')
    await import('./index')
    expect(appendSwitchMock).not.toHaveBeenCalled()
  })

  it('leaves the sandbox enabled on Windows', async () => {
    setPlatform('win32')
    await import('./index')
    expect(appendSwitchMock).not.toHaveBeenCalled()
  })
})

describe('minimize redirects to compact mode', () => {
  beforeEach(() => {
    vi.resetModules()
    browserWindowMock.mockClear()
    requestSingleInstanceLockMock.mockReturnValue(true)
    whenReadyMock.mockImplementation(() => Promise.resolve())
  })

  afterEach(() => {
    requestSingleInstanceLockMock.mockReturnValue(false)
    whenReadyMock.mockImplementation(() => new Promise(() => {}))
  })

  it('restores from the native minimize and shows the mini widget instead, on every platform', async () => {
    await import('./index')
    // Flush the app.whenReady().then(...) microtask so createWindow() runs.
    await Promise.resolve()
    await Promise.resolve()

    const mainWin = browserWindowMock.mock.results[0].value as WindowMock
    expect(mainWin.on).toHaveBeenCalledWith('minimize', expect.any(Function))

    mainWin.handlers['minimize']()

    expect(mainWin.restore).toHaveBeenCalled()
    expect(mainWin.hide).toHaveBeenCalled()

    const miniWin = browserWindowMock.mock.results[1].value as WindowMock
    expect(miniWin.show).toHaveBeenCalled()
  })

  it('restores a still-minimized main window when exiting mini mode', async () => {
    await import('./index')
    await Promise.resolve()
    await Promise.resolve()

    const mainWin = browserWindowMock.mock.results[0].value as WindowMock
    mainWin.handlers['minimize']() // enter mini mode

    // Simulate the Linux race: the WM ignored the in-handler restore(), so
    // the hidden window is still flagged minimized when the user expands.
    mainWin.restore.mockClear()
    mainWin.show.mockClear()
    mainWin.isMinimized.mockReturnValue(true)

    const { registerIpc } = await import('./ipc')
    // The mocked registerIpc accumulates calls across vi.resetModules() runs;
    // the last call is the one from this test's module instance.
    const windowActions = vi.mocked(registerIpc).mock.lastCall?.[2] as { exitMini: () => void }
    windowActions.exitMini()

    expect(mainWin.restore).toHaveBeenCalled()
    expect(mainWin.show).toHaveBeenCalled()
  })
})
