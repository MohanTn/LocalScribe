import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { convertToWav16k } from './ffmpeg'
import { addHistory, clearHistory, deleteHistory, searchHistory } from './history'
import { applyHotkeys, type HotkeyHandlers } from './hotkeys'
import { getMissingOllamaModel, polish, pullOllamaModel, warmupOllama } from './llm'
import { cancelDownload, deleteModel, downloadModel, listModels, modelPath } from './models'
import { autoPaste } from './paste'
import {
  abortRecording,
  appendChunk,
  isRecording,
  startRecording,
  stopRecording,
  tempTranscodeDir
} from './recording'
import { getSettings, updateSettings } from './settings'
import { setStatus } from './status'
import { checkForUpdates, getUpdateStatus, installUpdate } from './updater'
import { applyVocabulary, buildInitialPrompt } from './vocabulary'
import { detectGpu, transcribeWav, whisperBinary } from './whisper'
import type { Settings, StopOptions, TranscriptionResult } from '../shared/types'

// All handlers return { ok, data | error } so the renderer receives the exact
// user-facing message instead of Electron's "Error invoking remote method"
// wrapper. The preload unwraps this envelope back into a thrown Error.
type Envelope = { ok: true; data: unknown } | { ok: false; error: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: (...args: any[]) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Envelope> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function registerIpc(getWindow: () => BrowserWindow | null, hotkeyHandlers: HotkeyHandlers): void {
  const send = (channel: string, ...args: unknown[]): void => {
    getWindow()?.webContents.send(channel, ...args)
  }

  // Best-effort: lets the renderer offer a "Pull now" prompt instead of the
  // user only finding out the model is missing when Polish fails. Pushed via
  // an event (not just the on-mount query below) so a mid-session provider/
  // model switch in Settings is caught too.
  const notifyIfOllamaModelMissing = (llm: Settings['llm']): void => {
    getMissingOllamaModel(llm).then((model) => {
      if (model) send('ollama:modelMissing', model)
    })
  }

  // --- Models -------------------------------------------------------------
  handle('models:list', () => listModels())
  handle('models:download', async (id: string) => {
    const completed = await downloadModel(id, (mid, fraction) =>
      send('models:progress', { id: mid, fraction })
    )
    // Only announce completion for a real finish — not for duplicate download
    // requests or user cancellations.
    if (completed) send('models:progress', { id, fraction: null })
  })
  handle('models:cancel', (id: string) => cancelDownload(id))
  handle('models:delete', (id: string) => deleteModel(id))

  // --- Settings -----------------------------------------------------------
  handle('settings:get', () => getSettings())
  handle('settings:update', (patch: Partial<Settings>) => {
    const next = updateSettings(patch)
    applyHotkeys(next, hotkeyHandlers) // hotkey changes take effect immediately
    if (patch.llm) {
      warmupOllama(next.llm) // pick up a newly configured Ollama model right away
      notifyIfOllamaModelMissing(next.llm)
    }
    return next
  })

  // --- History --------------------------------------------------------------
  handle('history:search', (query: string) => searchHistory(query ?? ''))
  handle('history:delete', (id: number) => deleteHistory(id))
  handle('history:clear', () => clearHistory())

  // --- Engine info (for the Settings page) ---------------------------------
  handle('engine:info', () => ({
    backend: detectGpu(),
    binaryPath: whisperBinary()
  }))

  // --- App version (shown in the UI corner + used by the --version CLI flag)
  handle('app:version', () => app.getVersion())

  // --- Updates ----------------------------------------------------------------
  // 'update:getStatus' is a pull for the renderer's on-mount sync — the
  // 'update:status' push can fire (and even finish) before a fresh window has
  // subscribed to it.
  handle('update:getStatus', () => getUpdateStatus())
  handle('update:check', () => checkForUpdates())
  handle('update:install', () => installUpdate())

  // --- File transcription ---------------------------------------------------
  handle('file:pick', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio & Video',
          extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'wma', 'mp4', 'mkv', 'mov', 'webm', 'avi']
        }
      ]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  handle('transcribe:file', async (filePath: string): Promise<TranscriptionResult> => {
    const settings = getSettings()
    setStatus('processing')
    const dir = tempTranscodeDir()
    const wav = join(dir, 'input.wav')
    const t0 = Date.now()
    try {
      // Normalize any container/codec (including WAVs at other sample rates)
      // to 16kHz mono PCM WAV — the only input whisper.cpp decodes itself.
      await convertToWav16k(filePath, wav)
      const raw = await transcribeWav(wav, modelPath(settings.model), {
        language: settings.language,
        forceCpu: settings.forceCpu,
        initialPrompt: buildInitialPrompt(settings.vocabulary)
      })
      const out = applyVocabulary(raw, settings.vocabulary)
      const result: TranscriptionResult = {
        ...out,
        model: settings.model,
        elapsedMs: Date.now() - t0,
        source: basename(filePath)
      }
      addHistory({
        source: result.source,
        model: result.model,
        text: result.text,
        durationMs: result.segments.at(-1)?.end ?? 0
      })
      setStatus('idle')
      return result
    } catch (err) {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 4000)
      throw err
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // --- Microphone session ---------------------------------------------------
  handle('audio:start', () => {
    startRecording((text) => send('transcribe:partial', text))
    setStatus('recording')
  })

  // Chunks are fire-and-forget; ~10 messages/sec of small ArrayBuffers.
  ipcMain.on('audio:chunk', (_event, pcm: ArrayBuffer) => appendChunk(pcm))

  handle('audio:stop', async (opts: StopOptions) => {
    setStatus('processing')
    try {
      const result = await stopRecording()
      addHistory({
        source: result.source,
        model: result.model,
        text: result.text,
        durationMs: result.segments.at(-1)?.end ?? 0
      })
      const settings = getSettings()
      const paste =
        opts.autoPaste && settings.autoPaste && result.text
          ? await autoPaste(result.text)
          : null
      setStatus('idle')
      return { result, paste }
    } catch (err) {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 4000)
      throw err
    }
  })

  handle('audio:abort', () => {
    abortRecording()
    setStatus('idle')
  })

  handle('audio:isRecording', () => isRecording())

  // --- Post-processing -------------------------------------------------------
  handle('llm:polish', (text: string) => polish(text, getSettings().llm))
  handle('llm:checkOllamaModel', () => getMissingOllamaModel(getSettings().llm))
  handle('llm:pullOllamaModel', (model: string) =>
    pullOllamaModel(getSettings().llm, (fraction) => send('llm:pullProgress', { model, fraction }))
  )
  handle('paste:text', (text: string) => autoPaste(text))
  // Electron's clipboard module, not the renderer's navigator.clipboard —
  // the Async Clipboard API needs document focus/permission and fails
  // silently on some Linux sessions; writing from main sidesteps both.
  handle('clipboard:copy', (text: string) => clipboard.writeText(text))

  // --- Export ---------------------------------------------------------------
  handle('file:save', async (defaultName: string, content: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName })
    if (res.canceled || !res.filePath) return false
    writeFileSync(res.filePath, content, 'utf8')
    return true
  })
}
