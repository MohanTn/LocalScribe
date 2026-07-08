import { statSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A whisper run we can resolve on demand, so the test controls exactly when a
// partial vs. the final pass is "still transcribing". Captures the temp WAV's
// on-disk size at call time (before runWhisperOnPcm's cleanup deletes it) so
// VAD-trimming tests can assert on how much audio actually reached whisper.
interface Deferred {
  promise: Promise<{ text: string; segments: [] }>
  resolve: (text: string) => void
  wavBytes: number
}
const runs: Deferred[] = []
const transcribeWavMock = vi.fn((wavPath: string) => {
  let resolve!: (v: { text: string; segments: [] }) => void
  const promise = new Promise<{ text: string; segments: [] }>((r) => (resolve = r))
  const wavBytes = statSync(wavPath).size
  runs.push({ promise, resolve: (text) => resolve({ text, segments: [] }), wavBytes })
  return promise
})

vi.mock('./whisper', () => ({ transcribeWav: (wavPath: string) => transcribeWavMock(wavPath) }))
vi.mock('./models', () => ({ modelPath: () => '/fake/model.bin' }))

// Mutable so individual tests can vary settings.vocabulary without redefining the mock.
let currentSettings = { model: 'base.en', language: 'en', forceCpu: false, vocabulary: [] as string[] }
vi.mock('./settings', () => ({ getSettings: () => currentSettings }))

const buildInitialPromptMock = vi.fn((_terms: string[]): string | undefined => '')
const applyVocabularyMock = vi.fn(
  (out: { text: string; segments: [] }, _terms: string[]) => out
)
vi.mock('./vocabulary', () => ({
  buildInitialPrompt: (terms: string[]) => buildInitialPromptMock(terms),
  applyVocabulary: (out: { text: string; segments: [] }, terms: string[]) => applyVocabularyMock(out, terms)
}))

const { startRecording, stopRecording, abortRecording, appendChunk } = await import('./recording')

const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const PARTIAL_INTERVAL_MS = 2500
const WAV_HEADER_BYTES = 44

/** Flush enough microtask turns for the promise chain under test to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** A non-silent Int16 mono PCM buffer, loud enough to clear the VAD's threshold. */
function toneArrayBuffer(seconds: number, amplitude = 10000, freq = 440): ArrayBuffer {
  const samples = Math.round(seconds * SAMPLE_RATE)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE))
    buf.writeInt16LE(v, i * 2)
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('stopRecording GPU scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runs.length = 0
    transcribeWavMock.mockClear()
    buildInitialPromptMock.mockClear()
    applyVocabularyMock.mockClear()
    currentSettings = { model: 'base.en', language: 'en', forceCpu: false, vocabulary: [] }
  })

  afterEach(() => {
    abortRecording()
    vi.useRealTimers()
  })

  it('waits for an in-flight partial before running the final pass, so the two never overlap', async () => {
    startRecording(vi.fn())
    appendChunk(toneArrayBuffer(2)) // 2s of non-silent audio

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

describe('VAD gating on the partial pass', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runs.length = 0
    transcribeWavMock.mockClear()
    buildInitialPromptMock.mockClear()
    applyVocabularyMock.mockClear()
    currentSettings = { model: 'base.en', language: 'en', forceCpu: false, vocabulary: [] }
  })

  afterEach(() => {
    abortRecording()
    vi.useRealTimers()
  })

  it('skips the partial whisper call when the trailing window is pure silence', async () => {
    startRecording(vi.fn())
    appendChunk(new ArrayBuffer(BYTES_PER_SECOND * 2)) // 2s of silence

    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS)
    expect(transcribeWavMock).not.toHaveBeenCalled()
  })

  it('trims leading silence out of the window before transcribing', async () => {
    startRecording(vi.fn())
    appendChunk(new ArrayBuffer(BYTES_PER_SECOND * 3)) // 3s silence
    appendChunk(toneArrayBuffer(2)) // 2s speech

    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS)
    expect(transcribeWavMock).toHaveBeenCalledTimes(1)

    const pcmBytes = runs[0].wavBytes - WAV_HEADER_BYTES
    // Untrimmed window would be 5s; trimmed should be close to just the 2s of speech.
    expect(pcmBytes).toBeLessThan(BYTES_PER_SECOND * 3)
    expect(pcmBytes).toBeGreaterThan(BYTES_PER_SECOND * 1.5)

    runs[0].resolve('trimmed text')
  })
})

describe('clipboard context terms', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runs.length = 0
    transcribeWavMock.mockClear()
    buildInitialPromptMock.mockClear()
    applyVocabularyMock.mockClear()
    currentSettings = { model: 'base.en', language: 'en', forceCpu: false, vocabulary: [] }
  })

  afterEach(() => {
    abortRecording()
    vi.useRealTimers()
  })

  it('merges settings.vocabulary and session context terms, vocabulary first', async () => {
    currentSettings.vocabulary = ['Ollama']
    startRecording(vi.fn(), ['userId', 'fetchData'])
    appendChunk(toneArrayBuffer(2))

    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS)
    expect(transcribeWavMock).toHaveBeenCalledTimes(1)

    const expectedTerms = ['Ollama', 'userId', 'fetchData']
    expect(buildInitialPromptMock).toHaveBeenCalledWith(expectedTerms)

    runs[0].resolve('partial text')
    await flush()
    expect(applyVocabularyMock).toHaveBeenCalledWith(expect.anything(), expectedTerms)
  })

  it('passes just settings.vocabulary when startRecording is called without context terms', async () => {
    currentSettings.vocabulary = ['Ollama']
    startRecording(vi.fn())
    appendChunk(toneArrayBuffer(2))

    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS)
    expect(buildInitialPromptMock).toHaveBeenCalledWith(['Ollama'])

    runs[0].resolve('partial text')
  })

  it('clears session context terms on abort, so the next session starts clean', async () => {
    startRecording(vi.fn(), ['leftoverTerm'])
    abortRecording()

    startRecording(vi.fn())
    appendChunk(toneArrayBuffer(2))

    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS)
    expect(buildInitialPromptMock).toHaveBeenCalledWith([])

    runs[0].resolve('partial text')
  })
})
