// Microphone capture. getUserMedia only exists in the renderer, so audio is
// captured here and streamed to the main process as 16 kHz mono Int16 PCM —
// exactly what whisper.cpp wants, so main never needs to resample.
//
// An AudioContext created at 16 kHz makes Chromium do the resampling from the
// device rate in native code; the worklet just forwards Float32 frames.

const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      // Copy: the underlying buffer is reused by the audio thread.
      this.port.postMessage(new Float32Array(channel))
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
`

function floatTo16(f32: Float32Array): ArrayBuffer {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer as ArrayBuffer
}

export class MicRecorder {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null

  /** Called with an RMS level (0..1) roughly every 128 samples batch. */
  onLevel: ((level: number) => void) | null = null
  onChunk: ((pcm: ArrayBuffer) => void) | null = null

  get active(): boolean {
    return this.ctx !== null
  }

  async start(deviceId?: string): Promise<void> {
    if (this.ctx) return
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      })
    } catch {
      throw new Error('Microphone access was denied. Check your system permissions.')
    }
    this.ctx = new AudioContext({ sampleRate: 16000 })
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await this.ctx.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const f32 = e.data
      // Level metering for the record button ring.
      if (this.onLevel) {
        let sum = 0
        for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
        this.onLevel(Math.min(1, Math.sqrt(sum / f32.length) * 4))
      }
      this.onChunk?.(floatTo16(f32))
    }
    source.connect(this.node)
    // Not connected to destination: capture only, no monitoring/echo.
  }

  async stop(): Promise<void> {
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined)
      this.ctx = null
    }
  }
}

export async function listMicrophones(): Promise<Array<{ id: string; label: string }>> {
  // Labels are only populated after permission has been granted at least once.
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}
