import { spawn } from 'child_process'
import { existsSync } from 'fs'

/**
 * Resolves the bundled ffmpeg binary (ffmpeg-static), falling back to a
 * system ffmpeg on PATH. ffmpeg-static's binary is unpacked from the asar
 * archive at package time (see electron-builder.yml asarUnpack).
 */
function ffmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const staticPath: string | null = require('ffmpeg-static')
    if (staticPath) {
      const real = staticPath.replace('app.asar', 'app.asar.unpacked')
      if (existsSync(real)) return real
    }
  } catch {
    /* fall through to system ffmpeg */
  }
  return 'ffmpeg'
}

/**
 * Converts any audio/video file to what whisper.cpp expects:
 * 16 kHz mono signed 16-bit PCM WAV.
 */
export function convertToWav16k(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output]
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', () =>
      reject(
        new Error(
          'FFmpeg is not available. Reinstall the app, or install ffmpeg and make sure it is on your PATH.'
        )
      )
    )
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      // Surface only the informative tail of ffmpeg's chatty stderr.
      const tail = stderr.trim().split('\n').slice(-3).join(' ')
      reject(new Error(`Could not read this file as audio. ${tail}`))
    })
  })
}
