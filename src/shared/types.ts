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
}

/** A user-defined correction applied to transcripts after whisper.cpp runs,
 *  e.g. { from: "lama 3.1", to: "Llama 3.1" } for terms whisper mishears or
 *  mis-spells (brand names, jargon, acronyms). Matching is case-insensitive
 *  and whole-word/phrase. */
export interface VocabularyEntry {
  from: string
  to: string
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
  llm: LlmSettings
  vocabulary: VocabularyEntry[]
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

export type UserError = { message: string; hint?: string }
