import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

// Thin wrapper around electron-updater's autoUpdater singleton, in the same
// small-observable style as status.ts. Reuses the GitHub Releases publish
// pipeline already set up in electron-builder.yml / release.yml — no extra
// server or config file needed.
//
// electron-updater can only self-update builds electron-builder actually
// knows how to patch in place: NSIS on Windows, and AppImage (not .deb) on
// Linux. There's no published macOS build yet either. Everywhere else we
// report a single 'unsupported' status instead of wiring any autoUpdater
// events, so the renderer can hide the feature instead of offering a button
// that would only ever error.
export function isUpdaterSupported(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'darwin') return false
  if (process.platform === 'linux' && !process.env.APPIMAGE) return false
  return true
}

let statusCb: ((s: UpdateStatus) => void) | null = null
let listenersAttached = false

// The startup check in index.ts can complete (and even finish downloading)
// before the renderer has mounted and subscribed to the 'update:status' push
// channel — Electron doesn't buffer IPC sends to a not-yet-listening
// renderer. Tracking the last status lets the renderer pull the current
// state once on mount (see ipc.ts's 'update:getStatus', used the same way
// App.tsx already pulls checkOllamaModel() instead of relying only on the
// 'ollama:modelMissing' push).
let lastStatus: UpdateStatus = { state: 'idle' }

function emit(status: UpdateStatus): void {
  lastStatus = status
  statusCb?.(status)
}

export function getUpdateStatus(): UpdateStatus {
  return lastStatus
}

export function initUpdater(onStatus: (s: UpdateStatus) => void): void {
  statusCb = onStatus
  if (!isUpdaterSupported()) {
    emit({ state: 'unsupported' })
    return
  }
  if (listenersAttached) return
  listenersAttached = true

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => emit({ state: 'not-available' }))
  // autoDownload defaults to true, so a found update starts downloading right
  // away; there's no separate UI state for "available but not yet downloading".
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', progress: p.percent / 100 }))
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => emit({ state: 'error', message: err.message }))
}

const UNSUPPORTED_MESSAGE =
  "Auto-update isn't available for this build (dev build, .deb package, or macOS)."

export async function checkForUpdates(): Promise<void> {
  if (!isUpdaterSupported()) throw new Error(UNSUPPORTED_MESSAGE)
  await autoUpdater.checkForUpdates()
}

export function installUpdate(): void {
  if (!isUpdaterSupported()) throw new Error(UNSUPPORTED_MESSAGE)
  autoUpdater.quitAndInstall()
}
