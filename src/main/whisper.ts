import { spawn, spawnSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { cpus } from 'os'
import { delimiter, join } from 'path'
import { app } from 'electron'
import { isServerAvailable, transcribeViaServer } from './whisper-server'
import type { Segment, Word } from '../shared/types'

// ---------------------------------------------------------------------------
// Binary discovery
//
// transcribeWav() prefers the resident whisper-server (keeps the model loaded
// across jobs — no cold-start penalty). When the server isn't available it
// falls back to spawning the whisper.cpp CLI per job, which keeps idle memory
// near zero but pays the model-load cost each time.
// ---------------------------------------------------------------------------

function candidates(): string[] {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const names = [`whisper-cli${exe}`, `main${exe}`]
  const dirs = [
    // Packaged app: electron-builder copies vendor/whisper -> resources/bin
    join(process.resourcesPath ?? '', 'bin'),
    // Dev: scripts/setup-whisper.sh drops the binary into vendor/whisper
    join(app.getAppPath(), 'vendor', 'whisper')
  ]
  const found: string[] = []
  if (process.env.WHISPER_CPP_BIN) found.push(process.env.WHISPER_CPP_BIN)
  for (const dir of dirs) for (const name of names) found.push(join(dir, name))
  return found
}

let resolvedBinary: string | null = null

export function whisperBinary(): string | null {
  if (resolvedBinary && existsSync(resolvedBinary)) return resolvedBinary
  for (const c of candidates()) {
    if (c && existsSync(c)) {
      resolvedBinary = c
      return c
    }
  }
  // Last resort: a whisper-cli on PATH.
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
    if (dir && existsSync(p)) {
      resolvedBinary = p
      return p
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// GPU detection
//
// whisper.cpp decides its backend at *compile* time (CUDA / Vulkan / Metal /
// CPU) and, unlike llama.cpp, its CLI has no -ngl layer-count flag — a GPU
// build offloads the whole model by default. So "use GPU, fall back to CPU"
// means: build with GPU support when available (setup-whisper.sh does this),
// and pass --no-gpu at runtime when no usable GPU is present or the user
// forces CPU.
// ---------------------------------------------------------------------------

export type GpuBackend = 'metal' | 'cuda' | 'vulkan' | 'cpu'

let detected: GpuBackend | null = null

export function detectGpu(): GpuBackend {
  if (detected) return detected
  if (process.platform === 'darwin') {
    detected = 'metal' // Metal is available on all supported macOS hardware
  } else if (spawnSync('nvidia-smi', ['-L'], { windowsHide: true }).status === 0) {
    detected = 'cuda'
  } else if (spawnSync('vulkaninfo', ['--summary'], { windowsHide: true }).status === 0) {
    detected = 'vulkan'
  } else {
    detected = 'cpu'
  }
  return detected
}

export interface TranscribeOptions {
  language?: string
  forceCpu?: boolean
  /** Biases decoding toward these terms (see vocabulary.ts's buildInitialPrompt). */
  initialPrompt?: string
  /** Bypass whisper-server and spawn the CLI directly (used for benchmarking). */
  forceCli?: boolean
}

export interface WhisperOutput {
  text: string
  segments: Segment[]
}

interface WhisperJsonToken {
  text: string
  offsets: { from: number; to: number }
}

interface WhisperJsonSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: WhisperJsonToken[]
}

/** Runs whisper.cpp on a 16kHz mono WAV file and parses its JSON output. */
export async function transcribeWav(
  wavPath: string,
  modelPath: string,
  opts: TranscribeOptions = {}
): Promise<WhisperOutput> {
  // Use the resident whisper-server when available — model stays loaded between
  // transcriptions, avoiding the cold-start disk-read + GPU-alloc penalty.
  if (!opts.forceCli && isServerAvailable()) {
    try {
      return await transcribeViaServer(wavPath, opts)
    } catch (err) {
      console.warn('whisper-server transcription failed, falling back to CLI:', err)
    }
  }

  const bin = whisperBinary()
  if (!bin) {
    throw new Error(
      'whisper.cpp binary not found. Run scripts/setup-whisper.sh (or set WHISPER_CPP_BIN) and restart.'
    )
  }
  if (!existsSync(modelPath)) {
    throw new Error('The selected model is not downloaded yet. Pick a model in Settings and download it.')
  }

  const outBase = wavPath // whisper writes <outBase>.json
  const threads = Math.max(1, Math.min(8, cpus().length - 1))
  const backend = detectGpu()
  const useGpu = !opts.forceCpu && backend !== 'cpu'
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', opts.language || 'auto',
    '-t', String(threads),
    '-bs', '1',   // force greedy decoding; whisper.cpp's CLI defaults to beam_size 5
    '-oj',        // JSON output
    '-ojf',       // ...including token-level timestamps (word-level SRT export)
    '-of', outBase,
    '-np'         // no runtime prints, keep stderr small
  ]
  if (!useGpu) {
    args.push('-ng')
  } else if (backend === 'cuda' || backend === 'metal') {
    args.push('-fa') // flash attention; not reliably supported on the Vulkan backend
  }
  // NOTE: whisper.cpp's `-p` is short for `--processors`, not prompt — the
  // initial prompt only has a long-form flag.
  if (opts.initialPrompt) {
    args.push('--prompt', opts.initialPrompt)
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', (err) => reject(new Error(`Could not start whisper.cpp: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(friendlyWhisperError(stderr, code)))
    })
  })

  const jsonPath = `${outBase}.json`
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const segments: Segment[] = ((raw.transcription ?? []) as WhisperJsonSegment[]).map((s) => ({
      start: s.offsets.from,
      end: s.offsets.to,
      text: s.text.trim(),
      words: tokensToWords(s.tokens)
    }))
    const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
    return { text, segments }
  } finally {
    rmSync(jsonPath, { force: true })
  }
}

/** Collapse whisper sub-word tokens into whole words with timestamps. */
function tokensToWords(tokens?: WhisperJsonToken[]): Word[] | undefined {
  if (!tokens?.length) return undefined
  const words: Word[] = []
  for (const t of tokens) {
    // Skip special tokens like [_BEG_], [_TT_...] and entries whisper emitted
    // without timing data (JSON comes from an external tool — don't trust it).
    if (t.text.startsWith('[_') || !t.offsets) continue
    const startsWord = t.text.startsWith(' ') || words.length === 0
    if (startsWord) {
      words.push({ start: t.offsets.from, end: t.offsets.to, text: t.text.trim() })
    } else {
      const last = words[words.length - 1]
      last.text += t.text
      last.end = t.offsets.to
    }
  }
  return words.filter((w) => w.text.length > 0)
}

/** Map raw whisper.cpp stderr to actionable, user-facing messages. */
function friendlyWhisperError(stderr: string, code: number | null): string {
  if (/failed to load model/i.test(stderr)) {
    return 'The model file appears corrupted. Delete it in Settings and download it again.'
  }
  if (/out of memory|failed to allocate/i.test(stderr)) {
    return 'Not enough memory for this model. Try a smaller model (e.g. Base or Small).'
  }
  const tail = stderr.trim().split('\n').slice(-2).join(' ')
  return `Transcription failed (exit ${code}). ${tail || 'Try a different model or re-record.'}`
}
