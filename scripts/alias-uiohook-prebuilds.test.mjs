import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aliasUiohookPrebuilds, nativeExtForArch } from './alias-uiohook-prebuilds.mjs'

describe('nativeExtForArch', () => {
  it('matches @electron/rebuild naming for arm64', () => {
    expect(nativeExtForArch('arm64')).toBe('armv8.node')
  })

  it('matches @electron/rebuild naming for 32-bit arm', () => {
    expect(nativeExtForArch('arm')).toBe('armv7.node')
    expect(nativeExtForArch('armv7l')).toBe('armv7.node')
  })

  it('uses plain .node for everything else', () => {
    expect(nativeExtForArch('x64')).toBe('node')
    expect(nativeExtForArch('ia32')).toBe('node')
  })
})

describe('aliasUiohookPrebuilds', () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'uiohook-prebuilds-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function addPrebuild(dir) {
    const d = path.join(root, dir)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'uiohook-napi.node'), `binary-${dir}`)
  }

  it('creates node.napi.node aliases next to each x64 prebuild', () => {
    addPrebuild('linux-x64')
    addPrebuild('win32-x64')

    const created = aliasUiohookPrebuilds(root)

    expect(created).toHaveLength(2)
    for (const dir of ['linux-x64', 'win32-x64']) {
      const alias = path.join(root, dir, 'node.napi.node')
      expect(fs.readFileSync(alias, 'utf8')).toBe(`binary-${dir}`)
    }
  })

  it('uses the armv8 extension for arm64 prebuilds', () => {
    addPrebuild('darwin-arm64')

    aliasUiohookPrebuilds(root)

    expect(fs.existsSync(path.join(root, 'darwin-arm64', 'node.napi.armv8.node'))).toBe(true)
  })

  it('is idempotent: an existing alias is left untouched', () => {
    addPrebuild('linux-x64')
    const alias = path.join(root, 'linux-x64', 'node.napi.node')
    fs.writeFileSync(alias, 'already-here')

    const created = aliasUiohookPrebuilds(root)

    expect(created).toHaveLength(0)
    expect(fs.readFileSync(alias, 'utf8')).toBe('already-here')
  })

  it('returns empty when the module is absent (optional dep not installed)', () => {
    expect(aliasUiohookPrebuilds(path.join(root, 'missing'))).toEqual([])
  })

  it('skips platform dirs without the expected binary', () => {
    fs.mkdirSync(path.join(root, 'linux-x64'))

    expect(aliasUiohookPrebuilds(root)).toEqual([])
  })
})
