const BYTES_PER_SAMPLE = 2
const FRAME_MS = 20
// Brief energy dips (e.g. a stop consonant right at the start of an utterance)
// don't reset the onset counter as long as they're shorter than this — without
// it, natural speech cadence could delay or defeat onset detection.
const ONSET_GAP_TOLERANCE_MS = 300
const MIN_SPEECH_FRAMES = 3
const NOISE_FLOOR_PERCENTILE = 0.2
const NOISE_FLOOR_MULTIPLIER = 2.5
const RMS_MARGIN = 0.003
// Absolute floor/ceiling on the active-frame threshold, independent of the
// percentile estimate: a floor so pure digital silence (noise floor 0) still
// requires some real energy to count as speech, and a ceiling so a buffer
// that's uniformly loud start-to-end (no quiet frames to anchor a low
// percentile against) doesn't drive the threshold above the audio itself.
const MIN_ABSOLUTE_RMS = 0.008
const MAX_ABSOLUTE_RMS = 0.05

export interface VadResult {
  hasSpeech: boolean
  /** Byte offset of the first sustained-speech frame; 0 if speech starts at/near the buffer start or hasSpeech is false. */
  speechStartByte: number
}

function frameRms(pcm: Buffer, byteOffset: number, byteLength: number): number {
  const sampleCount = Math.floor(byteLength / BYTES_PER_SAMPLE)
  if (sampleCount <= 0) return 0
  let sumSquares = 0
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = pcm.readInt16LE(byteOffset + i * BYTES_PER_SAMPLE)
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))))
  return sortedAsc[idx]
}

/**
 * Stateless energy-based VAD over Int16 mono PCM. Self-calibrates its noise
 * floor from the given buffer alone (no cross-call state), since callers pass
 * a fresh trailing window on each tick.
 */
export function detectSpeech(pcm: Buffer, sampleRate = 16000): VadResult {
  const frameBytes = Math.max(
    BYTES_PER_SAMPLE,
    Math.round((sampleRate * FRAME_MS) / 1000) * BYTES_PER_SAMPLE
  )
  const frameCount = Math.ceil(pcm.length / frameBytes)
  if (frameCount === 0) return { hasSpeech: false, speechStartByte: 0 }

  const energies: number[] = new Array(frameCount)
  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * frameBytes
    const length = Math.min(frameBytes, pcm.length - offset)
    energies[f] = frameRms(pcm, offset, length)
  }

  const noiseFloor = percentile([...energies].sort((a, b) => a - b), NOISE_FLOOR_PERCENTILE)
  const threshold = Math.min(
    MAX_ABSOLUTE_RMS,
    Math.max(noiseFloor * NOISE_FLOOR_MULTIPLIER, MIN_ABSOLUTE_RMS) + RMS_MARGIN
  )

  const gapToleranceFrames = Math.max(1, Math.round(ONSET_GAP_TOLERANCE_MS / FRAME_MS))

  let consecutiveActive = 0
  let gapFrames = 0
  let pendingStartFrame = -1

  for (let f = 0; f < frameCount; f += 1) {
    if (energies[f] > threshold) {
      if (consecutiveActive === 0) pendingStartFrame = f
      consecutiveActive += 1
      gapFrames = 0
      if (consecutiveActive >= MIN_SPEECH_FRAMES) {
        return { hasSpeech: true, speechStartByte: pendingStartFrame * frameBytes }
      }
    } else if (consecutiveActive > 0) {
      gapFrames += 1
      if (gapFrames > gapToleranceFrames) {
        consecutiveActive = 0
        gapFrames = 0
      }
    }
  }

  return { hasSpeech: false, speechStartByte: 0 }
}
