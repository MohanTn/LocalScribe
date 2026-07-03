import type {
  AppStatus,
  HistoryEntry,
  ModelInfo,
  PasteOutcome,
  Settings,
  StopOptions,
  TranscriptionResult,
  VocabularyEntry
} from './types'

// The contract between preload (implementation) and renderer (consumer).
// Keeping it here means both tsconfig projects check against the same shape.

export type ReceiveChannel =
  | 'status'
  | 'models:progress'
  | 'transcribe:partial'
  | 'record:toggle'
  | 'ptt:down'
  | 'ptt:up'
  | 'navigate'
  | 'ollama:modelMissing'
  | 'llm:pullProgress'

export interface LocalScribeApi {
  models: {
    list: () => Promise<ModelInfo[]>
    download: (id: string) => Promise<void>
    cancel: (id: string) => Promise<void>
    delete: (id: string) => Promise<void>
  }
  settings: {
    get: () => Promise<Settings>
    update: (patch: Partial<Settings>) => Promise<Settings>
  }
  history: {
    search: (query: string) => Promise<HistoryEntry[]>
    delete: (id: number) => Promise<void>
    clear: () => Promise<void>
  }
  audio: {
    start: () => Promise<void>
    /** Raw 16kHz mono Int16 PCM from the renderer's AudioWorklet. */
    chunk: (pcm: ArrayBuffer) => void
    stop: (opts: StopOptions) => Promise<{ result: TranscriptionResult; paste: PasteOutcome | null }>
    abort: () => Promise<void>
    isRecording: () => Promise<boolean>
  }
  transcribeFile: (path: string) => Promise<TranscriptionResult>
  pickFile: () => Promise<string | null>
  saveFile: (defaultName: string, content: string) => Promise<boolean>
  polish: (text: string) => Promise<string>
  /** Name of the configured Ollama model if it isn't pulled yet, else null. */
  checkOllamaModel: () => Promise<string | null>
  pullOllamaModel: (model: string) => Promise<void>
  paste: (text: string) => Promise<PasteOutcome>
  engineInfo: () => Promise<{ backend: 'metal' | 'cuda' | 'cpu'; binaryPath: string | null }>
  appVersion: () => Promise<string>
  /** Resolves a dragged File object to its filesystem path. */
  pathForFile: (file: File) => string
  /** Subscribes to a main->renderer event. Returns an unsubscribe function. */
  on: (channel: ReceiveChannel, cb: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    api: LocalScribeApi
  }
}

// Re-export so the renderer can import all types from one place.
export type {
  AppStatus,
  HistoryEntry,
  ModelInfo,
  PasteOutcome,
  Settings,
  StopOptions,
  TranscriptionResult,
  VocabularyEntry
}
export type { Segment, Word } from './types'
