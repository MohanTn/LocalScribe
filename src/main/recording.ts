import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSettings } from './settings'
import { modelPath } from './models'
import { transcribeWav } from './whisper'
import { applyVocabulary, buildInitialPrompt } from './vocabulary'
import { detectSpeech } from './vad'
import type { TranscriptionResult } from '../shared/types'

// The renderer captures the microphone (getUserMedia needs a renderer) and
// streams 16 kHz mono Int16 PCM here over IPC. Main owns the byte buffer so a
// hidden/GC'd renderer view can never lose audio, and runs whisper.cpp on:
//   - a sliding window every few seconds  -> "partial" live captions
//   - the full buffer on stop             -> final result
// True token-streaming would need whisper.cpp's SDL stream example compiled
// in; the sliding-window approach gets sub-second-perceived latency without a
// native addon.

const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2 // Int16 mono
const PARTIAL_INTERVAL_MS = 2500
// The partial pass is a live-caption preview re-transcribed every tick, so it
// only needs recent context; the final pass always re-reads the full buffer.
// A shorter window means each partial does ~half the whisper work, so captions
// appear sooner and the GPU is freed faster (fewer overlaps with the final pass).
const PARTIAL_WINDOW_SEC = 10

let chunks: Buffer[] = []
let recording = false
let partialTimer: NodeJS.Timeout | null = null
// The promise of the partial pass currently running, or null when idle. Held
// (not just a boolean) so stopRecording can await it before the final pass —
// two whisper jobs overlapping on a small GPU run ~1.8x slower each.
let partialInFlight: Promise<void> | null = null
let startedAt = 0
// Snapshot of clipboard-derived terms for the current session, captured once
// at startRecording() and reused by every partial + the final pass — an
// intentional snapshot, not a live settings read, so a mid-recording toggle
// of settings.useClipboardContext never changes an in-flight session.
let sessionContextTerms: string[] = []

export function isRecording(): boolean {
  return recording
}

export function startRecording(onPartial: (text: string) => void, contextTerms: string[] = []): void {
  if (recording) return
  chunks = []
  recording = true
  startedAt = Date.now()
  sessionContextTerms = contextTerms
  partialTimer = setInterval(() => {
    // Skip a tick rather than queueing whisper runs when the previous partial
    // is still in flight — on a small GPU, overlapping jobs contend for VRAM.
    if (partialInFlight) return
    partialInFlight = emitPartial(onPartial).finally(() => {
      partialInFlight = null
    })
  }, PARTIAL_INTERVAL_MS)
}

export function appendChunk(pcm: ArrayBuffer): void {
  if (!recording) return
  chunks.push(Buffer.from(pcm))
}

export async function stopRecording(): Promise<TranscriptionResult> {
  if (!recording) throw new Error('Not recording.')
  recording = false
  if (partialTimer) clearInterval(partialTimer)
  partialTimer = null

  // Let any in-flight partial finish before the final pass so the two don't
  // contend for the GPU (measured ~1.8x slowdown each when overlapping on a
  // 4GB card). The partial's result is discarded — recording is already false.
  if (partialInFlight) {
    await partialInFlight
    partialInFlight = null
  }

  const pcm = Buffer.concat(chunks)
  chunks = []
  if (pcm.length < BYTES_PER_SECOND / 4) {
    throw new Error('Recording was too short — nothing to transcribe.')
  }
  const t0 = Date.now()
  const out = await runWhisperOnPcm(pcm)
  return {
    ...out,
    model: getSettings().model,
    elapsedMs: Date.now() - t0,
    source: 'microphone'
  }
}

export function abortRecording(): void {
  recording = false
  if (partialTimer) clearInterval(partialTimer)
  partialTimer = null
  // A partial may still be running; its result is dropped because recording is
  // now false. Clear the handle so the next session starts clean.
  partialInFlight = null
  chunks = []
  sessionContextTerms = []
}

/**
 * Concatenates only as many trailing chunks as needed to cover `minBytes`,
 * instead of the whole recording. `chunks` grows for the entire session, so
 * concatenating it in full on every partial tick would re-copy
 * already-transcribed audio and get slower as the recording gets longer even
 * though the sliding window itself is a fixed size.
 */
function tailBytes(bufs: Buffer[], minBytes: number): Buffer {
  let total = 0
  let start = bufs.length
  while (start > 0 && total < minBytes) {
    start -= 1
    total += bufs[start].length
  }
  return Buffer.concat(bufs.slice(start))
}

async function emitPartial(onPartial: (text: string) => void): Promise<void> {
  if (!recording) return
  const windowBytes = PARTIAL_WINDOW_SEC * BYTES_PER_SECOND
  const tail = tailBytes(chunks, windowBytes)
  if (tail.length < BYTES_PER_SECOND) return // wait for ≥1s of audio
  try {
    const window = tail.length > windowBytes ? tail.subarray(tail.length - windowBytes) : tail
    const vad = detectSpeech(window, SAMPLE_RATE)
    if (!vad.hasSpeech) return // pure silence this tick — skip the whisper call entirely
    const trimmed = vad.speechStartByte > 0 ? window.subarray(vad.speechStartByte) : window
    const out = await runWhisperOnPcm(trimmed)
    if (recording) onPartial(out.text)
  } catch {
    // Partials are best-effort; the final pass will surface real errors.
  }
}

async function runWhisperOnPcm(pcm: Buffer): Promise<{ text: string; segments: TranscriptionResult['segments'] }> {
  const settings = getSettings()
  const dir = mkdtempSync(join(tmpdir(), 'localscribe-'))
  const wav = join(dir, 'mic.wav')
  try {
    writeFileSync(wav, pcmToWav(pcm))
    const terms = [...settings.vocabulary, ...sessionContextTerms]
    const out = await transcribeWav(wav, modelPath(settings.model), {
      language: settings.language,
      forceCpu: settings.forceCpu,
      gpuDevice: settings.gpuDevice,
      initialPrompt: buildInitialPrompt(terms)
    })
    return applyVocabulary(out, terms)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Wraps raw Int16 mono PCM in a minimal 44-byte RIFF/WAVE header. */
function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function tempTranscodeDir(): string {
  return mkdtempSync(join(tmpdir(), 'localscribe-'))
}
