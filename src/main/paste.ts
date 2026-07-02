import { clipboard } from 'electron'
import { spawn, spawnSync } from 'child_process'
import type { PasteOutcome } from '../shared/types'

// Auto-paste = copy to clipboard + synthesize the platform paste chord in the
// app that currently has focus. Because global hotkeys fire while LocalScribe
// is unfocused (and the main window stays hidden in the tray), the target app
// still owns the keyboard focus when we send the chord.

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

export async function autoPaste(text: string): Promise<PasteOutcome> {
  clipboard.writeText(text)
  // Give the OS clipboard a beat before synthesizing the keystroke.
  await new Promise((r) => setTimeout(r, 120))

  if (process.platform === 'darwin') {
    const ok = await run('osascript', [
      '-e',
      'tell application "System Events" to keystroke "v" using command down'
    ])
    return ok
      ? { copied: true, pasted: true }
      : {
          copied: true,
          pasted: false,
          reason: 'Grant LocalScribe Accessibility permission (System Settings → Privacy) to enable auto-paste. Text is on your clipboard.'
        }
  }

  if (process.platform === 'win32') {
    const ok = await run('powershell', [
      '-NoProfile',
      '-Command',
      "$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^v')"
    ])
    return { copied: true, pasted: ok, reason: ok ? undefined : 'Could not simulate Ctrl+V. Text is on your clipboard.' }
  }

  // Linux: xdotool (X11) or ydotool (Wayland) if present. On a Wayland
  // session xdotool has to inject input through XWayland's XTEST bridge,
  // which asks the compositor's Remote Desktop portal for permission on
  // *every* invocation — a fresh xdotool process each time has no identity
  // for the compositor to remember consent for, so it re-prompts on every
  // single paste. ydotool writes to the kernel uinput device directly and
  // needs no portal, so prefer it on Wayland whenever it's installed.
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)
  const hasYdotool = (): boolean => spawnSync('which', ['ydotool']).status === 0
  // ydotool key codes: 29=LeftCtrl, 47=V
  const runYdotool = (): Promise<boolean> => run('ydotool', ['key', '29:1', '47:1', '47:0', '29:0'])

  if (wayland && hasYdotool()) {
    return { copied: true, pasted: await runYdotool() }
  }
  if (spawnSync('which', ['xdotool']).status === 0) {
    const ok = await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])
    return { copied: true, pasted: ok }
  }
  if (hasYdotool()) {
    return { copied: true, pasted: await runYdotool() }
  }
  return {
    copied: true,
    pasted: false,
    reason: 'Install xdotool (X11) or ydotool (Wayland) to enable auto-paste. Text is on your clipboard — press Ctrl+V.'
  }
}
