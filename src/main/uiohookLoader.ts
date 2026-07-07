/**
 * Isolated so hotkeys.ts stays unit-testable: tests mock this module to
 * simulate uiohook-napi being present or absent, which a bare require()
 * inside hotkeys.ts wouldn't allow (vitest can't intercept it).
 *
 * uiohook-napi is an optionalDependency: npm ships it with the app, but the
 * install may legitimately fail on platforms without a prebuild/toolchain,
 * so its absence must never crash — callers get null and degrade gracefully.
 */
export function loadUiohookModule(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('uiohook-napi')
  } catch (err) {
    // Logged (not silent) because a missing/failed native module here is
    // exactly what degrades push-to-talk from a real hold to a second
    // toggle shortcut — this is the first thing to check when a user
    // reports that behavior.
    console.warn('uiohook-napi unavailable, hotkeys will use the globalShortcut fallback:', err)
    return null
  }
}
