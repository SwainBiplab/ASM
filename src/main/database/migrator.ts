import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { AppError } from '../app/errors'
import { nowIso } from '../app/ids'

export interface Migration {
  version: number
  name: string
  sql: string
}

export interface AppliedMigration {
  version: number
  name: string
  checksum: string
  appliedAt: string
  appVersion: string
}

export interface MigrationPlan {
  currentVersion: number
  targetVersion: number
  pending: Migration[]
}

export const migrationChecksum = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

export function ensureMigrationTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    app_version TEXT NOT NULL
  ) STRICT`)
}

export function getAppliedMigrations(db: Database): AppliedMigration[] {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (!exists) return []
  return db
    .prepare(
      'SELECT version, name, checksum, applied_at AS appliedAt, app_version AS appVersion FROM schema_migrations ORDER BY version'
    )
    .all() as AppliedMigration[]
}

export function currentSchemaVersion(db: Database): number {
  const applied = getAppliedMigrations(db)
  return applied.length ? applied[applied.length - 1]!.version : 0
}

/**
 * Compares the database's migration history with the migrations bundled in this build.
 * Refuses to run against a database from a newer build or with altered history.
 */
export function planMigrations(db: Database, migrations: readonly Migration[]): MigrationPlan {
  validateMigrationList(migrations)
  const applied = getAppliedMigrations(db)
  const known = new Map(migrations.map((m) => [m.version, m]))

  for (const row of applied) {
    const m = known.get(row.version)
    if (!m) {
      throw new AppError(
        'DATABASE_ERROR',
        `Database schema version ${row.version} is newer than this application supports. Install the matching or newer application version.`
      )
    }
    if (migrationChecksum(m.sql) !== row.checksum) {
      throw new AppError(
        'DATABASE_ERROR',
        `Migration ${row.version} (${row.name}) checksum does not match the applied history.`
      )
    }
  }

  const currentVersion = applied.length ? applied[applied.length - 1]!.version : 0
  const pending = migrations.filter((m) => m.version > currentVersion)
  const targetVersion = migrations.length ? migrations[migrations.length - 1]!.version : 0
  return { currentVersion, targetVersion, pending }
}

/** Applies each pending migration in its own transaction; a failure rolls that step back. */
export function applyMigrations(db: Database, pending: readonly Migration[], appVersion: string): void {
  ensureMigrationTable(db)
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)'
  )
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      record.run(m.version, m.name, migrationChecksum(m.sql), nowIso(), appVersion)
    })()
  }
}

function validateMigrationList(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration list must be contiguous from 1; found version ${m.version} at index ${i}`)
    }
  })
}
