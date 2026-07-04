import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const spawnSyncMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() }
}))

// Imported after the mocks above so paste.ts picks up the mocked modules.
const { autoPaste } = await import('./paste')

/** `which <tool>` exits 0 when installed, non-zero otherwise. */
function mockWhich(installed: Record<string, boolean>): void {
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => ({
    status: installed[args[0]] ? 0 : 1
  }))
}

/** `<tool> key ...` exits 0 on success, non-zero on failure, via a fake child process. */
function mockKeystrokeTools(succeeds: Record<string, boolean>): void {
  spawnMock.mockImplementation((cmd: string) => {
    const proc = new EventEmitter()
    queueMicrotask(() => proc.emit('close', succeeds[cmd] ? 0 : 1))
    return proc
  })
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('autoPaste on Linux', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('linux')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.unstubAllEnvs()
  })

  it('uses ydotool on Wayland when it succeeds, without trying xdotool', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    mockWhich({ ydotool: true, xdotool: true })
    mockKeystrokeTools({ ydotool: true, xdotool: true })

    const outcome = await autoPaste('hello')

    expect(outcome).toEqual({ copied: true, pasted: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith('ydotool', expect.anything(), expect.anything())
  })

  it('falls back to xdotool on Wayland when ydotool fails (e.g. ydotoold not running)', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    mockWhich({ ydotool: true, xdotool: true })
    mockKeystrokeTools({ ydotool: false, xdotool: true })

    const outcome = await autoPaste('hello')

    expect(outcome).toEqual({ copied: true, pasted: true })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('reports an actionable reason when both tools are installed but fail on Wayland', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    mockWhich({ ydotool: true, xdotool: true })
    mockKeystrokeTools({ ydotool: false, xdotool: false })

    const outcome = await autoPaste('hello')

    expect(outcome.copied).toBe(true)
    expect(outcome.pasted).toBe(false)
    expect(outcome.reason).toMatch(/ydotoold/)
  })

  it('reports the install-a-tool reason when neither tool is present', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    mockWhich({ ydotool: false, xdotool: false })

    const outcome = await autoPaste('hello')

    expect(outcome.pasted).toBe(false)
    expect(outcome.reason).toMatch(/Install xdotool/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prefers xdotool over ydotool on X11 (non-Wayland)', async () => {
    // Explicitly clear Wayland signals — this suite may itself run on a
    // Wayland host, and real env vars would otherwise leak into the test.
    vi.stubEnv('XDG_SESSION_TYPE', 'x11')
    vi.stubEnv('WAYLAND_DISPLAY', '')
    mockWhich({ ydotool: true, xdotool: true })
    mockKeystrokeTools({ ydotool: true, xdotool: true })

    const outcome = await autoPaste('hello')

    expect(outcome).toEqual({ copied: true, pasted: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith('xdotool', expect.anything(), expect.anything())
  })
})
