import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppStatus } from '../../shared/api'

// Compact remote-control view for the mini widget window (see main/index.ts's
// enterMiniMode). Mic capture stays in the (hidden) main window's renderer —
// this component only sends toggle intent and reflects status/result pushes
// broadcast from main, mirroring how the tray already drives recording.

const STATUS_LABEL: Record<AppStatus, string> = {
  idle: 'Ready',
  recording: 'Recording…',
  processing: 'Transcribing…',
  error: 'Error'
}

export default function MiniApp(): React.JSX.Element {
  const [status, setStatus] = useState<AppStatus>('idle')
  const [lastText, setLastText] = useState('')
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // The preload bridge is attached before this script runs, so it's normally
    // present immediately — this guard only covers a dev-time HMR reload of
    // the mini window landing before the bridge re-attaches.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubs: Array<() => void> = []
    let attempts = 0
    const MAX_ATTEMPTS = 50 // 50 x 100ms = 5s

    const trySetup = (): void => {
      if (cancelled) return
      if (!window.api) {
        if (++attempts >= MAX_ATTEMPTS) {
          // eslint-disable-next-line no-console
          console.warn('[LocalScribe] mini widget: preload bridge never appeared.')
          return
        }
        timer = setTimeout(trySetup, 100)
        return
      }
      unsubs = [
        window.api.on('status', (s) => setStatus(s as AppStatus)),
        window.api.on('transcribe:result', (text) => setLastText(text as string))
      ]
      // Pulls: this window can mount after a recording already started
      // elsewhere, or after a transcript already landed, so the pushes above
      // alone could leave it stuck on default state.
      void window.api.getStatus().then(setStatus).catch(() => undefined)
      void window.api.getLastTranscript().then(setLastText).catch(() => undefined)
    }

    trySetup()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      unsubs.forEach((unsub) => unsub())
    }
  }, [])

  const toggleRecording = useCallback(() => {
    void window.api.window.toggleRecording()
  }, [])

  const copy = useCallback(() => {
    window.api
      .copyText(lastText)
      .then(() => {
        setCopied(true)
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }, [lastText])

  const expand = useCallback(() => {
    void window.api.window.exitMini()
  }, [])

  const recording = status === 'recording'
  const processing = status === 'processing'

  return (
    <div className="mini-app">
      <button
        className={`mini-record ${recording ? 'recording' : ''}`}
        onClick={toggleRecording}
        disabled={processing}
        title={recording ? 'Stop recording' : 'Start recording'}
      >
        <span className="mini-record-core" />
      </button>

      <div className="mini-status">
        <span className={`status-dot status-${status}`} />
        <span className="mini-status-label">{STATUS_LABEL[status]}</span>
      </div>

      <button className="mini-action" onClick={copy} disabled={!lastText} title="Copy transcript">
        {copied ? '✓' : 'Copy'}
      </button>

      <button className="mini-action mini-expand" onClick={expand} title="Expand to full window">
        ⤢
      </button>
    </div>
  )
}
