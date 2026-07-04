import { create } from 'zustand'
import type {
  AppStatus,
  HistoryEntry,
  ModelInfo,
  Settings,
  TranscriptionResult,
  UpdateStatus
} from '../../shared/api'

export type View = 'transcribe' | 'history' | 'settings'

interface AppState {
  status: AppStatus
  view: View
  settings: Settings | null
  models: ModelInfo[]
  result: TranscriptionResult | null
  /** Live caption text while recording. */
  partial: string
  recording: boolean
  /** Mic level 0..1 for the record-button ring. */
  level: number
  history: HistoryEntry[]
  /** Transient, user-facing notice (errors, paste fallbacks). */
  notice: string | null
  /** App version shown in the UI corner; null until fetched from main. */
  version: string | null
  /** Configured Ollama model name if it isn't pulled yet, else null. */
  ollamaMissingModel: string | null
  ollamaPulling: boolean
  /** 0..1, or null while Ollama hasn't reported a size yet. */
  ollamaPullFraction: number | null
  updateStatus: UpdateStatus

  setStatus: (s: AppStatus) => void
  setView: (v: View) => void
  setSettings: (s: Settings) => void
  setModels: (m: ModelInfo[]) => void
  setModelProgress: (id: string, fraction: number | null) => void
  setResult: (r: TranscriptionResult | null) => void
  setPartial: (t: string) => void
  setRecording: (r: boolean) => void
  setLevel: (l: number) => void
  setHistory: (h: HistoryEntry[]) => void
  notify: (message: string | null) => void
  setVersion: (v: string) => void
  setOllamaMissingModel: (model: string | null) => void
  setOllamaPulling: (pulling: boolean) => void
  setOllamaPullFraction: (fraction: number | null) => void
  setUpdateStatus: (status: UpdateStatus) => void
}

export const useStore = create<AppState>((set) => ({
  status: 'idle',
  view: 'transcribe',
  settings: null,
  models: [],
  result: null,
  partial: '',
  recording: false,
  level: 0,
  history: [],
  notice: null,
  version: null,
  ollamaMissingModel: null,
  ollamaPulling: false,
  ollamaPullFraction: null,
  updateStatus: { state: 'idle' },

  setStatus: (status) => set({ status }),
  setView: (view) => set({ view }),
  setSettings: (settings) => set({ settings }),
  setModels: (models) => set({ models }),
  setModelProgress: (id, fraction) =>
    set((state) => ({
      models: state.models.map((m) =>
        m.id === id
          ? { ...m, progress: fraction ?? undefined, downloaded: fraction === null ? true : m.downloaded }
          : m
      )
    })),
  setResult: (result) => set({ result }),
  setPartial: (partial) => set({ partial }),
  setRecording: (recording) => set({ recording }),
  setLevel: (level) => set({ level }),
  setHistory: (history) => set({ history }),
  notify: (notice) => set({ notice }),
  setVersion: (version) => set({ version }),
  setOllamaMissingModel: (ollamaMissingModel) => set({ ollamaMissingModel }),
  setOllamaPulling: (ollamaPulling) => set({ ollamaPulling }),
  setOllamaPullFraction: (ollamaPullFraction) => set({ ollamaPullFraction }),
  setUpdateStatus: (updateStatus) => set({ updateStatus })
}))
