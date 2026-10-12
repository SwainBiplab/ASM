import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDataPaths } from '../../src/main/app/env'
import { openDatabase } from '../../src/main/database/connection'
import { DatabaseManager } from '../../src/main/database/manager'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/database/migrations'
import { migrationChecksum, type Migration } from '../../src/main/database/migrator'
import { silentLogger } from '../../src/main/logging/logger'
import { createReadyApp, createTestApp, makeTempDir, type TestApp } from '../helpers'

const dirs: string[] = []
const apps: TestApp[] = []
afterEach(() => {
  apps.splice(0).forEach((a) => a.cleanup())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tempDir = (): string => {
  const d = makeTempDir()
  dirs.push(d)
  return d
}

describe('migrations on a fresh installation', () => {
  it('creates the schema, records history and reports setup_required', async () => {
    const root = tempDir()
    const dbm = new DatabaseManager(resolveDataPaths(root), silentLogger, '1.0.0')
    expect(await dbm.open()).toBe('setup_required')
    const tables = (dbm.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
    for (const t of ['organization_profile', 'users', 'roles', 'permissions', 'role_permissions', 'user_roles', 'audit_events', 'app_settings', 'backup_history', 'schema_migrations']) {
      expect(tables).toContain(t)
    }
    const history = dbm.db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{ version: number; checksum: string }>
    expect(history).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: migrationChecksum(m.sql) })))
    expect(dbm.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(existsSync(dbm.paths.initializedMarker)).toBe(true)
    dbm.close()
  })

  it('is idempotent when reopened', async () => {
    const root = tempDir()
    const paths = resolveDataPaths(root)
    const a = new DatabaseManager(paths, silentLogger, '1.0.0')
    await a.open()
    a.close()
    const b = new DatabaseManager(paths, silentLogger, '1.0.0')
    await b.open()
    expect((b.db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(MIGRATIONS.length)
    b.close()
  })
})

describe('migration safety', () => {
  it('refuses a database created by a newer application version', async () => {
    const root = tempDir()
    const paths = resolveDataPaths(root)
    const a = new DatabaseManager(paths, silentLogger, '1.0.0')
    await a.open()
    a.db.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'x', '2030-01-01T00:00:00Z', '9.9.9')").run()
    a.close()
    const b = new DatabaseManager(paths, silentLogger, '1.0.0')
    await expect(b.open()).rejects.toMatchObject({ code: 'DATABASE_ERROR', message: expect.stringContaining('newer') })
  })

  it('detects altered migration history', async () => {
    const root = tempDir()
    const paths = resolveDataPaths(root)
    const a = new DatabaseManager(paths, silentLogger, '1.0.0')
    await a.open()
    a.db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run()
    a.close()
    await expect(new DatabaseManager(paths, silentLogger, '1.0.0').open()).rejects.toMatchObject({ message: expect.stringContaining('checksum') })
  })

  it('takes a pre-migration backup before upgrading an existing database', async () => {
    const app = await createReadyApp()
    apps.push(app)
    app.container.shutdown()

    const upgrade: Migration = { version: LATEST_SCHEMA_VERSION + 1, name: 'test_upgrade', sql: 'CREATE TABLE upgrade_probe (id TEXT PRIMARY KEY) STRICT;' }
    const backups: string[] = []
    const dbm = new DatabaseManager(app.container.paths, silentLogger, '1.1.0', {
      beforeMigrate: async (db, plan) => {
        expect(plan.currentVersion).toBe(LATEST_SCHEMA_VERSION)
        backups.push(String((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n))
      }
    }, [...MIGRATIONS, upgrade])
    await dbm.open()
    expect(backups).toEqual(['1'])
    expect(dbm.schemaVersion()).toBe(LATEST_SCHEMA_VERSION + 1)
    dbm.close()
  })

  it('rolls back a failing migration step', async () => {
    const root = tempDir()
    const paths = resolveDataPaths(root)
    const ok = new DatabaseManager(paths, silentLogger, '1.0.0')
    await ok.open()
    ok.close()
    const broken: Migration = { version: LATEST_SCHEMA_VERSION + 1, name: 'broken', sql: 'CREATE TABLE half_done (id TEXT); INSERT INTO no_such_table VALUES (1);' }
    await expect(new DatabaseManager(paths, silentLogger, '1.1.0', {}, [...MIGRATIONS, broken]).open()).rejects.toMatchObject({ code: 'DATABASE_ERROR' })
    const db = openDatabase(paths.databaseFile)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined()
    expect((db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(LATEST_SCHEMA_VERSION)
    db.close()
  })
})

describe('schema constraints', () => {
  it('keeps audit events append-only', async () => {
    const app = await createReadyApp()
    apps.push(app)
    const db = app.container.dbm.db
    expect((db.prepare('SELECT count(*) AS n FROM audit_events').get() as { n: number }).n).toBeGreaterThan(0)
    expect(() => db.prepare("UPDATE audit_events SET reason = 'x'").run()).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/)
  })

  it('allows exactly one organization profile', async () => {
    const app = await createReadyApp()
    apps.push(app)
    const db = app.container.dbm.db
    expect(() =>
      db.prepare("INSERT INTO organization_profile (id, legal_name, display_name, base_currency, timezone, created_at, updated_at) VALUES ('o2','B','B','INR','UTC','t','t')").run()
    ).toThrow(/UNIQUE/)
  })

  it('enforces foreign keys and strict column types', async () => {
    const app = await createReadyApp()
    apps.push(app)
    const db = app.container.dbm.db
    expect(() => db.prepare("INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES ('nope', 'nope', 't')").run()).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare("UPDATE users SET failed_login_count = 'many'").run()).toThrow()
    expect(() => db.prepare('UPDATE users SET failed_login_count = -1').run()).toThrow(/CHECK/)
  })
})

describe('startup recovery behaviour', () => {
  it('does not create a blank database when an initialized database is missing', async () => {
    const app = await createReadyApp()
    const root = app.root
    app.container.shutdown()
    rmSync(app.container.paths.databaseFile)

    const again = await createTestApp(root)
    apps.push(again)
    expect(again.container.startup.status).toBe('database_error')
    expect(again.container.startup.error?.message).toMatch(/missing/)
    expect(existsSync(again.container.paths.databaseFile)).toBe(false)
  })

  it('reports a corrupt database file without overwriting it', async () => {
    const root = tempDir()
    const paths = resolveDataPaths(root)
    mkdirSync(paths.databaseDir, { recursive: true })
    const garbage = Buffer.from('this is not a sqlite database'.repeat(200))
    writeFileSync(paths.databaseFile, garbage)

    const app = await createTestApp(root)
    apps.push(app)
    expect(app.container.startup.status).toBe('database_error')
    expect(readFileSync(paths.databaseFile).equals(garbage)).toBe(true)
    const r = await app.call('session.login', { username: 'a', password: 'b' })
    expect(r.ok).toBe(false)
  })

  it('persists data across restart', async () => {
    const app = await createReadyApp()
    const root = app.root
    app.container.shutdown()
    const again = await createTestApp(root)
    apps.push(again)
    expect(again.container.startup.status).toBe('ready')
    expect(readdirSync(join(root, 'database'))).toContain('asset-management.sqlite')
  })
})
