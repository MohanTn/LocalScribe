import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = mkdtempSync(join(tmpdir(), 'localscribe-settings-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

function writeSettingsFile(content: unknown): void {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(content))
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'localscribe-settings-'))
  vi.resetModules()
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('getSettings vocabulary migration', () => {
  it('passes a plain string list through unchanged', async () => {
    writeSettingsFile({ vocabulary: ['Ollama', 'whisper.cpp'] })
    const { getSettings: freshGetSettings } = await import('./settings')
    expect(freshGetSettings().vocabulary).toEqual(['Ollama', 'whisper.cpp'])
  })

  it('migrates legacy {from, to} pairs to their corrected spelling', async () => {
    writeSettingsFile({
      vocabulary: [
        { from: 'lama 3.1', to: 'Llama 3.1' },
        { from: 'olama', to: 'Ollama' }
      ]
    })
    const { getSettings: freshGetSettings } = await import('./settings')
    expect(freshGetSettings().vocabulary).toEqual(['Llama 3.1', 'Ollama'])
  })

  it('drops legacy pairs with an empty correction and defaults to [] when missing', async () => {
    writeSettingsFile({ vocabulary: [{ from: 'x', to: '' }] })
    const { getSettings: freshGetSettings } = await import('./settings')
    expect(freshGetSettings().vocabulary).toEqual([])
  })
})
