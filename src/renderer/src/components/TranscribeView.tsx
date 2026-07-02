import { useCallback, useEffect, useRef, useState } from 'react'
import { toSrt, toVtt } from '../lib/export'
import { useStore } from '../store'

interface Props {
  onToggleRecording: () => void
}

export default function TranscribeView({ onToggleRecording }: Props): React.JSX.Element {
  const status = useStore((s) => s.status)
  const result = useStore((s) => s.result)
  const partial = useStore((s) => s.partial)
  const recording = useStore((s) => s.recording)
  const level = useStore((s) => s.level)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const notify = useStore((s) => s.notify)
  const [dragOver, setDragOver] = useState(false)
  const [text, setText] = useState('')
  const [polishing, setPolishing] = useState(false)

  // Keep the editable textarea in sync when a new transcription lands.
  useEffect(() => {
    setText(result?.text ?? '')
  }, [result])

  // The instant recording stops, App.tsx clears the live "Listening…" caption
  // but the accurate full-buffer re-transcription can take several seconds
  // (see recording.ts). Seed the textarea with the last live partial so the
  // transcript doesn't appear to vanish while that runs; the effect above
  // overwrites it with the authoritative text once the final result lands.
  const wasRecording = useRef(false)
  useEffect(() => {
    if (wasRecording.current && !recording && partial) setText(partial)
    wasRecording.current = recording
  }, [recording, partial])

  const transcribePath = useCallback(
    async (path: string) => {
      try {
        notify(null)
        const res = await window.api.transcribeFile(path)
        useStore.getState().setResult(res)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err))
      }
    },
    [notify]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (!file) return
      void transcribePath(window.api.pathForFile(file))
    },
    [transcribePath]
  )

  const pick = useCallback(async () => {
    const path = await window.api.pickFile()
    if (path) void transcribePath(path)
  }, [transcribePath])

  const exportAs = useCallback(
    async (format: 'txt' | 'srt' | 'vtt') => {
      if (!result) return
      const base = result.source.replace(/\.[^.]+$/, '') || 'transcript'
      // .txt exports the (possibly user-edited) textarea; .srt/.vtt need the
      // original timestamped segments.
      const content =
        format === 'txt' ? text + '\n' : format === 'srt' ? toSrt(result.segments) : toVtt(result.segments)
      const saved = await window.api.saveFile(`${base}.${format}`, content)
      if (saved) notify(null)
    },
    [result, text, notify]
  )

  const doPolish = useCallback(async () => {
    if (!text) return
    setPolishing(true)
    try {
      const polished = await window.api.polish(text)
      setText(polished)
      notify(null)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      setPolishing(false)
    }
  }, [text, notify])

  const clear = useCallback(() => setText(''), [])

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text)
  }, [text])

  const paste = useCallback(async () => {
    const outcome = await window.api.paste(text)
    if (!outcome.pasted && outcome.reason) notify(outcome.reason)
  }, [text, notify])

  const selectedDownloaded = models.find((m) => m.id === settings?.model)?.downloaded
  const processing = status === 'processing'

  return (
    <div className="view">
      <header className="view-header">
        <h1>Transcribe</h1>
        <span className="muted">
          {settings ? `Model: ${settings.model}${selectedDownloaded ? '' : ' (not downloaded)'}` : ''}
        </span>
      </header>

      <div className="capture-row">
        {/* Signature element: the record button with a live level ring. */}
        <button
          className={`record-btn ${recording ? 'recording' : ''}`}
          onClick={onToggleRecording}
          disabled={processing}
          title={recording ? 'Stop recording' : 'Start recording'}
          style={{ ['--level' as string]: level }}
        >
          <span className="record-core" />
        </button>
        <div className="capture-text">
          <strong>{recording ? 'Listening…' : processing ? 'Transcribing…' : 'Record'}</strong>
          <span className="muted">
            {recording
              ? 'Click again (or press your hotkey) to stop and transcribe'
              : settings?.hotkeyToggle
                ? `Global hotkey: ${settings.hotkeyToggle}`
                : 'Set a global hotkey in Settings'}
          </span>
        </div>

        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => void pick()}
          role="button"
          tabIndex={0}
        >
          Drop an audio or video file here
          <span className="muted">or click to browse</span>
        </div>
      </div>

      {recording && (
        <div className="partial">
          <span className="live-dot" /> {partial || 'Listening for speech…'}
        </div>
      )}

      <textarea
        className="transcript"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={processing ? 'Transcribing…' : 'Your transcription will appear here.'}
        spellCheck={false}
      />

      <footer className="actions">
        <div className="action-group">
          <button onClick={() => void exportAs('txt')} disabled={!result}>
            Export .txt
          </button>
          <button onClick={() => void exportAs('srt')} disabled={!result}>
            Export .srt
          </button>
          <button onClick={() => void exportAs('vtt')} disabled={!result}>
            Export .vtt
          </button>
        </div>
        <div className="action-group">
          <button onClick={clear} disabled={!text}>
            Clear
          </button>
          <button onClick={copy} disabled={!text}>
            Copy
          </button>
          <button onClick={() => void paste()} disabled={!text}>
            Paste to app
          </button>
          <button className="primary" onClick={() => void doPolish()} disabled={!text || polishing}>
            {polishing ? 'Polishing…' : '✨ Polish'}
          </button>
        </div>
        {result && (
          <span className="muted meta">
            {result.source} · {result.model} · {(result.elapsedMs / 1000).toFixed(1)}s
          </span>
        )}
      </footer>
    </div>
  )
}
