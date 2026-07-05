import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { createServer, type AddressInfo } from 'net'
import { cpus } from 'os'
import { delimiter, join } from 'path'
import { app } from 'electron'
import http from 'http'
import { detectGpu, type TranscribeOptions, type WhisperOutput } from './whisper'
import type { Segment, Word } from '../shared/types'

// ---------------------------------------------------------------------------
// Binary discovery — mirrors whisper.ts's candidates() for whisper-server
// ---------------------------------------------------------------------------

function serverCandidates(): string[] {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const name = `whisper-server${exe}`
  const dirs = [
    join(process.resourcesPath ?? '', 'bin'),
    join(app.getAppPath(), 'vendor', 'whisper')
  ]
  const found: string[] = []
  if (process.env.WHISPER_CPP_BIN) {
    found.push(process.env.WHISPER_CPP_BIN.replace(/whisper-cli/, 'whisper-server'))
  }
  for (const dir of dirs) found.push(join(dir, name))
  return found
}

function findServerBinary(): string | null {
  for (const c of serverCandidates()) {
    if (c && existsSync(c)) return c
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
    if (dir && existsSync(p)) return p
  }
  return null
}

// ---------------------------------------------------------------------------
// Free port finder (OS-assigned ephemeral port)
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

let serverProc: ChildProcess | null = null
let serverPort: number | null = null
let currentModel: string | null = null
let currentForceCpu: boolean | null = null
let startPromise: Promise<void> | null = null

export function isServerAvailable(): boolean {
  return serverProc !== null && serverProc.exitCode === null && serverPort !== null
}

// ---------------------------------------------------------------------------
// Start the server, or restart if model / forceCpu changed
// ---------------------------------------------------------------------------

async function waitForReady(port: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.resume()
          resolve()
        })
        req.on('error', reject)
        req.setTimeout(1000, () => {
          req.destroy()
          reject(new Error('timeout'))
        })
      })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('whisper-server did not become ready within 30 seconds')
}

function killServer(): void {
  if (serverProc) {
    serverProc.removeAllListeners()
    try { serverProc.kill('SIGTERM') } catch { /* already dead */ }
    serverProc = null
  }
  serverPort = null
  currentModel = null
  currentForceCpu = null
}

export async function ensureServer(modelPath: string, forceCpu: boolean): Promise<void> {
  // Already running with the right settings — no-op.
  if (isServerAvailable() && currentModel === modelPath && currentForceCpu === forceCpu) {
    return
  }

  // If a start is already in-flight, wait for it; it might match after all.
  if (startPromise) {
    await startPromise
    if (isServerAvailable() && currentModel === modelPath && currentForceCpu === forceCpu) return
  }

  // Stale: kill old server and start fresh.
  killServer()

  const bin = findServerBinary()
  if (!bin) {
    console.warn('whisper-server binary not found; transcription will use whisper-cli (cold start per job).')
    return
  }
  if (!existsSync(modelPath)) {
    console.warn('Model not downloaded; skipping whisper-server start.')
    return
  }

  startPromise = (async () => {
    const port = await findFreePort()
    const backend = detectGpu()
    const useGpu = !forceCpu && backend !== 'cpu'
    const threads = Math.max(1, Math.min(8, cpus().length - 1))

    const args = [
      '-m', modelPath,
      '-t', String(threads),
      '--host', '127.0.0.1',
      '--port', String(port)
    ]
    if (!useGpu) {
      args.push('-ng')
    } else if (backend === 'cuda' || backend === 'metal') {
      args.push('-fa')
    }

    const proc = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', () => {
      /* handled by exit */
    })

    // Wait for the server to be ready, or for the process to die.
    await Promise.race([
      waitForReady(port),
      new Promise<void>((_, reject) => {
        proc.on('exit', (code) => {
          reject(
            new Error(
              `whisper-server exited with code ${code}. ${stderr.trim().split('\n').slice(-3).join(' ')}`
            )
          )
        })
      })
    ])

    // Success — promote state.
    serverProc = proc
    serverPort = port
    currentModel = modelPath
    currentForceCpu = forceCpu

    // Clean up state on unexpected exit.
    proc.on('exit', () => {
      if (serverProc === proc) {
        serverProc = null
        serverPort = null
        currentModel = null
        currentForceCpu = null
      }
    })

    console.log(`whisper-server ready on port ${port} with model ${modelPath}`)
  })()

  try {
    await startPromise
  } finally {
    startPromise = null
  }
}

export function stopServer(): void {
  killServer()
  startPromise = null
}

// ---------------------------------------------------------------------------
// Upload a WAV through the resident server
// ---------------------------------------------------------------------------

interface ServerWord {
  word: string
  start: number
  end: number
  probability: number
}

interface ServerSegment {
  text: string
  start: number
  end: number
  words?: ServerWord[]
}

interface ServerResponse {
  text: string
  segments: ServerSegment[]
}

/** Collapse sub-word tokens (delimited by leading spaces) into whole words. */
function collapseWords(serverWords: ServerWord[]): Word[] {
  const words: Word[] = []
  for (const sw of serverWords) {
    const startsWord = sw.word.startsWith(' ') || words.length === 0
    if (startsWord) {
      words.push({
        start: Math.round(sw.start * 1000),
        end: Math.round(sw.end * 1000),
        text: sw.word.trim()
      })
    } else {
      const last = words[words.length - 1]
      last.text += sw.word
      last.end = Math.round(sw.end * 1000)
    }
  }
  return words.filter((w) => w.text.length > 0)
}

export async function transcribeViaServer(
  wavPath: string,
  opts: TranscribeOptions = {}
): Promise<WhisperOutput> {
  if (!isServerAvailable()) {
    throw new Error('whisper-server is not running')
  }

  const port = serverPort!
  const fileData = readFileSync(wavPath)
  const boundary = `----WhisperServer${Date.now()}`

  // Build multipart/form-data body manually (zero dependencies).
  const parts: Buffer[] = []
  const field = (name: string, value: string): void => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    )
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    )
  )
  parts.push(fileData)
  parts.push(Buffer.from('\r\n'))

  field('response_format', 'verbose_json')
  field('temperature', '0.0')
  field('beam_size', '1')
  if (opts.language) field('language', opts.language)
  if (opts.initialPrompt) field('prompt', opts.initialPrompt)

  parts.push(Buffer.from(`--${boundary}--\r\n`))
  const body = Buffer.concat(parts)

  const responseBody = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/inference',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length)
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => (data += chunk.toString()))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // Try to extract a JSON error message.
            let msg = `whisper-server returned ${res.statusCode}`
            try {
              const err = JSON.parse(data)
              if (err.error) msg = err.error
            } catch { /* not JSON */ }
            reject(new Error(msg))
          } else {
            resolve(data)
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(120_000, () => {
      req.destroy()
      reject(new Error('whisper-server request timed out'))
    })
    req.write(body)
    req.end()
  })

  const raw = JSON.parse(responseBody)

  // whisper-server returns errors as 200 + {"error":"..."} JSON
  if (raw.error) {
    throw new Error(raw.error as string)
  }

  const res = raw as ServerResponse
  const segments: Segment[] = res.segments.map((s) => ({
    start: Math.round(s.start * 1000),
    end: Math.round(s.end * 1000),
    text: s.text.trim(),
    words: s.words ? collapseWords(s.words) : undefined
  }))
  const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
  return { text, segments }
}
