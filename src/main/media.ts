import { spawn, spawnSync } from 'child_process'

// Mutes system audio output right before a recording starts, so whisper.cpp
// doesn't pick up bleed-through from whatever's playing in the background
// (a YouTube tab, Spotify, etc.), and restores the exact original mute state
// the moment recording stops (not after transcription finishes, which can
// take a few seconds). This operates at the OS mixer level rather than
// targeting individual apps/players, so it works uniformly for any audio
// source with no dependency on that app exposing a media-control interface
// (MPRIS, AppleScript dictionary, ...) — the earlier per-player-pause design
// silently did nothing for a browser tab that doesn't expose MPRIS, which is
// exactly the YouTube-in-browser case this feature exists for. The tradeoff:
// muted playback keeps advancing in the background, so a video/song will
// have skipped ahead by the recording's length once unmuted, rather than
// resuming from the exact frame it was paused at.
//
// Best-effort and non-throwing throughout: a missing tool or a platform
// without a scriptable mute must never block or break recording — see
// pauseMedia/resumeMedia's timeout wrapper.

const CONTROL_TIMEOUT_MS = 500

type LinuxMixer = 'wpctl' | 'pactl' | 'amixer' | null

// Whether the system was already muted before we muted it, captured at
// pause time so resume restores that exact original state rather than
// blindly unmuting (which would un-mute a user who had muted themselves).
let linuxMixer: LinuxMixer = null
let linuxWasMuted: boolean | null = null
let macWasMuted: boolean | null = null
let warnedMissingMixer = false

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.on('error', () => resolve({ ok: false, stdout: '' }))
    proc.on('close', (code) => resolve({ ok: code === 0, stdout }))
  })
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms))])
}

/** Mutes system audio output. Call before mic capture starts. */
export async function pauseMedia(): Promise<void> {
  await withTimeout(pauseImpl(), CONTROL_TIMEOUT_MS)
}

/** Restores the exact mute state pauseMedia() captured. Call the instant recording stops. */
export async function resumeMedia(): Promise<void> {
  await withTimeout(resumeImpl(), CONTROL_TIMEOUT_MS)
}

async function pauseImpl(): Promise<void> {
  if (process.platform === 'linux') return pauseLinux()
  if (process.platform === 'win32') return pauseWindows()
  if (process.platform === 'darwin') return pauseMac()
}

async function resumeImpl(): Promise<void> {
  if (process.platform === 'linux') return resumeLinux()
  if (process.platform === 'win32') return resumeWindows()
  if (process.platform === 'darwin') return resumeMac()
}

// --- Linux: wpctl (PipeWire) / pactl (PulseAudio) / amixer (ALSA) ---------
// Tries each mixer CLI in the order most modern desktops actually ship it:
// wpctl is WirePlumber's control tool and PipeWire is the default audio
// server on current Ubuntu/Fedora/etc; pactl covers PulseAudio (or
// PipeWire's pulse-compatible shim) where present; amixer (ALSA) is the
// lowest-common-denominator fallback that's virtually always installed.
// Unlike the previous playerctl-based design, none of these require an
// extra optional package on a typical desktop install.

function detectLinuxMixer(): LinuxMixer {
  if (spawnSync('which', ['wpctl']).status === 0) return 'wpctl'
  if (spawnSync('which', ['pactl']).status === 0) return 'pactl'
  if (spawnSync('which', ['amixer']).status === 0) return 'amixer'
  return null
}

async function getLinuxMuted(tool: LinuxMixer): Promise<boolean> {
  if (tool === 'wpctl') {
    const { stdout } = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
    return stdout.includes('[MUTED]')
  }
  if (tool === 'pactl') {
    const { stdout } = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@'])
    return /yes/i.test(stdout)
  }
  const { stdout } = await run('amixer', ['get', 'Master'])
  return /\[off\]/.test(stdout)
}

async function setLinuxMuted(tool: LinuxMixer, muted: boolean): Promise<void> {
  if (tool === 'wpctl') {
    await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0'])
    return
  }
  if (tool === 'pactl') {
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0'])
    return
  }
  await run('amixer', ['set', 'Master', muted ? 'mute' : 'unmute'])
}

async function pauseLinux(): Promise<void> {
  linuxMixer = detectLinuxMixer()
  if (!linuxMixer) {
    if (!warnedMissingMixer) {
      console.warn('No wpctl, pactl, or amixer found — cannot mute background audio while recording.')
      warnedMissingMixer = true
    }
    return
  }
  linuxWasMuted = await getLinuxMuted(linuxMixer)
  await setLinuxMuted(linuxMixer, true)
}

async function resumeLinux(): Promise<void> {
  if (!linuxMixer || linuxWasMuted === null) return
  await setLinuxMuted(linuxMixer, linuxWasMuted)
  linuxMixer = null
  linuxWasMuted = null
}

// --- Windows: VK_VOLUME_MUTE toggle -----------------------------------------
// Windows exposes precise mute get/set only through the Core Audio COM
// interfaces, which need a substantial P/Invoke marshalling shim to reach
// from PowerShell. The pragmatic option is the same mute key a hardware
// keyboard sends: a single system-wide toggle, with no per-app targeting
// ambiguity (unlike a play/pause key, nothing else is likely to flip the
// system mute state during a several-second recording window), so a blind
// toggle before and after is a reasonable, dependency-free approximation of
// capture-and-restore.
const TOGGLE_MUTE_PS = `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class LocalScribeMedia {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);
}
"@
[LocalScribeMedia]::keybd_event(0xAD, 0, 0, 0)
[LocalScribeMedia]::keybd_event(0xAD, 0, 2, 0)
`

async function toggleWindowsMute(): Promise<void> {
  await run('powershell', ['-NoProfile', '-Command', TOGGLE_MUTE_PS])
}

async function pauseWindows(): Promise<void> {
  await toggleWindowsMute()
}

async function resumeWindows(): Promise<void> {
  await toggleWindowsMute()
}

// --- macOS: AppleScript volume settings --------------------------------------
// Unlike Windows, AppleScript can precisely query and set the system mute
// bit (`output muted` of `get volume settings`), so this captures the exact
// original state and restores it rather than blindly toggling.

async function pauseMac(): Promise<void> {
  const state = await run('osascript', ['-e', 'output muted of (get volume settings)'])
  macWasMuted = state.ok ? state.stdout.trim() === 'true' : null
  await run('osascript', ['-e', 'set volume output muted true'])
}

async function resumeMac(): Promise<void> {
  if (macWasMuted === null) return
  await run('osascript', ['-e', `set volume output muted ${macWasMuted}`])
  macWasMuted = null
}
