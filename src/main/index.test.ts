import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appendSwitchMock = vi.fn()

// `requestSingleInstanceLock` always denies the lock so the rest of the
// startup chain (window/tray/hotkey/history bootstrap) never runs — this
// test only cares about the platform-gated sandbox switch at the top of the
// module, not the full app lifecycle.
vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: appendSwitchMock },
    requestSingleInstanceLock: vi.fn(() => false),
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
    exit: vi.fn(),
    getVersion: vi.fn()
  },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() }
}))

vi.mock('./history', () => ({ initHistory: vi.fn() }))
vi.mock('./hotkeys', () => ({ applyHotkeys: vi.fn(), unregisterHotkeys: vi.fn() }))
vi.mock('./ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('./llm', () => ({ warmupOllama: vi.fn() }))
vi.mock('./settings', () => ({ getSettings: vi.fn(() => ({})) }))
vi.mock('./status', () => ({ onStatus: vi.fn() }))
vi.mock('./tray', () => ({ createTray: vi.fn() }))

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
