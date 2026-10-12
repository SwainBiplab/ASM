import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, migrationChecksum, schemaVersion, type Migration } from '../../server/src/db/migrator'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../server/src/db/migrations'
import { createTestDatabase, type TestDatabase } from './db-helpers'

const dbs: TestDatabase[] = []
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.drop()
})
const fresh = async (m = true) => {
  const t = await createTestDatabase({ migrate: m })
  dbs.push(t)
  return t.db
}

describe('PostgreSQL migrations', () => {
  it('applies every migration to an empty database and records checksums', async () => {
    const db = await fresh(false)
    expect(await schemaVersion(db)).toBe(0)
    expect(await migrate(db, MIGRATIONS, 't')).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION })
    const rows = await db.many<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version')
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: migrationChecksum(m.sql) })))
  })

  it('is idempotent and safe to run concurrently (advisory lock)', async () => {
    const db = await fresh(false)
    await Promise.all([migrate(db, MIGRATIONS, 't'), migrate(db, MIGRATIONS, 't'), migrate(db, MIGRATIONS, 't')])
    expect((await db.one<{ n: number }>('SELECT count(*) AS n FROM schema_migrations'))!.n).toBe(MIGRATIONS.length)
  })

  it('refuses altered history and newer schemas', async () => {
    const db = await fresh()
    await db.exec("UPDATE schema_migrations SET checksum = 'x' WHERE version = 1")
    await expect(migrate(db, MIGRATIONS, 't')).rejects.toThrow(/checksum/)
    await db.exec('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', [migrationChecksum(MIGRATIONS[0]!.sql)])
    await db.exec("INSERT INTO schema_migrations (version, name, checksum, app_version) VALUES (999, 'future', 'x', '9')")
    await expect(migrate(db, MIGRATIONS, 't')).rejects.toThrow(/newer/)
  })

  it('rolls back a failing migration completely', async () => {
    const db = await fresh()
    const broken: Migration = { version: LATEST_SCHEMA_VERSION + 1, name: 'broken', sql: 'CREATE TABLE half_done (id int); SELECT * FROM no_such_table;' }
    await expect(migrate(db, [...MIGRATIONS, broken], 't')).rejects.toThrow(/broken/)
    expect((await db.one<{ t: string | null }>("SELECT to_regclass('public.half_done') AS t"))!.t).toBeNull()
    expect(await schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('upgrades a populated W1 database to the latest schema without rewriting its history', async () => {
    const db = await fresh(false)
    await migrate(db, MIGRATIONS.slice(0, 2), 't')
    const [org, user] = [randomUUID(), randomUUID()]
    await db.exec("INSERT INTO organizations (id, legal_name, display_name, base_currency, timezone, created_at) VALUES ($1, 'W1 BPO', 'W1', 'INR', 'Asia/Kolkata', '2026-01-01T00:00:00Z')", [org])
    await db.exec("INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash) VALUES ($1, $2, 'admin', 'admin', 'Admin', 'scrypt$x')", [user, org])
    for (let i = 0; i < 5; i++) {
      await db.exec("INSERT INTO audit_events (id, organization_id, actor_user_id, event_type, entity_type, correlation_id, occurred_at) VALUES ($1, $2, $3, 'w1.event', 'user', $4, $5)", [
        randomUUID(), org, user, `c${i}`, `2026-01-0${i + 1}T00:00:00Z`
      ])
    }
    const auditBefore = await db.many<{ id: string; occurred_at: string; correlation_id: string }>('SELECT id, occurred_at, correlation_id FROM audit_events ORDER BY seq')

    expect(await migrate(db, MIGRATIONS, 't')).toEqual({ from: 2, to: LATEST_SCHEMA_VERSION })
    expect(await db.many('SELECT id, occurred_at, correlation_id FROM audit_events ORDER BY seq')).toEqual(auditBefore)
    expect((await db.one<{ n: string }>('SELECT username AS n FROM users WHERE id = $1', [user]))!.n).toBe('admin')
    // Existing organizations receive the default asset-code counter (TAS B1, D20).
    expect(await db.one('SELECT prefix, separator, padding, next_number FROM asset_code_config WHERE organization_id = $1', [org])).toEqual({ prefix: 'AST', separator: '-', padding: 6, next_number: 1 })
  })

  it('keeps audit events append-only and user roles inside their organization', async () => {
    const db = await fresh()
    const [o1, o2, u1, r2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    await db.exec("INSERT INTO organizations (id, legal_name, display_name, base_currency, timezone) VALUES ($1, 'A', 'A', 'INR', 'Asia/Kolkata'), ($2, 'B', 'B', 'INR', 'Asia/Kolkata')", [o1, o2])
    await db.exec("INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash) VALUES ($1, $2, 'u', 'u', 'U', 'x')", [u1, o1])
    await db.exec("INSERT INTO roles (id, organization_id, key, name) VALUES ($1, $2, 'r', 'R')", [r2, o2])
    // Cross-organization role assignment is impossible at the database level.
    await expect(db.exec('INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)', [o1, u1, r2])).rejects.toMatchObject({ code: '23503' })

    await db.exec("INSERT INTO audit_events (id, organization_id, event_type, entity_type, correlation_id) VALUES ($1, $2, 'x', 'y', 'c')", [randomUUID(), o1])
    await expect(db.exec("UPDATE audit_events SET reason = 'x'")).rejects.toThrow(/append-only/)
    await expect(db.exec('DELETE FROM audit_events')).rejects.toThrow(/append-only/)
    await expect(db.exec('TRUNCATE audit_events')).rejects.toThrow(/append-only/)
  })
})
