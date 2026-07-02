import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'path'
import type { AppStatus } from '../shared/types'
import { getStatus, onStatus } from './status'

export interface TrayActions {
  onToggleRecording: () => void
  onOpen: () => void
  onOpenSettings: () => void
}

let tray: Tray | null = null
let actions: TrayActions | null = null

const TOOLTIP: Record<AppStatus, string> = {
  idle: 'LocalScribe — idle',
  recording: 'LocalScribe — recording…',
  processing: 'LocalScribe — transcribing…',
  error: 'LocalScribe — error'
}

function icon(status: AppStatus): Electron.NativeImage {
  // Colored-dot icons generated into resources/icons (green/coral/amber/red);
  // resources/** ships inside the asar, reachable relative to out/main.
  const img = nativeImage.createFromPath(
    join(__dirname, '../../resources/icons', `tray-${status}.png`)
  )
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

export function createTray(a: TrayActions): void {
  actions = a
  tray = new Tray(icon(getStatus()))
  tray.setToolTip(TOOLTIP[getStatus()])
  rebuildMenu(getStatus())
  tray.on('click', () => actions?.onOpen()) // single click opens on Win/Linux
  onStatus((s) => {
    tray?.setImage(icon(s))
    tray?.setToolTip(TOOLTIP[s])
    rebuildMenu(s)
  })
}

function rebuildMenu(status: AppStatus): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: status === 'recording' ? 'Stop Recording' : 'Start Recording',
        enabled: status === 'recording' || status === 'idle',
        click: () => actions?.onToggleRecording()
      },
      { label: 'Open LocalScribe', click: () => actions?.onOpen() },
      { label: 'Open Settings', click: () => actions?.onOpenSettings() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        }
      }
    ])
  )
}
