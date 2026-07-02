import { BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { initHistory } from './history'
import { applyHotkeys, unregisterHotkeys, type HotkeyHandlers } from './hotkeys'
import { registerIpc } from './ipc'
import { warmupOllama } from './llm'
import { getSettings } from './settings'
import { onStatus } from './status'
import { createTray } from './tray'

let mainWindow: BrowserWindow | null = null
let quitting = false

// Recording is *initiated* in main (hotkeys, tray) but *captured* in the
// renderer (getUserMedia lives there), so these handlers just forward intent.
// The renderer replies through the audio:* IPC channels. `viaHotkey` tells the
// renderer to auto-paste on completion.
const hotkeyHandlers: HotkeyHandlers = {
  onToggle: () => mainWindow?.webContents.send('record:toggle', { viaHotkey: true }),
  onPttDown: () => mainWindow?.webContents.send('ptt:down'),
  onPttUp: () => mainWindow?.webContents.send('ptt:up')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 860,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101216', // matches the theme; avoids white flash
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, // renderer never touches Node directly
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Closing the window minimizes to tray; the app (and its hotkeys) live on.
  // Because whisper.cpp runs as a child process per job, the idle footprint is
  // just Electron + a hidden window — comfortably inside the 150MB budget.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url) // external links go to the OS browser
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(view?: string): void {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
  if (view) mainWindow.webContents.send('navigate', view)
}

// Single instance: a second launch just raises the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    initHistory()
    createWindow()
    registerIpc(() => mainWindow, hotkeyHandlers)
    createTray({
      onToggleRecording: () => hotkeyHandlers.onToggle(),
      onOpen: () => showWindow(),
      onOpenSettings: () => showWindow('settings')
    })
    applyHotkeys(getSettings(), hotkeyHandlers)
    warmupOllama(getSettings().llm) // best-effort: avoid a cold-start delay on the first Polish

    // Keep the renderer's status dot in sync from a single source of truth.
    onStatus((s) => mainWindow?.webContents.send('status', s))

    app.on('activate', () => {
      // macOS dock click with the window hidden.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    unregisterHotkeys()
  })

  // Tray app: do NOT quit when the window closes, on any platform.
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
