import { useCallback, useEffect, useRef } from 'react'
import Sidebar from './components/Sidebar'
import TranscribeView from './components/TranscribeView'
import HistoryView from './components/HistoryView'
import SettingsView from './components/SettingsView'
import { MicRecorder } from './lib/recorder'
import { useStore, type View } from './store'
import type { AppStatus, UpdateStatus } from '../../shared/api'

// App owns the recording lifecycle (not TranscribeView) because recording can
// be triggered from anywhere — global hotkey, tray menu, PTT — even while the
// user is on the History or Settings tab.

// Shared message for guards that fire while the preload bridge is still
// warming up (dev/HMR or first paint). Kept in one place so start/stop
// wording stays consistent and tweakable.
const INIT_NOTICE = 'App is still initializing — please wait a moment.'

export default function App(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const notice = useStore((s) => s.notice)
  const version = useStore((s) => s.version)
  const ollamaMissingModel = useStore((s) => s.ollamaMissingModel)
  const ollamaPulling = useStore((s) => s.ollamaPulling)
  const ollamaPullFraction = useStore((s) => s.ollamaPullFraction)
  const updateStatus = useStore((s) => s.updateStatus)
  const recorderRef = useRef(new MicRecorder())
  const busyRef = useRef(false) // guards start/stop races
  const viaHotkeyRef = useRef(false)
  const lastLevelAt = useRef(0)

  const startRecording = useCallback(async (viaHotkey: boolean) => {
    const s = useStore.getState()
    // Ignore start requests while a file transcription is running: whisper is
    // busy and the status machine would flip between processing/recording.
    if (busyRef.current || s.recording || s.status === 'processing') return
    if (!window.api) {
      s.notify(INIT_NOTICE)
      return
    }
    busyRef.current = true
    try {
      const recorder = recorderRef.current
      recorder.onChunk = (pcm) => window.api.audio.chunk(pcm)
      recorder.onLevel = (level) => {
        // Throttle record-button ring re-renders to ~12fps.
        const now = performance.now()
        if (now - lastLevelAt.current > 80) {
          lastLevelAt.current = now
          useStore.getState().setLevel(level)
        }
      }
      await window.api.audio.start()
      await recorder.start(s.settings?.micDeviceId || undefined)
      viaHotkeyRef.current = viaHotkey
      s.setPartial('')
      s.setRecording(true)
      s.notify(null)
    } catch (err) {
      await window.api.audio.abort().catch(() => undefined)
      useStore.getState().notify(err instanceof Error ? err.message : String(err))
    } finally {
      busyRef.current = false
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const s = useStore.getState()
    if (busyRef.current || !s.recording) return
    if (!window.api) {
      s.notify(INIT_NOTICE)
      return
    }
    busyRef.current = true
    try {
      await recorderRef.current.stop()
      s.setRecording(false)
      s.setLevel(0)
      const { result, paste } = await window.api.audio.stop({
        autoPaste: viaHotkeyRef.current
      })
      const state = useStore.getState()
      state.setResult(result)
      state.setPartial('')
      if (paste && !paste.pasted && paste.reason) state.notify(paste.reason)
    } catch (err) {
      useStore.getState().setRecording(false)
      useStore.getState().notify(err instanceof Error ? err.message : String(err))
    } finally {
      busyRef.current = false
    }
  }, [])

  const toggleRecording = useCallback(
    (viaHotkey: boolean) => {
      if (useStore.getState().recording) void stopRecording()
      else void startRecording(viaHotkey)
    },
    [startRecording, stopRecording]
  )

  const installUpdate = useCallback(async () => {
    try {
      await window.api.update.install()
    } catch (err) {
      useStore.getState().notify(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const pullOllamaModel = useCallback(async (model: string) => {
    const s = useStore.getState()
    s.setOllamaPulling(true)
    s.setOllamaPullFraction(null)
    try {
      await window.api.pullOllamaModel(model)
      const done = useStore.getState()
      done.setOllamaMissingModel(null)
      done.setOllamaPulling(false)
      done.setOllamaPullFraction(null)
    } catch (err) {
      const failed = useStore.getState()
      failed.setOllamaPulling(false)
      failed.notify(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    // The preload bridge (`window.api`) is exposed by the Electron preload
    // script *before* renderer JS runs, but during HMR / dev restarts it can
    // be briefly undefined when this effect mounts. The effect's deps never
    // change (callbacks are useCallback([])), so a one-shot early-return
    // would silently disable all IPC subscriptions for the app's lifetime.
    // Instead, we poll for the bridge on a short timer (max ~5s) and attach
    // subscriptions as soon as it appears. Cleanup unsubscribes and stops
    // the timer.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubFns: Array<() => void> = []
    let attempts = 0
    const MAX_ATTEMPTS = 50 // 50 × 100ms = 5s

    const trySetup = (): void => {
      if (cancelled) return
      if (!window.api) {
        if (++attempts >= MAX_ATTEMPTS) {
          // Surface to the user — without IPC the app is largely dead.
          // eslint-disable-next-line no-console
          console.warn('[LocalScribe] preload bridge never appeared; IPC inactive.')
          useStore.getState().notify('Preload bridge never loaded — please restart the app.')
          return
        }
        timer = setTimeout(trySetup, 100)
        return
      }
      const s = useStore.getState()
      // Forward main-process errors to the user instead of swallowing them;
      // also log to console so developers see the stack in DevTools.
      void window.api.settings.get().then(s.setSettings).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[LocalScribe] settings:get failed:', err)
        s.notify(err instanceof Error ? err.message : String(err))
      })
      void window.api.models.list().then(s.setModels).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[LocalScribe] models:list failed:', err)
        s.notify(err instanceof Error ? err.message : String(err))
      })
      // Best-effort: the version badge just stays blank if this fails.
      void window.api.appVersion().then(s.setVersion).catch(() => undefined)
      // Best-effort: no Ollama/model configured is a normal, silent no-op here.
      void window.api.checkOllamaModel().then(s.setOllamaMissingModel).catch(() => undefined)
      // Pulls the current state instead of relying only on the 'update:status'
      // push, which can fire (and even finish) before this listener attaches.
      void window.api.update.status().then(s.setUpdateStatus).catch(() => undefined)

      unsubFns = [
        window.api.on('status', (status) => useStore.getState().setStatus(status as AppStatus)),
        window.api.on('models:progress', (p) => {
          const { id, fraction } = p as { id: string; fraction: number | null }
          useStore.getState().setModelProgress(id, fraction)
        }),
        window.api.on('transcribe:partial', (text) => useStore.getState().setPartial(text as string)),
        window.api.on('record:toggle', () => toggleRecording(true)),
        window.api.on('ptt:down', () => void startRecording(true)),
        window.api.on('ptt:up', () => void stopRecording()),
        window.api.on('navigate', (v) => useStore.getState().setView(v as View)),
        window.api.on('ollama:modelMissing', (model) => useStore.getState().setOllamaMissingModel(model as string)),
        window.api.on('llm:pullProgress', (p) => {
          const { fraction } = p as { model: string; fraction: number | null }
          useStore.getState().setOllamaPullFraction(fraction)
        }),
        window.api.on('update:status', (status) => useStore.getState().setUpdateStatus(status as UpdateStatus))
      ]
    }

    trySetup()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubFns.forEach((unsub) => unsub())
      unsubFns = []
    }
  }, [toggleRecording, startRecording, stopRecording])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="notice-stack">
          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <button className="notice-close" onClick={() => useStore.getState().notify(null)}>
                ✕
              </button>
            </div>
          )}
          {ollamaMissingModel && (
            <div className="notice" role="alert">
              {ollamaPulling ? (
                <>
                  <span>Pulling {ollamaMissingModel}…</span>
                  <progress value={ollamaPullFraction ?? undefined} max={1} />
                </>
              ) : (
                <>
                  <span>Ollama model &quot;{ollamaMissingModel}&quot; isn&apos;t downloaded.</span>
                  <button onClick={() => void pullOllamaModel(ollamaMissingModel)}>Pull now</button>
                  <button
                    className="notice-close"
                    onClick={() => useStore.getState().setOllamaMissingModel(null)}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          )}
          {updateStatus.state === 'downloading' && (
            <div className="notice" role="status">
              <span>Downloading update{updateStatus.version ? ` v${updateStatus.version}` : ''}…</span>
              <progress value={updateStatus.progress ?? undefined} max={1} />
            </div>
          )}
          {updateStatus.state === 'downloaded' && (
            <div className="notice" role="alert">
              <span>Update v{updateStatus.version} ready to install.</span>
              <button onClick={() => void installUpdate()}>Restart &amp; install</button>
            </div>
          )}
        </div>
        {view === 'transcribe' && <TranscribeView onToggleRecording={() => toggleRecording(false)} />}
        {view === 'history' && <HistoryView />}
        {view === 'settings' && <SettingsView />}
      </main>
      {version && <span className="version-badge">v{version}</span>}
    </div>
  )
}
