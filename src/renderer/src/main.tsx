import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import MiniApp from './MiniApp'
import './styles.css'

// Mini widget window loads this same bundle with a `#mini` hash (see
// main/index.ts's createMiniWindow) instead of a second HTML entry point.
const isMini = window.location.hash === '#mini'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{isMini ? <MiniApp /> : <App />}</ErrorBoundary>
  </React.StrictMode>
)
