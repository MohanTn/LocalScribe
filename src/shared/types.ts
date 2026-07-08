// Types shared across main / preload / renderer. This file must stay free of
// runtime imports so it can be consumed from every process.

export type AppStatus = 'idle' | 'recording' | 'processing' | 'error'

export interface ModelInfo {
  id: string
  label: string
  /** Approximate download size, for the UI before we know the real size. */
  approxSize: string
  downloaded: boolean
  /** 0..1 while a download is in flight, undefined otherwise. */
  progress?: number
}

export interface Word {
  /** milliseconds from start of audio */
  start: number
  end: number
  text: string
}

export interface Segment {
  start: number
  end: number
  text: string
  /** Token-level timestamps from whisper.cpp, used for word-level SRT export. */
  words?: Word[]
}

export interface TranscriptionResult {
  text: string
  segments: Segment[]
  model: string
  /** Wall-clock transcription time in ms. */
  elapsedMs: number
  /** File name or "microphone". */
  source: string
}

export interface HistoryEntry {
  id: number
  createdAt: string
  source: string
  model: string
  text: string
  durationMs: number
}

export type LlmProvider = 'none' | 'anthropic' | 'openai' | 'ollama'

/** 'default' fixes grammar/formatting; 'coding' rewrites the transcript into an
 *  actionable prompt suitable for handing to an LLM coding agent. */
export type PolishPromptMode = 'default' | 'coding'

export interface LlmSettings {
  provider: LlmProvider
  apiKey: string
  /** Only used by the Ollama provider (e.g. http://localhost:11434). */
  endpoint: string
  /** Empty string = provider default. */
  model: string
  promptMode: PolishPromptMode
  /** Run Polish automatically on every new transcript instead of requiring the button. */
  autoPolish: boolean
}

export interface Settings {
  /** whisper model id, e.g. "base" or "large-v3-turbo" */
  model: string
  language: string
  autoPaste: boolean
  /** Electron accelerator, e.g. "CommandOrControl+Shift+R". Empty disables. */
  hotkeyToggle: string
  /** Push-to-talk combo, e.g. "Ctrl+Shift+Space". Empty disables. */
  hotkeyPtt: string
  /** MediaDevices deviceId; empty = system default. */
  micDeviceId: string
  /** Force CPU even when a GPU is available. */
  forceCpu: boolean
  /** Index of the GPU device to use (as reported by nvidia-smi/vulkaninfo),
   *  e.g. "0" or "1". Empty string = no restriction (whisper.cpp's default
   *  device). Ignored when forceCpu is set or the backend is metal/cpu. */
  gpuDevice: string
  /** Pause background media (YouTube, Spotify, etc.) while recording, resuming on stop. */
  pauseMediaOnRecord: boolean
  /** Read the clipboard once at the start of each recording and bias whisper
   *  toward code-like identifiers found in it (see src/main/clipboardContext.ts).
   *  Off by default — passive clipboard reads can surface sensitive text. */
  useClipboardContext: boolean
  /** Silently check for a new release on startup (see src/main/updater.ts). */
  autoUpdateCheck: boolean
  llm: LlmSettings
  /** Correct spellings of terms whisper.cpp tends to mishear (brand names,
   *  jargon, acronyms), e.g. "Ollama", "whisper.cpp". Fed to whisper as a
   *  decoding hint and used to fuzzy-correct near-misses after the fact —
   *  see src/main/vocabulary.ts. */
  vocabulary: string[]
}

/**
 * 'unsupported' covers dev builds, .deb installs, and macOS (no published
 * mac installer yet) — platforms/build types electron-updater can't self-update.
 */
export type UpdateState =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** Release version; set for 'downloading' and 'downloaded'. */
  version?: string
  /** 0..1, only set during 'downloading'. */
  progress?: number
  /** User-facing explanation; only set for 'error'. */
  message?: string
}

export interface PasteOutcome {
  copied: boolean
  pasted: boolean
  /** User-facing explanation when pasted=false (e.g. xdotool missing). */
  reason?: string
}

/** Renderer -> main audio session stop options. */
export interface StopOptions {
  /** Paste the final text into the previously focused app (hotkey flows). */
  autoPaste: boolean
}

export interface BenchmarkResult {
  modelId: string
  modelLabel: string
  /** Wall-clock transcription time in ms. */
  elapsedMs: number
  /** Test audio duration in ms. */
  audioDurationMs: number
  /** Real-time factor (elapsed / duration); lower is faster. <1 = faster than real-time. */
  realTimeFactor: number
  success: boolean
  /** Present only when success is false. */
  error?: string
}

export type UserError = { message: string; hint?: string }
