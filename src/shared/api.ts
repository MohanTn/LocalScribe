import type {
  AppStatus,
  BenchmarkResult,
  HistoryEntry,
  ModelInfo,
  PasteOutcome,
  Settings,
  StopOptions,
  TranscriptionResult,
  UpdateStatus,
  VocabularyEntry
} from './types'

// The contract between preload (implementation) and renderer (consumer).
// Keeping it here means both tsconfig projects check against the same shape.

export type ReceiveChannel =
  | 'status'
  | 'models:progress'
  | 'transcribe:partial'
  | 'transcribe:result'
  | 'record:toggle'
  | 'ptt:down'
  | 'ptt:up'
  | 'navigate'
  | 'ollama:modelMissing'
  | 'llm:pullProgress'
  | 'update:status'
  | 'models:benchmarkProgress'

export interface LocalScribeApi {
  models: {
    list: () => Promise<ModelInfo[]>
    download: (id: string) => Promise<void>
    cancel: (id: string) => Promise<void>
    delete: (id: string) => Promise<void>
    /** Transcribes a 30 s test clip with every downloaded model and returns timing stats. */
    benchmark: () => Promise<BenchmarkResult[]>
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
  /** Writes to the OS clipboard via Electron's clipboard module (main process). */
  copyText: (text: string) => Promise<void>
  engineInfo: () => Promise<{ backend: 'metal' | 'cuda' | 'vulkan' | 'cpu'; binaryPath: string | null }>
  appVersion: () => Promise<string>
  /** Current app status — pulled on mount since a surface that mounts after
   *  the fact (mini widget) would otherwise miss the 'status' push. */
  getStatus: () => Promise<AppStatus>
  /** Last final transcript text, for the same late-mount reason. */
  getLastTranscript: () => Promise<string>
  update: {
    /** Current status — pulled on mount since the push can fire before a
     *  fresh window subscribes to it. */
    status: () => Promise<UpdateStatus>
    /** Manual "Check for updates" — works even if autoUpdateCheck is off. */
    check: () => Promise<void>
    /** Quits and installs an already-downloaded update. */
    install: () => Promise<void>
  }
  /** Resolves a dragged File object to its filesystem path. */
  pathForFile: (file: File) => string
  /** Subscribes to a main->renderer event. Returns an unsubscribe function. */
  on: (channel: ReceiveChannel, cb: (...args: unknown[]) => void) => () => void
  window: {
    /** Hides the mini widget and restores the main window as it was. */
    exitMini: () => Promise<void>
    /** Same effect as the toggle hotkey, but never auto-pastes on completion —
     *  the mini widget is a manual record -> stop -> copy flow. */
    toggleRecording: () => Promise<void>
  }
}

declare global {
  interface Window {
    api: LocalScribeApi
  }
}

// Re-export so the renderer can import all types from one place.
export type {
  AppStatus,
  BenchmarkResult,
  HistoryEntry,
  ModelInfo,
  PasteOutcome,
  Settings,
  StopOptions,
  TranscriptionResult,
  UpdateStatus,
  VocabularyEntry
}
export type { Segment, Word } from './types'
