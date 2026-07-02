import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'

export default function HistoryView(): React.JSX.Element {
  const history = useStore((s) => s.history)
  const setHistory = useStore((s) => s.setHistory)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const refresh = useCallback(
    async (q: string) => {
      setHistory(await window.api.history.search(q))
    },
    [setHistory]
  )

  useEffect(() => {
    // Debounced live search.
    const t = setTimeout(() => void refresh(query), 200)
    return () => clearTimeout(t)
  }, [query, refresh])

  const remove = useCallback(
    async (id: number) => {
      await window.api.history.delete(id)
      void refresh(query)
    },
    [query, refresh]
  )

  const clearAll = useCallback(async () => {
    await window.api.history.clear()
    void refresh('')
  }, [refresh])

  return (
    <div className="view">
      <header className="view-header">
        <h1>History</h1>
        <button className="danger" onClick={() => void clearAll()} disabled={!history.length}>
          Clear all
        </button>
      </header>

      <input
        className="search"
        type="search"
        placeholder="Search transcriptions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {history.length === 0 ? (
        <p className="muted empty">Nothing here yet — transcriptions are saved automatically.</p>
      ) : (
        <ul className="history-list">
          {history.map((entry) => (
            <li key={entry.id} className="history-item">
              <button
                className="history-summary"
                onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
              >
                <span className="history-text">{entry.text.slice(0, 140) || '(empty)'}</span>
                <span className="muted history-meta">
                  {new Date(entry.createdAt + (entry.createdAt.endsWith('Z') ? '' : 'Z')).toLocaleString()} · {entry.source} · {entry.model}
                </span>
              </button>
              {expanded === entry.id && (
                <div className="history-detail">
                  <p className="history-full">{entry.text}</p>
                  <div className="action-group">
                    <button onClick={() => void navigator.clipboard.writeText(entry.text)}>Copy</button>
                    <button className="danger" onClick={() => void remove(entry.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
