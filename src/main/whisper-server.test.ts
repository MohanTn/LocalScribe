import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const spawnSyncMock = vi.fn()
const existsSyncMock = vi.fn()
const httpGetMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}))

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  readFileSync: vi.fn()
}))

vi.mock('net', () => ({
  createServer: () => ({
    unref: vi.fn(),
    listen: (_port: number, _host: string, cb: () => void) => cb(),
    address: () => ({ port: 45678 }),
    close: (cb: () => void) => cb(),
    on: vi.fn()
  })
}))

vi.mock('http', () => ({
  default: {
    get: (...args: unknown[]) => httpGetMock(...args),
    request: vi.fn()
  }
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', getPath: () => '/tmp' }
}))

/** A fake whisper-server child process that never exits on its own. */
function fakeServerProc(): ChildProcessLike {
  const proc = new EventEmitter() as ChildProcessLike
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.exitCode = null // isServerAvailable() checks this — a real still-running process has null here
  return proc
}

interface ChildProcessLike extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  exitCode: number | null
  kill?: (signal: string) => void
}

describe('ensureServer GPU device handling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // nvidia-smi -L succeeds -> detectGpu() resolves to 'cuda' for every test here.
    spawnSyncMock.mockImplementation((cmd: string) => ({ status: cmd === 'nvidia-smi' ? 0 : 1 }))
    existsSyncMock.mockReturnValue(true) // pretend the whisper-server binary and model both exist
    httpGetMock.mockImplementation((_url: string, cb: (res: { resume: () => void }) => void) => {
      cb({ resume: () => {} })
      return { on: vi.fn(), setTimeout: vi.fn() }
    })
    spawnMock.mockImplementation(() => fakeServerProc())
  })

  it('sets CUDA_VISIBLE_DEVICES from the requested gpuDevice on a cuda backend', async () => {
    const { ensureServer } = await import('./whisper-server')
    await ensureServer('/models/base.bin', false, '1')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const spawnOpts = spawnMock.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOpts.env.CUDA_VISIBLE_DEVICES).toBe('1')
  })

  it('omits the device env var when gpuDevice is left blank', async () => {
    const { ensureServer } = await import('./whisper-server')
    await ensureServer('/models/base.bin', false, '')

    const spawnOpts = spawnMock.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOpts.env.CUDA_VISIBLE_DEVICES).toBeUndefined()
  })

  it('omits the device env var when forceCpu is set, even with a gpuDevice chosen', async () => {
    const { ensureServer } = await import('./whisper-server')
    await ensureServer('/models/base.bin', true, '1')

    const spawnOpts = spawnMock.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOpts.env.CUDA_VISIBLE_DEVICES).toBeUndefined()
  })

  it('is a no-op when called again with the same model/forceCpu/gpuDevice', async () => {
    const { ensureServer } = await import('./whisper-server')
    await ensureServer('/models/base.bin', false, '1')
    await ensureServer('/models/base.bin', false, '1')

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('restarts the server when gpuDevice changes, even if model/forceCpu stay the same', async () => {
    const { ensureServer } = await import('./whisper-server')
    await ensureServer('/models/base.bin', false, '1')
    await ensureServer('/models/base.bin', false, '0')

    expect(spawnMock).toHaveBeenCalledTimes(2)
    const secondSpawnOpts = spawnMock.mock.calls[1][2] as { env: Record<string, string> }
    expect(secondSpawnOpts.env.CUDA_VISIBLE_DEVICES).toBe('0')
  })
})
