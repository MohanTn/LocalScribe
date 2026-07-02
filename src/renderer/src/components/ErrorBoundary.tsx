import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  /** React's componentStack from componentDidCatch — useful diagnostic. */
  componentStack: string | null
}

// Catches any uncaught render error in the tree below and shows a small,
// themed fallback rather than a blank window. The hook error in the App's
// on-mount useEffect (preload bridge not yet ready during HMR) used to crash
// the whole renderer — this is the safety net so a single bug doesn't lock
// the user out of the app entirely.

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error }
  }

  override componentDidCatch(error: Error, info: { componentStack?: string }): void {
    // Stash the stack so the user can copy it (developer-during-support);
    // we also log once for DevTools.
    this.setState({ componentStack: info.componentStack ?? null })
    // eslint-disable-next-line no-console
    console.error('[LocalScribe] Render error:', error, info.componentStack)
  }

  reset = (): void => this.setState({ error: null, componentStack: null })

  override render(): React.JSX.Element {
    if (this.state.error) {
      const detail = this.state.componentStack
        ? `${this.state.error.message}\n\n${this.state.componentStack}`
        : this.state.error.message
      return (
        <div className="error-fallback" role="alert">
          <h2>Something went wrong</h2>
          <p>The app hit an unexpected error and recovered the shell. You can retry below.</p>
          <pre className="error-detail">{detail}</pre>
          <div className="error-actions">
            {/* autoFocus so keyboard users land on the action, not on <body>. */}
            <button className="primary" onClick={this.reset} autoFocus>
              Retry
            </button>
          </div>
        </div>
      )
    }
    // Wrap children so we can return React.JSX.Element (project convention)
    // even though props.children is typed as the wider ReactNode.
    return <>{this.props.children}</>
  }
}
