import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A whisper run we can resolve on demand, so the test controls exactly when a
// partial vs. the final pass is "still transcribing".
interface Deferred {
  promise: Promise<{ text: string; segments: [] }>
  resolve: (text: string) => void
}
const runs: Deferred[] = []
const transcribeWavMock = vi.fn(() => {
  let resolve!: (v: { text: string; segments: [] }) => void
  const promise = new Promise<{ text: string; segments: [] }>((r) => (resolve = r))
  runs.push({ promise, resolve: (text) => resolve({ text, segments: [] }) })
  return promise
})

vi.mock('./whisper', () => ({ transcribeWav: () => transcribeWavMock() }))
vi.mock('./models', () => ({ modelPath: () => '/fake/model.bin' }))
vi.mock('./settings', () => ({
  getSettings: () => ({ model: 'base.en', language: 'en', forceCpu: false, vocabulary: [] })
}))
vi.mock('./vocabulary', () => ({
  buildInitialPrompt: () => '',
  applyVocabulary: (out: { text: string; segments: [] }) => out
}))

const { startRecording, stopRecording, appendChunk } = await import('./recording')

const BYTES_PER_SECOND = 16000 * 2
const PARTIAL_INTERVAL_MS = 2500

/** Flush enough microtask turns for the promise chain under test to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('stopRecording GPU scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runs.length = 0
    transcribeWavMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for an in-flight partial before running the final pass, so the two never overlap', async () => {
    startRecording(vi.fn())
    appendChunk(new ArrayBuffer(BYTES_PER_SECOND * 2)) // 2s of audio

    // Fire one partial tick; it starts a whisper run and stays pending.
    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS)
    expect(transcribeWavMock).toHaveBeenCalledTimes(1)

    // Stop while that partial is still transcribing.
    const stopped = stopRecording()
    await flush()
    // The final pass must NOT have started yet — it would contend for the GPU.
    expect(transcribeWavMock).toHaveBeenCalledTimes(1)

    // Once the partial finishes, the final pass runs on its own.
    runs[0].resolve('partial text')
    await flush()
    expect(transcribeWavMock).toHaveBeenCalledTimes(2)

    runs[1].resolve('final text')
    const result = await stopped
    expect(result.text).toBe('final text')
    expect(result.source).toBe('microphone')
  })
})
