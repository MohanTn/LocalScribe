import { useState } from 'react'
import { useStore, type View } from '../store'

const NAV: Array<{ id: View; label: string; icon: React.JSX.Element }> = [
  {
    id: 'transcribe',
    label: 'Transcribe',
    icon: (
      // waveform
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="8" x2="3" y2="12" />
          <line x1="7" y1="5" x2="7" y2="15" />
          <line x1="11" y1="2" x2="11" y2="18" />
          <line x1="15" y1="6" x2="15" y2="14" />
          <line x1="19" y1="9" x2="19" y2="11" />
        </g>
      </svg>
    )
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 6v4l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
        <circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M15.7 4.3l-2.1 2.1M6.4 13.6l-2.1 2.1"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
]

const STATUS_LABEL = {
  idle: 'Idle',
  recording: 'Recording',
  processing: 'Processing',
  error: 'Error'
} as const

export default function Sidebar(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const status = useStore((s) => s.status)

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 20 20" width="20" height="20">
            <g stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round">
              <line x1="4" y1="7" x2="4" y2="13" />
              <line x1="10" y1="3" x2="10" y2="17" />
              <line x1="16" y1="7" x2="16" y2="13" />
            </g>
          </svg>
        </span>
        {!collapsed && <span className="brand-name">LocalScribe</span>}
      </div>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${view === item.id ? 'active' : ''}`}
            onClick={() => setView(item.id)}
            title={item.label}
          >
            {item.icon}
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="status-chip" title={STATUS_LABEL[status]}>
          <span className={`status-dot status-${status}`} />
          {!collapsed && <span className="status-label">{STATUS_LABEL[status]}</span>}
        </div>
        <div className="sidebar-footer-actions">
          <button
            className="sidebar-icon-btn"
            onClick={() => void window.api.window.enterMini()}
            title="Compact mode: small always-on-top widget"
          >
            ⤢
          </button>
          <button
            className="sidebar-icon-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
      </div>
    </aside>
  )
}
