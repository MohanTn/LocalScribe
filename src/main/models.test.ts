import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'localscribe-models-'))
const fetchMock = vi.fn()

// Model downloads must go through Electron's net.fetch (Chromium network
// stack), not Node's global fetch: undici ignores the OS proxy and system
// certificate store, which breaks downloads on Windows behind corporate
// proxies / antivirus TLS interception.
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

const { cancelDownload, deleteModel, downloadModel, listModels, modelPath } = await import('./models')

function okResponse(chunks: Uint8Array[]): Response {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    }
  })
  return {
    ok: true,
    status: 200,
    body,
    headers: new Headers({ 'content-length': String(total) })
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const m of listModels()) deleteModel(m.id)
})

afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('downloadModel', () => {
  it('rejects unknown model ids', async () => {
    await expect(downloadModel('nope', vi.fn())).rejects.toThrow('Unknown model "nope"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('streams via net.fetch, writes the file, and reports final progress', async () => {
    const data = new Uint8Array(1024).fill(7)
    fetchMock.mockResolvedValue(okResponse([data]))
    const onProgress = vi.fn()

    await expect(downloadModel('tiny', onProgress)).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(readFileSync(modelPath('tiny'))).toEqual(Buffer.from(data))
    expect(existsSync(modelPath('tiny') + '.part')).toBe(false)
    expect(onProgress).toHaveBeenLastCalledWith('tiny', 1)
    expect(listModels().find((m) => m.id === 'tiny')?.downloaded).toBe(true)
  })

  it('throws the friendly HTTP message and leaves no partial file on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, body: null } as unknown as Response)

    await expect(downloadModel('tiny', vi.fn())).rejects.toThrow('Download failed (HTTP 503)')
    expect(existsSync(modelPath('tiny'))).toBe(false)
    expect(existsSync(modelPath('tiny') + '.part')).toBe(false)
  })

  it('unwraps the cause of opaque network errors into an actionable message', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('net::ERR_PROXY_CONNECTION_FAILED') }))

    await expect(downloadModel('tiny', vi.fn())).rejects.toThrow(
      /fetch failed \(net::ERR_PROXY_CONNECTION_FAILED\).*proxy/
    )
  })

  it('treats cancellation as a non-error and cleans up the .part file', async () => {
    fetchMock.mockImplementation((_url: string, opts: { signal: AbortSignal }) => {
      cancelDownload('tiny')
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError', signal: opts.signal }))
    })

    await expect(downloadModel('tiny', vi.fn())).resolves.toBe(false)
    expect(existsSync(modelPath('tiny') + '.part')).toBe(false)
  })
})
