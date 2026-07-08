import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const spawnSyncMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', getPath: () => '/tmp' }
}))

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('gpuEnv', () => {
  beforeEach(() => vi.resetModules())

  it('maps the cuda backend to CUDA_VISIBLE_DEVICES', async () => {
    const { gpuEnv } = await import('./whisper')
    expect(gpuEnv('cuda', '1')).toEqual({ CUDA_VISIBLE_DEVICES: '1' })
  })

  it('maps the vulkan backend to GGML_VK_VISIBLE_DEVICES', async () => {
    const { gpuEnv } = await import('./whisper')
    expect(gpuEnv('vulkan', '0')).toEqual({ GGML_VK_VISIBLE_DEVICES: '0' })
  })

  it('returns an empty env for backends with no multi-device concept', async () => {
    const { gpuEnv } = await import('./whisper')
    expect(gpuEnv('metal', '0')).toEqual({})
    expect(gpuEnv('cpu', '0')).toEqual({})
  })

  it('returns an empty env when no device is requested', async () => {
    const { gpuEnv } = await import('./whisper')
    expect(gpuEnv('cuda', undefined)).toEqual({})
    expect(gpuEnv('cuda', '')).toEqual({})
  })
})

describe('listGpus', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setPlatform('linux')
  })

  afterEach(() => setPlatform(originalPlatform))

  it('parses nvidia-smi -L output on a cuda backend', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'nvidia-smi' && args[0] === '-L') {
        return {
          status: 0,
          stdout:
            'GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-aaaa)\n' +
            'GPU 1: NVIDIA T500 (UUID: GPU-bbbb)\n'
        }
      }
      return { status: 1 }
    })

    const { listGpus } = await import('./whisper')
    expect(listGpus()).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 3060' },
      { index: 1, name: 'NVIDIA T500' }
    ])
  })

  it('parses vulkaninfo --summary output on a vulkan backend, including a non-NVIDIA integrated GPU', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'nvidia-smi') return { status: 1 }
      if (cmd === 'vulkaninfo' && args[0] === '--summary') {
        return {
          status: 0,
          stdout:
            'Devices:\n' +
            '========\n' +
            'GPU0:\n' +
            '\tapiVersion     = 4206847 (1.3.255)\n' +
            '\tdeviceType     = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU\n' +
            '\tdeviceName     = NVIDIA GeForce RTX 3060\n' +
            'GPU1:\n' +
            '\tapiVersion     = 4206847 (1.3.255)\n' +
            '\tdeviceType     = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU\n' +
            '\tdeviceName     = Intel(R) UHD Graphics 630 (CFL GT2)\n'
        }
      }
      return { status: 1 }
    })

    const { listGpus } = await import('./whisper')
    expect(listGpus()).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 3060' },
      { index: 1, name: 'Intel(R) UHD Graphics 630 (CFL GT2)' }
    ])
  })

  it('returns an empty list on a cpu-only backend', async () => {
    spawnSyncMock.mockImplementation(() => ({ status: 1 }))
    const { listGpus } = await import('./whisper')
    expect(listGpus()).toEqual([])
  })

  it('returns an empty list on macOS (metal has no multi-device selection)', async () => {
    setPlatform('darwin')
    const { listGpus } = await import('./whisper')
    expect(listGpus()).toEqual([])
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})
