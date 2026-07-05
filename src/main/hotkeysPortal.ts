import type { Settings } from '../shared/types'

// GNOME/Wayland-native alternative to the uiohook/globalShortcut path in
// hotkeys.ts. Both of those ultimately grab keys via X11 (uiohook's Linux
// backend is XRecord, same as Electron's globalShortcut through XWayland),
// so neither ever sees a native-Wayland client window (e.g. a GTK4 terminal)
// while it's focused. The xdg-desktop-portal GlobalShortcuts portal is
// implemented by the compositor itself, so it has no such blind spot — but
// it only works for a process the compositor can attribute to an installed
// app (a systemd `app-<id>-<pid>.scope`, which GNOME assigns when launching
// from a .desktop entry). Dev sessions and bare CLI launches don't get that
// scope, so this deliberately fails closed and lets hotkeys.ts's existing
// fallback keep working untouched.
//
// Known limitation: if the D-Bus connection drops *after* a successful
// bind (portal daemon restart, session bus hiccup), hotkeys silently stop
// firing until the next applyHotkeys call (e.g. a settings save) — there's
// no live reconnect/re-fallback-to-uiohook loop. Not implemented since it'd
// also mean every other portal-consuming app on the session lost its
// shortcuts at the same time; a targeted fix isn't worth the complexity yet.
const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop'
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop'
const GLOBAL_SHORTCUTS_IFACE = 'org.freedesktop.portal.GlobalShortcuts'
const REQUEST_IFACE = 'org.freedesktop.portal.Request'

// Portal method calls return a request object path immediately, but the
// actual result arrives later as a `Response` signal on that path (the
// xdg-desktop-portal request pattern). That object doesn't exist yet at call
// time, so getProxyObject can't introspect it — we hand it this static XML
// instead, which skips introspection entirely (see dbus-next's
// ProxyObject#_init: a truthy `xml` argument bypasses the Introspect call).
const REQUEST_XML = `<node>
  <interface name="${REQUEST_IFACE}">
    <signal name="Response">
      <arg type="u" name="response"/>
      <arg type="a{sv}" name="results"/>
    </signal>
  </interface>
</node>`

const TOGGLE_SHORTCUT_ID = 'toggle-recording'
const PTT_SHORTCUT_ID = 'push-to-talk'
const REQUEST_TIMEOUT_MS = 5000

