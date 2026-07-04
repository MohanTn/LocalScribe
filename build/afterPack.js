const fs = require('fs')
const path = require('path')

// electron-builder's deb/AppImage targets ship Electron's prebuilt
// chrome-sandbox helper without root ownership or the setuid bit, since the
// build itself runs unprivileged and can't grant either. Chromium's zygote
// host validates that helper's permissions unconditionally (independent of
// the --no-sandbox switch set in src/main/index.ts) and aborts with a FATAL
// setuid_sandbox_host error the moment it finds the file misconfigured.
// Removing the file outright avoids that check entirely: Chromium falls back
// to running unsandboxed, which is the behavior --no-sandbox already asks for.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return

  const sandboxPath = path.join(context.appOutDir, 'chrome-sandbox')
  if (fs.existsSync(sandboxPath)) fs.unlinkSync(sandboxPath)

  // src/main/index.ts also calls app.commandLine.appendSwitch('no-sandbox'),
  // but that runs too late to matter: on Linux, Electron forks the zygote
  // process from native code before Node.js loads and executes index.ts, so
  // a switch appended from JS never reaches the zygote host's sandbox
  // negotiation. Passing --no-sandbox as an actual CLI argument is the only
  // way to reach it in time, so the real binary is renamed and a wrapper
  // script takes its place at the original path (which the .desktop file,
  // AppImage AppRun, and /usr/bin symlink all still point at unchanged).
  const exeName = context.packager.executableName
  const realBinary = path.join(context.appOutDir, exeName)
  const renamedBinary = `${realBinary}.bin`
  fs.renameSync(realBinary, renamedBinary)
  fs.writeFileSync(
    realBinary,
    // `dirname "$0"` alone breaks when this wrapper is reached through a
    // symlink (e.g. /usr/bin/local-scribe -> /opt/LocalScribe/local-scribe,
    // set up by update-alternatives): $0 is the symlink path, not the real
    // one, so dirname resolves to /usr/bin instead of the install dir.
    // readlink -f follows the symlink chain first.
    `#!/bin/sh\nDIR="$(dirname "$(readlink -f "$0")")"\nexec "$DIR/${exeName}.bin" --no-sandbox --disable-dev-shm-usage "$@"\n`,
    { mode: 0o755 }
  )
}
