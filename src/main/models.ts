import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ModelInfo } from '../shared/types'

// GGML models hosted by the whisper.cpp project on Hugging Face.
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

const CATALOG: Array<{ id: string; label: string; approxSize: string }> = [
  { id: 'tiny', label: 'Tiny', approxSize: '75 MB' },
  { id: 'tiny.en', label: 'Tiny (English only)', approxSize: '75 MB' },
  { id: 'base', label: 'Base', approxSize: '142 MB' },
  { id: 'base.en', label: 'Base (English only)', approxSize: '142 MB' },
  { id: 'small', label: 'Small', approxSize: '466 MB' },
  { id: 'medium', label: 'Medium', approxSize: '1.5 GB' },
  { id: 'large-v3', label: 'Large v3', approxSize: '2.9 GB' },
  { id: 'large-v3-turbo', label: 'Turbo (large-v3)', approxSize: '1.5 GB' }
]

const active = new Map<string, AbortController>()
const progress = new Map<string, number>()

export function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function modelPath(id: string): string {
  return join(modelsDir(), `ggml-${id}.bin`)
}

export function listModels(): ModelInfo[] {
  return CATALOG.map((m) => ({
    ...m,
    downloaded: existsSync(modelPath(m.id)),
    progress: progress.get(m.id)
  }))
}

export function isValidModelId(id: string): boolean {
  return CATALOG.some((m) => m.id === id)
}

/**
 * Streams a model from Hugging Face to disk. Downloads to a ".part" file and
 * renames on completion so a partial download is never mistaken for a model.
 * Resolves true only when the file was fully downloaded (false for duplicate
 * requests and user cancellations).
 */
export async function downloadModel(
  id: string,
  onProgress: (id: string, fraction: number) => void
): Promise<boolean> {
  if (!isValidModelId(id)) throw new Error(`Unknown model "${id}"`)
  if (active.has(id)) return false // already downloading

  const controller = new AbortController()
  active.set(id, controller)
  progress.set(id, 0)
  const partFile = modelPath(id) + '.part'

  try {
    const res = await fetch(`${HF_BASE}/ggml-${id}.bin`, { signal: controller.signal })
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (HTTP ${res.status}). Check your internet connection.`)
    }
    const total = Number(res.headers.get('content-length') ?? 0)
    let received = 0
    let lastReported = 0

    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (total > 0) {
          const fraction = received / total
          progress.set(id, fraction)
          // Throttle IPC/renders: report in ≥0.5% steps, not per network chunk.
          if (fraction - lastReported >= 0.005 || fraction >= 1) {
            lastReported = fraction
            onProgress(id, fraction)
          }
        }
        controller.enqueue(chunk)
      }
    })

    await pipeline(
      Readable.fromWeb(res.body.pipeThrough(counter) as import('stream/web').ReadableStream),
      createWriteStream(partFile)
    )
    renameSync(partFile, modelPath(id))
    return true
  } catch (err) {
    rmSync(partFile, { force: true })
    if (isAbort(err)) return false // cancellation is not an error
    throw err
  } finally {
    active.delete(id)
    progress.delete(id)
  }
}

function isAbort(err: unknown): boolean {
  // fetch abort surfaces as DOMException AbortError; stream teardown can also
  // surface as Node's ABORT_ERR / premature close.
  const e = err as { name?: string; code?: string } | null
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || e?.code === 'ERR_STREAM_PREMATURE_CLOSE'
}

export function cancelDownload(id: string): void {
  active.get(id)?.abort()
}

export function deleteModel(id: string): void {
  if (!isValidModelId(id)) return
  rmSync(modelPath(id), { force: true })
}
