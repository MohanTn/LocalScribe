import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ReceiveChannel, LocalScribeApi } from '../shared/api'
import type { Settings, StopOptions } from '../shared/types'

// Context-isolated bridge. The renderer gets a narrow, typed API — no raw
// ipcRenderer, no Node. Every invoke unwraps the {ok,data|error} envelope the
// main process uses so user-facing error messages survive the IPC boundary.

const RECEIVE_CHANNELS: ReceiveChannel[] = [
  'status',
  'models:progress',
  'transcribe:partial',
  'transcribe:result',
  'record:toggle',
  'ptt:down',
  'ptt:up',
  'navigate',
  'ollama:modelMissing',
  'llm:pullProgress',
  'update:status',
  'models:benchmarkProgress'
]

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string }
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const api: LocalScribeApi = {
  models: {
    list: () => invoke('models:list'),
    download: (id) => invoke('models:download', id),
    cancel: (id) => invoke('models:cancel', id),
    delete: (id) => invoke('models:delete', id),
    benchmark: () => invoke('models:benchmark')
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch: Partial<Settings>) => invoke('settings:update', patch)
  },
  history: {
    search: (query) => invoke('history:search', query),
    delete: (id) => invoke('history:delete', id),
    clear: () => invoke('history:clear')
  },
  audio: {
    start: () => invoke('audio:start'),
    chunk: (pcm: ArrayBuffer) => ipcRenderer.send('audio:chunk', pcm),
    stop: (opts: StopOptions) => invoke('audio:stop', opts),
    abort: () => invoke('audio:abort'),
    isRecording: () => invoke('audio:isRecording')
  },
  transcribeFile: (path) => invoke('transcribe:file', path),
  pickFile: () => invoke('file:pick'),
  saveFile: (defaultName, content) => invoke('file:save', defaultName, content),
  polish: (text) => invoke('llm:polish', text),
  checkOllamaModel: () => invoke('llm:checkOllamaModel'),
  pullOllamaModel: (model) => invoke('llm:pullOllamaModel', model),
  paste: (text) => invoke('paste:text', text),
  copyText: (text) => invoke('clipboard:copy', text),
  engineInfo: () => invoke('engine:info'),
  appVersion: () => invoke('app:version'),
  getStatus: () => invoke('status:get'),
  getLastTranscript: () => invoke('transcribe:getLast'),
  update: {
    status: () => invoke('update:getStatus'),
    check: () => invoke('update:check'),
    install: () => invoke('update:install')
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  window: {
    enterMini: () => invoke('window:enterMini'),
    exitMini: () => invoke('window:exitMini'),
    toggleRecording: () => invoke('window:toggleRecording')
  },
  on: (channel, cb) => {
    if (!RECEIVE_CHANNELS.includes(channel)) {
      throw new Error(`Unknown channel: ${channel}`)
    }
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
