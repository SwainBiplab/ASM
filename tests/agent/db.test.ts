import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalDeviceStore, openAgentDatabase } from '../../agent/main/db/connection'
import { applyMigrations, currentSchemaVersion, ensureMigrationTable, planMigrations } from '../../agent/main/db/migrator'
import { MIGRATIONS } from '../../agent/main/db/migrations'

const dirs: string[] = []
function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bpoam-agent-'))
  dirs.push(dir)
  return join(dir, 'agent.sqlite')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('agent local database foundation', () => {
  it('creates missing parent directories, since this is always a fresh per-user data path on first run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpoam-agent-'))
    dirs.push(dir)
    const nested = join(dir, 'BPOAM-Agent', 'nested', 'agent.sqlite')
    const db = openAgentDatabase(nested)
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version)
    db.close()
  })

  it('migrates a fresh database to the latest version and records its checksummed history', () => {
    const db = openAgentDatabase(tempDbFile())
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version)
    const applied = db.prepare('SELECT version, name FROM agent_schema_migrations ORDER BY version').all()
    expect(applied).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })))
    db.close()
  })

  it('is idempotent: reopening an already-migrated database applies nothing new', () => {
    const file = tempDbFile()
    openAgentDatabase(file).close()
    const db = new Database(file)
    const plan = planMigrations(db, MIGRATIONS)
    expect(plan.pending).toEqual([])
    db.close()
  })

  it('refuses a database whose recorded migration history was altered (checksum mismatch)', () => {
    const file = tempDbFile()
    openAgentDatabase(file).close()
    const db = new Database(file)
    db.prepare("UPDATE agent_schema_migrations SET checksum = 'tampered' WHERE version = 1").run()
    expect(() => planMigrations(db, MIGRATIONS)).toThrow(/checksum does not match/)
    db.close()
  })

  it('rolls back a failing migration step, leaving no partial schema or history row behind', () => {
    const file = tempDbFile()
    const db = new Database(file)
    ensureMigrationTable(db)
    const badMigration = { version: 1, name: 'broken', sql: 'CREATE TABLE ok (id TEXT); THIS IS NOT VALID SQL;' }
    expect(() => applyMigrations(db, [badMigration])).toThrow()
    expect(currentSchemaVersion(db)).toBe(0)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ok'").get()).toBeUndefined()
    db.close()
  })

  it('creates exactly one local device identity row and returns the same one on every later call', async () => {
    const db = openAgentDatabase(tempDbFile())
    const store = createLocalDeviceStore(db)
    const first = await store.getLocalDevice()
    const second = await store.getLocalDevice()
    expect(second).toEqual(first)
    const rows = db.prepare('SELECT count(*) AS n FROM local_device').get() as { n: number }
    expect(rows.n).toBe(1)
    db.close()
  })
})
