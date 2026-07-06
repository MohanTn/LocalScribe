import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const spawnSyncMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}))

// Imported after the mocks above so media.ts picks up the mocked modules.
const { pauseMedia, resumeMedia } = await import('./media')

function fakeProc(closeCode: number, stdout = ''): EventEmitter & { stdout: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter }
  proc.stdout = new EventEmitter()
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
    proc.emit('close', closeCode)
  })
  return proc
}

/** `which <tool>` exits 0 when installed, non-zero otherwise. */
function mockWhich(installed: Record<string, boolean>): void {
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => ({
    status: installed[args[0]] ? 0 : 1
  }))
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('pauseMedia/resumeMedia on Linux', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('linux')
  })

  afterEach(() => setPlatform(originalPlatform))

  it('does nothing when no mixer tool is installed', async () => {
    mockWhich({ wpctl: false, pactl: false, amixer: false })

    await pauseMedia()
    await resumeMedia()

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prefers wpctl, mutes, and restores the original unmuted state', async () => {
    mockWhich({ wpctl: true, pactl: true, amixer: true })
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'get-volume') return fakeProc(0, 'Volume: 0.45')
      return fakeProc(0)
    })

    await pauseMedia()

    const muteCall = spawnMock.mock.calls.find((c) => c[0] === 'wpctl' && c[1][0] === 'set-mute')
    expect(muteCall).toBeDefined()
    expect(muteCall![1]).toEqual(['set-mute', '@DEFAULT_AUDIO_SINK@', '1'])
    expect(spawnMock.mock.calls.every((c) => c[0] === 'wpctl')).toBe(true) // never touches pactl/amixer

    spawnMock.mockClear()
    await resumeMedia()

    const unmuteCall = spawnMock.mock.calls.find((c) => c[0] === 'wpctl' && c[1][0] === 'set-mute')
    expect(unmuteCall![1]).toEqual(['set-mute', '@DEFAULT_AUDIO_SINK@', '0'])
  })

  it('restores muted (not unmuted) when the system was already muted before recording', async () => {
    mockWhich({ wpctl: true, pactl: false, amixer: false })
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'get-volume') return fakeProc(0, 'Volume: 0.45 [MUTED]')
      return fakeProc(0)
    })

    await pauseMedia()
    spawnMock.mockClear()
    await resumeMedia()

    const unmuteCall = spawnMock.mock.calls.find((c) => c[1][0] === 'set-mute')
    expect(unmuteCall![1]).toEqual(['set-mute', '@DEFAULT_AUDIO_SINK@', '1'])
  })

  it('falls back to pactl when wpctl is not installed', async () => {
    mockWhich({ wpctl: false, pactl: true, amixer: true })
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'get-sink-mute') return fakeProc(0, 'Mute: no')
      return fakeProc(0)
    })

    await pauseMedia()

    expect(spawnMock.mock.calls.some((c) => c[0] === 'pactl' && c[1][0] === 'set-sink-mute')).toBe(true)
    expect(spawnMock.mock.calls.some((c) => c[0] === 'amixer')).toBe(false)
  })

  it('falls back to amixer when neither wpctl nor pactl is installed', async () => {
    mockWhich({ wpctl: false, pactl: false, amixer: true })
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'Master' && !args.includes('mute') && !args.includes('unmute')) {
        return fakeProc(0, "Front Left: Playback 50 [50%] [on]")
      }
      return fakeProc(0)
    })

    await pauseMedia()

    expect(spawnMock.mock.calls.some((c) => c[0] === 'amixer' && c[1].includes('mute'))).toBe(true)
  })
})

describe('pauseMedia/resumeMedia on Windows', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('win32')
    spawnMock.mockImplementation(() => fakeProc(0))
  })

  afterEach(() => setPlatform(originalPlatform))

  it('sends the same mute-key toggle for both pause and resume', async () => {
    await pauseMedia()
    await resumeMedia()

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock.mock.calls[0][0]).toBe('powershell')
    expect(spawnMock.mock.calls[0][1].join(' ')).toMatch(/keybd_event/)
    expect(spawnMock.mock.calls[0][1].join(' ')).toMatch(/0xAD/)
  })
})

describe('pauseMedia/resumeMedia on macOS', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('darwin')
  })

  afterEach(() => setPlatform(originalPlatform))

  it('captures the original mute state and restores it (unmuted case)', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] as string
      if (script.includes('output muted of')) return fakeProc(0, 'false')
      return fakeProc(0)
    })

    await pauseMedia()

    const muteCall = spawnMock.mock.calls.find((c) => (c[1][1] as string).includes('set volume output muted'))
    expect(muteCall![1][1]).toContain('true')

    spawnMock.mockClear()
    await resumeMedia()

    const restoreCall = spawnMock.mock.calls.find((c) => (c[1][1] as string).includes('set volume output muted'))
    expect(restoreCall![1][1]).toBe('set volume output muted false')
  })

  it('restores muted (not unmuted) when the system was already muted before recording', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] as string
      if (script.includes('output muted of')) return fakeProc(0, 'true')
      return fakeProc(0)
    })

    await pauseMedia()
    spawnMock.mockClear()
    await resumeMedia()

    const restoreCall = spawnMock.mock.calls.find((c) => (c[1][1] as string).includes('set volume output muted'))
    expect(restoreCall![1][1]).toBe('set volume output muted true')
  })
})
