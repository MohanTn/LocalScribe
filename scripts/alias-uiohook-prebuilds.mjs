// uiohook-napi ships prebuildify N-API binaries named `uiohook-napi.node`,
// but @electron/rebuild (which drives `electron-builder install-app-deps`)
// only recognizes prebuilds named `node.napi.<ext>` / `electron.napi.<ext>` /
// `electron.abi<N>.<ext>` (see its module-type/prebuildify.js — still true
// as of @electron/rebuild 4.1.0). Unrecognized, the module falls through to
// a node-gyp source build, which fails on CI runners without X11 headers
// (Linux) or a Visual Studio toolchain (Windows). Aliasing each prebuild to
// a recognized name makes the rebuild step treat the module as prebuilt and
// skip compilation; node-gyp-build still loads it fine at runtime.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Mirrors @electron/rebuild's determineNativePrebuildExtension().
export function nativeExtForArch(arch) {
  if (arch === 'arm64') return 'armv8.node'
  if (arch === 'arm' || arch === 'armv7l') return 'armv7.node'
  return 'node'
}

export function aliasUiohookPrebuilds(prebuildsRoot) {
  const created = []
  if (!fs.existsSync(prebuildsRoot)) return created
  for (const dir of fs.readdirSync(prebuildsRoot)) {
    const src = path.join(prebuildsRoot, dir, 'uiohook-napi.node')
    if (!fs.existsSync(src)) continue
    const arch = dir.slice(dir.indexOf('-') + 1)
    const dest = path.join(prebuildsRoot, dir, `node.napi.${nativeExtForArch(arch)}`)
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest)
      created.push(dest)
    }
  }
  return created
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const root = path.join(scriptDir, '..', 'node_modules', 'uiohook-napi', 'prebuilds')
  const created = aliasUiohookPrebuilds(root)
  if (created.length > 0) {
    console.log(`aliased ${created.length} uiohook-napi prebuild(s) for @electron/rebuild`)
  }
}
