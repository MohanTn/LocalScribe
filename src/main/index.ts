import { BrowserWindow, app, screen, shell } from 'electron'
import { join } from 'path'
import { initHistory } from './history'
import { applyHotkeys, unregisterHotkeys, type HotkeyHandlers } from './hotkeys'
import { registerIpc } from './ipc'
import { warmupOllama } from './llm'
import { modelPath } from './models'
import { getSettings } from './settings'
import { onStatus } from './status'
import { createTray } from './tray'
import { checkForUpdates, initUpdater } from './updater'
import { ensureServer, stopServer } from './whisper-server'

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
let miniWindow: BrowserWindow | null = null
let quitting = false

const MINI_WIDTH = 240
const MINI_HEIGHT = 72
const MINI_MARGIN = 16

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
      nodeIntegration: false,
      // Mini mode hides (not destroys) this window so its MicRecorder keeps
      // capturing in the background; the default throttling of hidden
      // renderers' timers would otherwise starve the audio chunk pipeline.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Closing the window minimizes to tray; the app (and its hotkeys) live on.
  // The resident whisper-server keeps the model loaded (avoiding cold starts),
  // trading higher idle RAM for instant dictation responsiveness.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // The OS minimize button used to leave a separate in-app compact-mode
  // button fighting for the same top-right corner as the native window
  // controls. Redirecting minimize itself into compact mode removes that
  // button (and the overlap) entirely, on every platform. Unlike 'close',
  // Electron's 'minimize' event isn't cancelable (its listener takes no
  // event argument at all), so there's no preventDefault() to reach for —
  // the window briefly minimizes, then enterMiniMode() restores it and
  // switches to the mini widget. The restore/hide sequencing lives inside
  // enterMiniMode() (see hideMainAfterRestore): hiding the window in this
  // handler's tick, while the WM's minimize is still in flight, is what left
  // it hidden-while-iconified and unrecoverable on Wayland.
  mainWindow.on('minimize', () => enterMiniMode())

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
  if (miniWindow?.isVisible()) miniWindow.hide()
  // The restore() in the 'minimize' handler races the WM's in-flight
  // minimize on Linux (and Wayland can't programmatically un-minimize at
  // all), so the window can be hidden with its minimized state still set —
  // then show() alone re-maps it still iconified, unrecoverable from the
  // mini widget, tray, or a second launch. Clear it here, at the one choke
  // point every restore path funnels through.
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (view) mainWindow.webContents.send('navigate', view)
}

function miniPosition(): { x: number; y: number } {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  return { x: x + width - MINI_WIDTH - MINI_MARGIN, y: y + height - MINI_HEIGHT - MINI_MARGIN }
}

function createMiniWindow(): BrowserWindow {
  const { x, y } = miniPosition()
  const win = new BrowserWindow({
    x,
    y,
    width: MINI_WIDTH,
    height: MINI_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#101216',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Closing (e.g. Alt+F4 on Windows) should just return to the full window
  // rather than tearing down the widget's webContents, since it's cheap to
  // keep alive and re-showing it is instant.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      exitMiniMode()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#mini`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'mini' })
  }
  return win
}

function enterMiniMode(): void {
  if (!miniWindow || miniWindow.isDestroyed()) miniWindow = createMiniWindow()
  const { x, y } = miniPosition()
  miniWindow.setPosition(x, y)
  miniWindow.show()
  hideMainAfterRestore()
}

// Hiding a still-minimized window on Linux/Wayland leaves it un-restorable
// (a later show() re-maps it still iconified). So restore() first and hide()
// only once the un-minimize has actually landed, not in the same tick. The
// timeout is a fallback so mini mode still engages on WMs that never emit
// 'restore'; showWindow()'s isMinimized() guard remains the second line of
// defense for that case.
function hideMainAfterRestore(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (!win.isMinimized()) {
    win.hide()
    return
  }
  const hide = (): void => {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.hide()
  }
  win.once('restore', hide)
  const timer = setTimeout(hide, 400)
  win.restore()
}

function exitMiniMode(): void {
  showWindow() // already hides miniWindow if visible
}

// Single instance: a second launch just raises the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    initHistory()
    createWindow()
    registerIpc(() => mainWindow, hotkeyHandlers, {
      exitMini: exitMiniMode
    })
    createTray({
      onToggleRecording: () => hotkeyHandlers.onToggle(),
      onOpen: () => showWindow(),
      onOpenSettings: () => showWindow('settings')
    })
    applyHotkeys(getSettings(), hotkeyHandlers)
    warmupOllama(getSettings().llm) // best-effort: avoid a cold-start delay on the first Polish

    // Start whisper-server so the model stays resident — avoids the per-job
    // cold-start penalty (disk read + GPU alloc) on every partial/final transcription.
    const s = getSettings()
    ensureServer(modelPath(s.model), s.forceCpu, s.gpuDevice).catch((err) =>
      console.warn('whisper-server failed to start; falling back to whisper-cli:', err)
    )

    // Keep the renderer's status dot in sync from a single source of truth —
    // both windows can be visible/hidden independently, so push to whichever
    // are currently alive.
    onStatus((s) => {
      mainWindow?.webContents.send('status', s)
      miniWindow?.webContents.send('status', s)
    })

    initUpdater((s) => mainWindow?.webContents.send('update:status', s))
    // Best-effort: a failed startup check just leaves the Settings page's
    // manual "Check for updates" button as the way to retry.
    if (getSettings().autoUpdateCheck) checkForUpdates().catch(() => undefined)

    app.on('activate', () => {
      // macOS dock click with the window hidden.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    unregisterHotkeys()
    stopServer()
  })

  // Tray app: do NOT quit when the window closes, on any platform.
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
