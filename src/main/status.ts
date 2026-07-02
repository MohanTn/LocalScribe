import type { AppStatus } from '../shared/types'

// Tiny observable for the app-wide state machine (idle/recording/processing/
// error). Tray icon, renderer status dot and menu labels all subscribe here so
// every surface stays in sync.

let current: AppStatus = 'idle'
const listeners = new Set<(s: AppStatus) => void>()

export function getStatus(): AppStatus {
  return current
}

export function setStatus(next: AppStatus): void {
  if (next === current) return
  current = next
  for (const l of listeners) l(next)
}

export function onStatus(listener: (s: AppStatus) => void): void {
  listeners.add(listener)
}
