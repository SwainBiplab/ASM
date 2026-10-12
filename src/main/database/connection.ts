import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'

export interface OpenOptions {
  readonly?: boolean
  fileMustExist?: boolean
}

/**
 * Opens a SQLite connection with the project-wide pragmas (TAS §4.2).
 * Rollback-journal mode (not WAL) keeps the database a single file, which simplifies
 * consistent backup/restore; revisit only with measured need (see DECISIONS.md).
 */
export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  const db = new Database(file, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false
  })
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    if (!opts.readonly) {
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = FULL')
    }
    // Forces the header to be read so a non-SQLite file fails here, not later.
    db.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export function integrityCheck(db: DB, mode: 'quick' | 'full' = 'quick'): string[] {
  const rows = db.pragma(mode === 'quick' ? 'quick_check' : 'integrity_check') as Array<Record<string, string>>
  const messages = rows.map((r) => Object.values(r)[0] ?? '')
  return messages.length === 1 && messages[0] === 'ok' ? [] : messages
}

export function foreignKeyCheck(db: DB): number {
  return (db.pragma('foreign_key_check') as unknown[]).length
}

export function sqliteVersion(db: DB): string {
  return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
}
