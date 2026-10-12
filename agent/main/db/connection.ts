import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { LocalDeviceStore } from '@shared/clientApi'
import { applyMigrations, planMigrations } from './migrator'
import { MIGRATIONS } from './migrations'

/**
 * Opens the agent's local database file and brings it to the latest bundled schema version.
 * Found running the real shell for the first time (prompt21): `better-sqlite3` does not create a
 * missing parent directory, and every prior test used an already-created temp directory, so this
 * never surfaced until a genuinely fresh `userData` path was used.
 */
export function openAgentDatabase(filePath: string): Database.Database {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const plan = planMigrations(db, MIGRATIONS)
  if (plan.pending.length) applyMigrations(db, plan.pending)
  return db
}

/** Minimal `LocalDeviceStore` (W9.3 phase 1): a single row identifying this installation, created on first use. */
export function createLocalDeviceStore(db: Database.Database): LocalDeviceStore {
  return {
    async getLocalDevice() {
      const existing = db.prepare('SELECT id, created_at AS createdAt FROM local_device WHERE singleton = 1').get() as { id: string; createdAt: string } | undefined
      if (existing) return existing
      const row = { id: randomUUID(), createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO local_device (id, created_at) VALUES (?, ?)').run(row.id, row.createdAt)
      return row
    }
  }
}
