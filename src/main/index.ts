import { BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { initHistory } from './history'
import { applyHotkeys, unregisterHotkeys, type HotkeyHandlers } from './hotkeys'
import { registerIpc } from './ipc'
import { warmupOllama } from './llm'
import { getSettings } from './settings'
import { onStatus } from './status'
import { createTray } from './tray'
import { checkForUpdates, initUpdater } from './updater'

// electron-builder's deb/AppImage targets can't ship a root-owned setuid
// chrome-sandbox helper (the build itself runs unprivileged), so Chromium's
// SUID sandbox check aborts with a FATAL error unless an admin manually
// chown/chmods it post-install (build/afterPack.js removes the file
// entirely instead, which sidesteps that check the same way). LocalScribe's
// renderer only ever loads its own bundled local HTML (never remote/
// attacker-controlled content), so the OS-level sandbox isn't protecting
// against an active threat here. macOS/Windows use different sandbox
// mechanisms and aren't affected by any of this.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
  // Some hosts (e.g. small Docker containers, or ones where AppArmor's
  // unprivileged-userns hardening on Ubuntu 24.04+ leaves Chromium's zygote
  // namespace half-initialized) can't back shared memory with /dev/shm at
  // all even with the sandbox off; this makes Chromium use /tmp instead.
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}

// `LocalScribe --version` / `-v`: print and exit before anything else spins up
// (single-instance lock, window, tray) so it works even with another instance running.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(app.getVersion())
  app.exit(0)
}

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
    // electron-builder.yml's `icon:` only brands the *packaged* executable/
    // installer — an unpackaged `npm run dev` run has no custom icon unless
    // BrowserWindow is told explicitly (Linux/Windows taskbar; no-op on mac).
    icon: join(__dirname, '../../resources/icon.png'),
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

    initUpdater((s) => mainWindow?.webContents.send('update:status', s))
    // Best-effort: a failed startup check just leaves the Settings page's
    // manual "Check for updates" button as the way to retry.
    if (getSettings().autoUpdateCheck) void checkForUpdates().catch(() => undefined)

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
