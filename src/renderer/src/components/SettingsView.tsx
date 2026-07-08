import { useCallback, useEffect, useRef, useState } from 'react'
import { listMicrophones } from '../lib/recorder'
import { useStore } from '../store'
import type { BenchmarkResult, Settings, UpdateStatus } from '../../../shared/api'

// ---- Hotkey capture ---------------------------------------------------------

/** Maps a KeyboardEvent to an Electron accelerator string, e.g. Ctrl+Shift+R. */
function acceleratorFrom(e: React.KeyboardEvent): string | null {
  const key = e.key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null // modifier alone
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  const named: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc'
  }
  parts.push(named[key] ?? (key.length === 1 ? key.toUpperCase() : key))
  return parts.join('+')
}

function HotkeyInput(props: {
  value: string
  placeholder: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const [listening, setListening] = useState(false)
  return (
    <input
      className={`hotkey-input ${listening ? 'listening' : ''}`}
      readOnly
      value={listening ? 'Press keys… (Backspace clears)' : props.value || props.placeholder}
      onFocus={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        e.preventDefault()
        if (e.key === 'Backspace' || e.key === 'Delete') {
          props.onChange('')
          e.currentTarget.blur()
          return
        }
        const acc = acceleratorFrom(e)
        if (acc) {
          props.onChange(acc)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

// ---- Settings page ------------------------------------------------------------

function updateStatusText(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'not-available':
      return "You're up to date."
    case 'downloading':
      return `Downloading update${status.version ? ` v${status.version}` : ''}…`
    case 'downloaded':
      return `Update v${status.version} ready — restart to install.`
    case 'error':
      return status.message ?? 'Update check failed.'
    default:
      return null
  }
}

export default function SettingsView(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const version = useStore((s) => s.version)
  const updateStatus = useStore((s) => s.updateStatus)
  const setSettings = useStore((s) => s.setSettings)
  const setModels = useStore((s) => s.setModels)
  const notify = useStore((s) => s.notify)
  const benchmarkProgress = useStore((s) => s.benchmarkProgress)
  const benchmarkResults = useStore((s) => s.benchmarkResults)
  const setBenchmarkProgress = useStore((s) => s.setBenchmarkProgress)
  const setBenchmarkResults = useStore((s) => s.setBenchmarkResults)
  const [mics, setMics] = useState<Array<{ id: string; label: string }>>([])
  const [engine, setEngine] = useState<{ backend: string; binaryPath: string | null } | null>(null)
  const [gpus, setGpus] = useState<Array<{ index: number; name: string }>>([])
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  useEffect(() => {
    void listMicrophones().then(setMics).catch(() => setMics([]))
    void window.api.engineInfo().then(setEngine)
    void window.api.listGpus().then(setGpus).catch(() => setGpus([]))
  }, [])

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings(await window.api.settings.update(patch))
    },
    [setSettings]
  )

  const download = useCallback(
    async (id: string) => {
      try {
        await window.api.models.download(id)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err))
      }
      setModels(await window.api.models.list())
    },
    [setModels, notify]
  )

  const removeModel = useCallback(
    async (id: string) => {
      await window.api.models.delete(id)
      setModels(await window.api.models.list())
    },
    [setModels]
  )

  // Local copy so typing (which includes transient states like a trailing
  // comma) isn't fought by the settings round-trip on every keystroke; only
  // resynced from settings while the field isn't focused, so it still picks
  // up the value once the async settings load completes.
  const [vocabText, setVocabText] = useState(() => settings?.vocabulary.join(', ') ?? '')
  const vocabFocused = useRef(false)

  useEffect(() => {
    if (!vocabFocused.current) setVocabText(settings?.vocabulary.join(', ') ?? '')
  }, [settings?.vocabulary])

  const commitVocabulary = useCallback(() => {
    vocabFocused.current = false
    const terms = vocabText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    setVocabText(terms.join(', '))
    void update({ vocabulary: terms })
  }, [vocabText, update])

  const runBenchmark = useCallback(async () => {
    setBenchmarkResults(null)
    setBenchmarkProgress('Starting benchmark…')
    try {
      const results = await window.api.models.benchmark()
      setBenchmarkResults(results)
      setBenchmarkProgress(null)
    } catch (err) {
      setBenchmarkProgress(null)
      notify(err instanceof Error ? err.message : String(err))
    }
  }, [setBenchmarkProgress, setBenchmarkResults, notify])

  // Listen for benchmark progress events pushed by main while the handler runs.
  useEffect(() => {
    return window.api.on('models:benchmarkProgress', (payload) => {
      const p = payload as { count: number; total: number; modelId: string | null; modelLabel: string | null }
      if (p.modelId) {
        setBenchmarkProgress(`Benchmarking ${p.modelLabel} (${p.count}/${p.total})…`)
      }
    })
  }, [setBenchmarkProgress])

  const checkForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      await window.api.update.check()
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckingUpdate(false)
    }
  }, [notify])

  if (!settings) return <div className="view" />

  const downloaded = models.filter((m) => m.downloaded)

  return (
    <div className="view settings">
      <header className="view-header">
        <h1>Settings</h1>
        {engine && (
          <span className="muted">
            Engine: {engine.binaryPath ? `whisper.cpp (${engine.backend.toUpperCase()})` : 'whisper.cpp not found — run scripts/setup-whisper.sh'}
          </span>
        )}
      </header>

      <section>
        <h2>Updates</h2>
        {version && <p className="muted">Current version: v{version}</p>}
        {updateStatus.state === 'unsupported' ? (
          <p className="muted">
            Auto-update isn&apos;t available for this build (dev build, .deb package, or
            macOS) — reinstall from the latest GitHub release instead.
          </p>
        ) : (
          <>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={settings.autoUpdateCheck}
                onChange={(e) => void update({ autoUpdateCheck: e.target.checked })}
              />
              Automatically check for updates on startup
            </label>
            <div className="field">
              <button onClick={() => void checkForUpdates()} disabled={checkingUpdate}>
                {checkingUpdate ? 'Checking…' : 'Check for updates'}
              </button>
              {!checkingUpdate && updateStatusText(updateStatus) && (
                <span className="muted">{updateStatusText(updateStatus)}</span>
              )}
            </div>
          </>
        )}
      </section>

      <section>
        <h2>Models</h2>
        <p className="muted">Models are downloaded from Hugging Face and stored locally. Nothing ever leaves your machine.</p>
        <div className="field">
          <label>Default model</label>
          <select value={settings.model} onChange={(e) => void update({ model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.downloaded}>
                {m.label} {m.downloaded ? '' : '(not downloaded)'}
              </option>
            ))}
          </select>
          {downloaded.length === 0 && <span className="muted">Download a model below to get started.</span>}
        </div>
        <ul className="model-list">
          {models.map((m) => (
            <li key={m.id} className="model-item">
              <span className="model-name">
                {m.label} <span className="muted">{m.approxSize}</span>
              </span>
              {m.progress !== undefined ? (
                <span className="model-actions">
                  <progress value={m.progress} max={1} />
                  <button onClick={() => void window.api.models.cancel(m.id)}>Cancel</button>
                </span>
              ) : m.downloaded ? (
                <span className="model-actions">
                  <span className="tag ok">downloaded</span>
                  <button className="danger" onClick={() => void removeModel(m.id)}>
                    Delete
                  </button>
                </span>
              ) : (
                <button onClick={() => void download(m.id)}>Download</button>
              )}
            </li>
          ))}
        </ul>

        <div className="benchmark-section">
          <p className="muted">
            Compare transcription speed across downloaded models using a 30-second test clip
            (language forced to English for consistency).
            Lower real-time factor (RTF) means faster transcription.
            English-only (.en) models are typically faster than their multilingual counterparts.
          </p>
          {benchmarkProgress ? (
            <div className="field">
              <button disabled>{benchmarkProgress}</button>
            </div>
          ) : (
            <div className="field">
              <button
                onClick={() => void runBenchmark()}
                disabled={downloaded.length < 2}
              >
                Benchmark Models
              </button>
              {downloaded.length < 2 && (
                <span className="muted">Download at least two models to benchmark</span>
              )}
            </div>
          )}

          {benchmarkResults && benchmarkResults.length > 0 && (
            <table className="benchmark-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Time</th>
                  <th>RTF</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkResults
                  .slice()
                  .sort((a, b) => a.elapsedMs - b.elapsedMs)
                  .map((r) => {
                    const bestMs = benchmarkResults
                      .filter((x) => x.success)
                      .reduce((min, x) => (x.elapsedMs < min ? x.elapsedMs : min), Infinity)
                    return (
                      <tr
                        key={r.modelId}
                        className={!r.success ? 'benchmark-fail' : r.elapsedMs === bestMs ? 'benchmark-best' : ''}
                      >
                        <td>{r.modelLabel}</td>
                        <td>
                          {r.success
                            ? `${(r.elapsedMs / 1000).toFixed(1)} s`
                            : r.error}
                        </td>
                        <td>
                          {r.success
                            ? `${r.realTimeFactor.toFixed(2)}×`
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2>Recording</h2>
        <div className="field">
          <label>Microphone</label>
          <select
            value={settings.micDeviceId}
            onChange={(e) => void update({ micDeviceId: e.target.value })}
          >
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Toggle recording (press once to start, once to stop)</label>
          <HotkeyInput
            value={settings.hotkeyToggle}
            placeholder="Click and press a shortcut"
            onChange={(v) => void update({ hotkeyToggle: v })}
          />
        </div>
        <div className="field">
          <label>Push-to-talk (hold to record, release to transcribe &amp; paste)</label>
          <HotkeyInput
            value={settings.hotkeyPtt}
            placeholder="Click and press a shortcut"
            onChange={(v) => void update({ hotkeyPtt: v })}
          />
          <span className="muted">
            True hold-to-talk needs the optional uiohook-napi module (see README); without it this key toggles.
          </span>
        </div>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.autoPaste}
            onChange={(e) => void update({ autoPaste: e.target.checked })}
          />
          Auto-paste into the active app after hotkey transcription
        </label>
        <span className="muted">
          Hotkey transcripts are always copied to the clipboard. This only controls whether
          LocalScribe additionally simulates Ctrl+V for you — on Linux/Wayland that simulated
          keystroke is what triggers a &quot;Remote Desktop&quot; permission prompt from your
          compositor every time, so turn it off if you&apos;d rather paste manually.
        </span>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.forceCpu}
            onChange={(e) => void update({ forceCpu: e.target.checked })}
          />
          Force CPU (disable GPU acceleration)
        </label>
        {engine && (engine.backend === 'cuda' || engine.backend === 'vulkan') && (
          <div className="field">
            <label>GPU device</label>
            {gpus.length > 0 ? (
              <select
                value={settings.gpuDevice}
                disabled={settings.forceCpu}
                onChange={(e) => void update({ gpuDevice: e.target.value })}
              >
                <option value="">System default</option>
                {gpus.map((g) => (
                  <option key={g.index} value={String(g.index)}>
                    GPU {g.index}: {g.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                min={0}
                placeholder="Device index (leave blank for default)"
                value={settings.gpuDevice}
                disabled={settings.forceCpu}
                onChange={(e) => void update({ gpuDevice: e.target.value })}
              />
            )}
            <span className="muted">
              Picks which physical GPU whisper.cpp runs on, useful if you have both an
              integrated and a dedicated GPU. On a {engine.backend.toUpperCase()} build this only
              sees {engine.backend === 'cuda' ? 'NVIDIA' : 'Vulkan-capable'} devices — a build
              compiled for a different backend may not see all of your GPUs.
            </span>
          </div>
        )}
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.pauseMediaOnRecord}
            onChange={(e) => void update({ pauseMediaOnRecord: e.target.checked })}
          />
          Mute system audio while recording
        </label>
        <span className="muted">
          Mutes system output right before recording starts and restores the original volume when
          you stop, so background audio (YouTube, Spotify, etc.) doesn&apos;t bleed into the
          transcript. Works for any audio source since it mutes at the system level rather than
          any one app, but muted playback keeps advancing in the background, so it&apos;ll have
          skipped ahead by however long you recorded once unmuted. On Windows this sends the same
          mute key a hardware button would rather than a precise on/off.
        </span>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.useClipboardContext}
            onChange={(e) => void update({ useClipboardContext: e.target.checked })}
          />
          Use clipboard as context for transcription
        </label>
        <span className="muted">
          Reads your clipboard once at the start of each recording and looks for code-like
          identifiers (camelCase, snake_case, etc.) to help whisper spell them correctly —
          useful when dictating about code you just copied. Off by default since this is a
          passive clipboard read and clipboard contents can be sensitive.
        </span>
      </section>

      <section>
        <h2>Vocabulary</h2>
        <p className="muted">
          Correct spellings of words whisper tends to mishear or misspell, e.g. brand names, jargon, or
          acronyms like "Ollama" or "whisper.cpp". Comma-separated. These are fed to whisper as a hint
          before transcribing, and anything in the transcript that sounds close but doesn't match
          exactly gets fuzzy-corrected to the spelling you enter here.
        </p>
        <textarea
          className="vocab-textarea"
          rows={3}
          placeholder="Ollama, whisper.cpp, LocalScribe"
          value={vocabText}
          onFocus={() => {
            vocabFocused.current = true
          }}
          onChange={(e) => setVocabText(e.target.value)}
          onBlur={commitVocabulary}
        />
      </section>

      <section>
        <h2>Polish (LLM)</h2>
        <p className="muted">
          Optional: send transcripts to an LLM to fix grammar and format into bullet points. Local by
          default — choose Ollama to keep everything on-device.
        </p>
        <div className="field">
          <label>Provider</label>
          <select
            value={settings.llm.provider}
            onChange={(e) =>
              void update({ llm: { ...settings.llm, provider: e.target.value as Settings['llm']['provider'] } })
            }
          >
            <option value="none">Disabled</option>
            <option value="ollama">Ollama (local)</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        {(settings.llm.provider === 'anthropic' || settings.llm.provider === 'openai') && (
          <div className="field">
            <label>API key</label>
            <input
              type="password"
              value={settings.llm.apiKey}
              placeholder={settings.llm.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
              onChange={(e) => void update({ llm: { ...settings.llm, apiKey: e.target.value } })}
            />
          </div>
        )}
        {settings.llm.provider === 'ollama' && (
          <div className="field">
            <label>Ollama endpoint</label>
            <input
              type="text"
              value={settings.llm.endpoint}
              placeholder="http://localhost:11434"
              onChange={(e) => void update({ llm: { ...settings.llm, endpoint: e.target.value } })}
            />
          </div>
        )}
        {settings.llm.provider !== 'none' && (
          <div className="field">
            <label>Model (blank for default)</label>
            <input
              type="text"
              value={settings.llm.model}
              placeholder={
                settings.llm.provider === 'anthropic'
                  ? 'claude-opus-4-8'
                  : settings.llm.provider === 'openai'
                    ? 'gpt-4o'
                    : 'llama3.2'
              }
              onChange={(e) => void update({ llm: { ...settings.llm, model: e.target.value } })}
            />
          </div>
        )}
        {settings.llm.provider !== 'none' && (
          <div className="field">
            <label>Prompt style</label>
            <select
              value={settings.llm.promptMode}
              onChange={(e) =>
                void update({
                  llm: { ...settings.llm, promptMode: e.target.value as Settings['llm']['promptMode'] }
                })
              }
            >
              <option value="default">Default (fix grammar, format as bullets)</option>
              <option value="coding">Coding prompt (rewrite as an LLM coding-agent prompt)</option>
            </select>
          </div>
        )}
        {settings.llm.provider !== 'none' && (
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={settings.llm.autoPolish}
              onChange={(e) => void update({ llm: { ...settings.llm, autoPolish: e.target.checked } })}
            />
            Automatically polish every new transcript
          </label>
        )}
      </section>
    </div>
  )
}
