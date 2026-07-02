import { app } from 'electron'
import { join } from 'path'
import type { HistoryEntry } from '../shared/types'

// SQLite via better-sqlite3 (synchronous, zero-config, rebuilt for Electron by
// `electron-builder install-app-deps`). If the native module fails to load —
// the classic ABI-mismatch failure mode — we degrade to an in-memory store so
// transcription itself keeps working; the error is logged for diagnosis.

type Db = import('better-sqlite3').Database

let db: Db | null = null
let memory: HistoryEntry[] = [] // fallback only
let memoryId = 1

export function initHistory(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    db = new Database(join(app.getPath('userData'), 'history.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions(created_at DESC);
    `)
  } catch (err) {
    console.error('SQLite unavailable, history will not persist:', err)
    db = null
  }
}

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'createdAt'>): void {
  if (db) {
    db.prepare(
      'INSERT INTO transcriptions (source, model, text, duration_ms) VALUES (?, ?, ?, ?)'
    ).run(entry.source, entry.model, entry.text, entry.durationMs)
  } else {
    memory.unshift({ ...entry, id: memoryId++, createdAt: new Date().toISOString() })
  }
}

export function searchHistory(query: string, limit = 200): HistoryEntry[] {
  if (db) {
    const rows = db
      .prepare(
        `SELECT id, created_at AS createdAt, source, model, text, duration_ms AS durationMs
         FROM transcriptions
         WHERE text LIKE ? OR source LIKE ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit)
    return rows as HistoryEntry[]
  }
  const q = query.toLowerCase()
  return memory.filter((e) => e.text.toLowerCase().includes(q) || e.source.toLowerCase().includes(q)).slice(0, limit)
}

export function deleteHistory(id: number): void {
  if (db) db.prepare('DELETE FROM transcriptions WHERE id = ?').run(id)
  else memory = memory.filter((e) => e.id !== id)
}

export function clearHistory(): void {
  if (db) db.exec('DELETE FROM transcriptions')
  else memory = []
}