export interface PortalHandlers {
  onToggle: () => void
  onPttDown: () => void
  onPttUp: () => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbusModule = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageBus = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientInterface = any

let dbus: DbusModule = undefined
let bus: MessageBus | null = null
let globalShortcuts: ClientInterface | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let onActivated: ((session: string, id: string, ...rest: any[]) => void) | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let onDeactivated: ((session: string, id: string, ...rest: any[]) => void) | null = null
// Bumped on every tryStartPortalHotkeys/stopPortalHotkeys call so an
// in-flight attempt (each D-Bus round trip can take a while, e.g. while
// GNOME's confirmation dialog is up) can tell a newer call has superseded it
// and back off instead of publishing its bus/session into the module-level
// state a newer call already owns.
let generation = 0

function loadDbus(): DbusModule {
  if (dbus !== undefined) return dbus
  try {
    dbus = require('dbus-next')
  } catch {
    dbus = null
  }
  return dbus
}

/** Escapes a D-Bus unique name (":1.234") into the path segment the portal
 *  request/session object paths use (per the xdg-desktop-portal spec). */
function escapeBusName(name: string): string {
  return name.replace(/^:/, '').replace(/\./g, '_')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapVariants(dict: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(dict)) out[key] = v && 'value' in v ? v.value : v
  return out
}

/** Calls a portal method and awaits its Response signal rather than its
 *  immediate (request-handle) return value. The handle_token is generated
 *  and subscribed to before the call so a fast Response can't race past the
 *  listener. */
async function callPortal(
  busConn: MessageBus,
  mod: DbusModule,
  iface: ClientInterface,
  method: string,
  argsBeforeOptions: unknown[],
  extraOptions: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const token = `localscribe_${method.toLowerCase()}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const requestPath = `/org/freedesktop/portal/desktop/request/${escapeBusName(busConn.name)}/${token}`
  const requestObj = await busConn.getProxyObject(PORTAL_BUS_NAME, requestPath, REQUEST_XML)
  const request = requestObj.getInterface(REQUEST_IFACE)

  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      request.removeListener('Response', onResponse)
      reject(new Error(`portal request "${method}" timed out`))
    }, REQUEST_TIMEOUT_MS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function onResponse(code: number, results: Record<string, any>): void {
      clearTimeout(timer)
      request.removeListener('Response', onResponse)
      if (code !== 0) reject(new Error(`portal request "${method}" declined (code ${code})`))
      else resolve(unwrapVariants(results))
    }
    request.on('Response', onResponse)
  })

  const options: Record<string, unknown> = {
    handle_token: new mod.Variant('s', token),
    ...extraOptions
  }
  await iface[method](...argsBeforeOptions, options)
  return response
}

/** Best-effort translation of our "Ctrl+Shift+Space" combo strings into GTK
 *  accelerator syntax ("<Control><Shift>space") to use as the portal's
 *  `preferred_trigger` hint. The compositor is free to ignore it and let the
 *  user pick their own binding, so this only needs to be a reasonable guess. */
function toGtkAccelerator(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim())
  let mods = ''
  let key = ''
  for (const part of parts) {
    const p = part.toLowerCase()
    if (p === 'ctrl' || p === 'control' || p === 'commandorcontrol') mods += '<Control>'
    else if (p === 'alt' || p === 'option') mods += '<Alt>'
    else if (p === 'shift') mods += '<Shift>'
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') mods += '<Super>'
    else key = part.length === 1 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1).toLowerCase()
  }
  return mods + key
}

/** Attempts to bind the toggle/PTT hotkeys via the GlobalShortcuts portal.
 *  Resolves false (never throws) if the portal isn't available, isn't
 *  running on this desktop, or rejects the caller for lacking an app-id
 *  scope — every one of those is an expected fallback case, not an error. */
export async function tryStartPortalHotkeys(
  settings: Settings,
  handlers: PortalHandlers
): Promise<boolean> {
  if (process.platform !== 'linux') return false
  if (!settings.hotkeyToggle && !settings.hotkeyPtt) return false

  const mod = loadDbus()
  if (!mod) return false

  const myGeneration = ++generation
  let myBus: MessageBus | null = null
  try {
    myBus = mod.sessionBus()
    // MessageBus re-emits connection/protocol failures (broken pipe, a
    // malformed message, a failed AddMatch from ClientInterface#on(...)) as
    // an 'error' event on itself. Node's EventEmitter throws — crashing the
    // whole process — when 'error' has zero listeners, so this is required,
    // not optional, for a background feature that must never take the app
    // down with it.
    myBus.on('error', (err: unknown) =>
      console.log(`GlobalShortcuts portal D-Bus connection error: ${err}`)
    )
    const desktop = await myBus.getProxyObject(PORTAL_BUS_NAME, PORTAL_OBJECT_PATH)
    const shortcutsIface = desktop.getInterface(GLOBAL_SHORTCUTS_IFACE)

    const created = await callPortal(myBus, mod, shortcutsIface, 'CreateSession', [], {
      session_handle_token: new mod.Variant('s', `localscribe_session_${Date.now()}`)
    })
    if (myGeneration !== generation) throw new Error('superseded by a newer applyHotkeys call')
    const sessionHandle = created.session_handle as string

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shortcuts: [string, Record<string, any>][] = []
    if (settings.hotkeyToggle) {
      shortcuts.push([
        TOGGLE_SHORTCUT_ID,
        {
          description: new mod.Variant('s', 'Toggle recording'),
          preferred_trigger: new mod.Variant('s', toGtkAccelerator(settings.hotkeyToggle))
        }
      ])
    }
    if (settings.hotkeyPtt) {
      shortcuts.push([
        PTT_SHORTCUT_ID,
        {
          description: new mod.Variant('s', 'Push to talk'),
          preferred_trigger: new mod.Variant('s', toGtkAccelerator(settings.hotkeyPtt))
        }
      ])
    }

    await callPortal(myBus, mod, shortcutsIface, 'BindShortcuts', [sessionHandle, shortcuts, ''])
    if (myGeneration !== generation) throw new Error('superseded by a newer applyHotkeys call')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activated = (session: string, id: string, _timestamp: any) => {
      if (session !== sessionHandle) return
      if (id === TOGGLE_SHORTCUT_ID) handlers.onToggle()
      else if (id === PTT_SHORTCUT_ID) handlers.onPttDown()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deactivated = (session: string, id: string, _timestamp: any) => {
      if (session !== sessionHandle) return
      if (id === PTT_SHORTCUT_ID) handlers.onPttUp()
    }
    shortcutsIface.on('Activated', activated)
    shortcutsIface.on('Deactivated', deactivated)

    bus = myBus
    globalShortcuts = shortcutsIface
    onActivated = activated
    onDeactivated = deactivated
    return true
  } catch (err) {
    // Expected in dev/CLI launches (no app-id cgroup scope) and on desktops
    // without a GlobalShortcuts portal backend — fall back silently.
    console.log(`GlobalShortcuts portal unavailable, using fallback hotkey path: ${err}`)
    if (myBus) {
      try {
        myBus.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    return false
  }
}

export function stopPortalHotkeys(): void {
  generation++
  if (globalShortcuts) {
    if (onActivated) globalShortcuts.removeListener('Activated', onActivated)
    if (onDeactivated) globalShortcuts.removeListener('Deactivated', onDeactivated)
  }
  onActivated = null
  onDeactivated = null
  globalShortcuts = null
  if (bus) {
    try {
      bus.disconnect()
    } catch {
      /* already disconnected */
    }
    bus = null
  }
}
