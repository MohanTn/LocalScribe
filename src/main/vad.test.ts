import { describe, expect, it } from 'vitest'
import { detectSpeech } from './vad'

const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const FRAME_BYTES = Math.round(SAMPLE_RATE * 0.02) * 2 // 20ms frame

function silentPcm(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2)
}

function tonePcm(seconds: number, amplitude = 10000, freq = 440): Buffer {
  const samples = Math.round(seconds * SAMPLE_RATE)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE))
    buf.writeInt16LE(v, i * 2)
  }
  return buf
}

describe('detectSpeech', () => {
  it('classifies pure silence as no speech', () => {
    const result = detectSpeech(silentPcm(2), SAMPLE_RATE)
    expect(result.hasSpeech).toBe(false)
    expect(result.speechStartByte).toBe(0)
  })

  it('classifies a sustained loud tone as speech starting at the buffer start', () => {
    const result = detectSpeech(tonePcm(1), SAMPLE_RATE)
    expect(result.hasSpeech).toBe(true)
    expect(result.speechStartByte).toBeLessThan(BYTES_PER_SECOND * 0.1)
  })

  it('finds the speech onset boundary after leading silence, within one frame', () => {
    const pcm = Buffer.concat([silentPcm(1), tonePcm(1)])
    const result = detectSpeech(pcm, SAMPLE_RATE)
    expect(result.hasSpeech).toBe(true)
    expect(Math.abs(result.speechStartByte - BYTES_PER_SECOND)).toBeLessThanOrEqual(FRAME_BYTES)
  })

  it('does not trigger on an isolated single-frame energy blip', () => {
    const blip = tonePcm(0.02).subarray(0, FRAME_BYTES)
    const pcm = Buffer.concat([silentPcm(0.5), blip, silentPcm(1)])
    const result = detectSpeech(pcm, SAMPLE_RATE)
    expect(result.hasSpeech).toBe(false)
  })
})
