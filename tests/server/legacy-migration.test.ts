import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/main/database/migrator'
import { MIGRATIONS as LEGACY_MIGRATIONS } from '../../src/main/database/migrations'
import { applyLegacyMigration, openLegacyDatabase, planLegacyMigration, verifyLegacyMigration } from '../../server/src/migration/legacyMigration'
import { createApiSession, type ApiSession } from './session-helpers'

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})
const session = async () => {
  const a = await createApiSession()
  sessions.push(a)
  return a
}

/** Builds a throwaway legacy SQLite fixture using the prototype's own migrator (not guessed SQL). */
function buildLegacyFixture(): { dbPath: string; docsRoot: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bpoam-legacy-'))
  const dbPath = join(dir, 'legacy.db')
  const docsRoot = join(dir, 'documents')
  mkdirSync(docsRoot, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  applyMigrations(db, LEGACY_MIGRATIONS as never, '1.0.0-test')

  const now = new Date().toISOString()
  const orgId = randomUUID()
  db.prepare('INSERT INTO organization_profile (id, legal_name, display_name, base_currency, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orgId, 'Legacy BPO Services Pvt Ltd', 'Legacy BPO', 'INR', 'Asia/Kolkata', now, now)

  const deptId = randomUUID()
  db.prepare('INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(deptId, orgId, 'OPS', 'ops', 'Operations', 'operations', now, now)
  const demoDeptId = randomUUID()
  db.prepare('INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(demoDeptId, orgId, 'DEMO', 'demo', 'Demo Department', 'demo department', now, now)

  const siteId = randomUUID()
  db.prepare("INSERT INTO locations (id, organization_id, location_type, code, code_normalized, name, name_normalized, is_active, created_at, updated_at) VALUES (?, ?, 'site', ?, ?, ?, ?, 1, ?, ?)")
    .run(siteId, orgId, 'PUN', 'pun', 'Pune Campus', 'pune campus', now, now)
  const floorId = randomUUID()
  db.prepare("INSERT INTO locations (id, organization_id, parent_location_id, location_type, name, name_normalized, is_active, created_at, updated_at) VALUES (?, ?, ?, 'floor', ?, ?, 1, ?, ?)")
    .run(floorId, orgId, siteId, 'Floor 3', 'floor 3', now, now)

  const catId = randomUUID()
  db.prepare("INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, asset_domain, tracking_mode, serial_required, serial_unique, is_active, created_at, updated_at) VALUES (?, ?, 'LAP', 'lap', 'Laptop', 'laptop', 'it', 'individual', 0, 0, 1, ?, ?)")
    .run(catId, orgId, now, now)
  const modelId = randomUUID()
  db.prepare('INSERT INTO asset_models (id, organization_id, category_id, manufacturer, manufacturer_normalized, model_name, model_name_normalized, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(modelId, orgId, catId, 'Dell', 'dell', 'Latitude', 'latitude', now, now)
  const supplierId = randomUUID()
  db.prepare('INSERT INTO suppliers (id, organization_id, name, name_normalized, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(supplierId, orgId, 'Acme Supplies', 'acme supplies', now, now)

  const managerId = randomUUID()
  db.prepare("INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, department_id, work_location_id, employment_status, created_at, updated_at) VALUES (?, ?, 'E001', 'e001', 'Priya Manager', ?, ?, 'active', ?, ?)")
    .run(managerId, orgId, deptId, floorId, now, now)
  const empId = randomUUID()
  db.prepare("INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, department_id, work_location_id, manager_employee_id, employment_status, created_at, updated_at) VALUES (?, ?, 'E002', 'e002', 'Ravi Kumar', ?, ?, ?, 'active', ?, ?)")
    .run(empId, orgId, deptId, floorId, managerId, now, now)

  const assetId = randomUUID()
  db.prepare(
    "INSERT INTO assets (id, organization_id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, lifecycle_status, operational_status, condition, location_id, supplier_id, purchase_date, acquisition_cost_minor, currency, created_at, updated_at) VALUES (?, ?, 'AST-000042', ?, ?, 'Dell', 'Latitude', 'SN-LEGACY-1', 'SN-LEGACY-1', 'active', 'ready', 'good', ?, ?, '2024-01-15', 4500000, 'INR', ?, ?)"
  ).run(assetId, orgId, catId, modelId, floorId, supplierId, now, now)

  const docBytes = Buffer.from('%PDF-1.4 legacy invoice');
  const storageKey = `${assetId}/invoice.pdf`
  mkdirSync(join(docsRoot, assetId), { recursive: true })
  writeFileSync(join(docsRoot, storageKey), docBytes)
  const sha256 = createHash('sha256').update(docBytes).digest('hex')
  const documentId = randomUUID()
  db.prepare('INSERT INTO documents (id, organization_id, storage_key, original_name, mime_type, byte_size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(documentId, orgId, storageKey, 'invoice.pdf', 'application/pdf', docBytes.byteLength, sha256, now)
  db.prepare("INSERT INTO document_links (id, document_id, entity_type, entity_id, purpose, created_at) VALUES (?, ?, 'asset', ?, 'invoice', ?)")
    .run(randomUUID(), documentId, assetId, now)

  const roleId = randomUUID()
  db.prepare("INSERT INTO roles (id, organization_id, key, name, created_at, updated_at) VALUES (?, ?, 'asset_manager', 'Asset Manager', ?, ?)").run(roleId, orgId, now, now)
  const legacyUserId = randomUUID()
  db.prepare("INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash, password_changed_at, created_at, updated_at) VALUES (?, ?, 'legacyuser', 'legacyuser', 'Legacy User', 'unused-legacy-hash', ?, ?, ?)")
    .run(legacyUserId, orgId, now, now, now)
  db.prepare('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)').run(legacyUserId, roleId, now)

  db.close()
  return {
    dbPath,
    docsRoot,
    close: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // Best-effort cleanup only; a locked temp dir on Windows (AV/indexer) doesn't affect test correctness.
      }
    }
  }
}

describe('legacy SQLite to PostgreSQL migration', () => {
  it('dry-runs without writing, then applies idempotently, migrating every supported entity and excluding the demo department', async () => {
    const a = await session()
    const fixture = buildLegacyFixture()
    try {
      const legacy = openLegacyDatabase(fixture.dbPath)
      const [org] = await a.sql<{ id: string }>('SELECT id FROM organizations LIMIT 1')
      const [admin] = await a.sql<{ id: string }>("SELECT id FROM users WHERE username_normalized = 'admin'")
      const opts = { organizationId: org!.id, actorUserId: admin!.id, legacyDocumentsRoot: fixture.docsRoot, storage: a.s.storage }

      const plan = await planLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(plan.mode).toBe('plan')
      expect(plan.aborted).toBe(false)
      expect(plan.counts['departments']).toMatchObject({ insert: 1, skip: 1 }) // 1 real + 1 demo-skipped
      expect(await a.sql('SELECT 1 FROM departments')).toHaveLength(0) // dry run writes nothing

      const applied = await applyLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(applied.mode).toBe('apply')
      expect(applied.aborted).toBe(false)
      expect(await a.sql('SELECT 1 FROM departments')).toHaveLength(1)
      expect(await a.sql('SELECT 1 FROM locations')).toHaveLength(2)
      expect(await a.sql('SELECT 1 FROM employees')).toHaveLength(2)
      const [migratedManager] = await a.sql<{ id: string }>("SELECT id FROM employees WHERE employee_code = 'E001'")
      const [migratedEmployee] = await a.sql<{ managerId: string | null }>('SELECT manager_employee_id AS "managerId" FROM employees WHERE employee_code = \'E002\'')
      expect(migratedEmployee!.managerId).toBe(migratedManager!.id)
      const [migratedAsset] = await a.sql<{ code: string; cost: number }>("SELECT asset_code AS code, acquisition_cost_minor AS cost FROM assets WHERE asset_code = 'AST-000042'")
      expect(migratedAsset).toMatchObject({ code: 'AST-000042', cost: 4500000 })
      const [codeConfig] = await a.sql<{ next: number }>('SELECT next_number AS next FROM asset_code_config WHERE organization_id = $1', [org!.id])
      expect(codeConfig!.next).toBeGreaterThanOrEqual(43) // bumped past the migrated AST-000042
      const [doc] = await a.sql<{ name: string }>("SELECT original_name AS name FROM documents WHERE original_name = 'invoice.pdf'")
      expect(doc!.name).toBe('invoice.pdf')
      const [migratedUser] = await a.sql<{ username: string; mustChange: boolean }>("SELECT username, must_change_password AS \"mustChange\" FROM users WHERE username_normalized = 'legacyuser'")
      expect(migratedUser).toMatchObject({ username: 'legacyuser', mustChange: true })
      const [roleAssignment] = await a.sql<{ key: string }>(
        "SELECT r.key FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.username_normalized = 'legacyuser'"
      )
      expect(roleAssignment!.key).toBe('asset_manager')
      expect(await a.sql('SELECT 1 FROM departments WHERE name = \'Demo Department\'')).toHaveLength(0)

      // Re-applying is a no-op: every row is already recorded, nothing is duplicated.
      const second = await applyLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(second.items.every((i) => i.action === 'skip')).toBe(true)
      expect(await a.sql('SELECT 1 FROM assets')).toHaveLength(1)
      expect(await a.sql('SELECT 1 FROM employees')).toHaveLength(2)

      const verification = await verifyLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(verification.ok).toBe(true)
      expect(verification.countsMatch['assets']).toMatchObject({ migrated: 1 })

      legacy.close()
    } finally {
      fixture.close()
    }
  })

  it('aborts the whole apply, writing nothing, when a row conflicts with an existing unrelated target record', async () => {
    const a = await session()
    const fixture = buildLegacyFixture()
    try {
      const legacy = openLegacyDatabase(fixture.dbPath)
      const [org] = await a.sql<{ id: string }>('SELECT id FROM organizations LIMIT 1')
      const [admin] = await a.sql<{ id: string }>("SELECT id FROM users WHERE username_normalized = 'admin'")
      // Pre-create a department with the same name as the legacy one, not via this migration tool.
      await a.ok('departments.create', { code: null, name: 'Operations', managerEmployeeId: null, notes: null })

      const opts = { organizationId: org!.id, actorUserId: admin!.id }
      const applied = await applyLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(applied.aborted).toBe(true)
      expect(applied.items.some((i) => i.entity === 'departments' && i.action === 'reject')).toBe(true)
      // Nothing from the rest of the migration was written either, since the whole apply rolled back.
      expect(await a.sql('SELECT 1 FROM assets')).toHaveLength(0)
      expect(await a.sql('SELECT 1 FROM employees')).toHaveLength(0)

      legacy.close()
    } finally {
      fixture.close()
    }
  })

  it('refuses to apply while an offline lease is active on the target organization, writing nothing (W9.2, D49/F)', async () => {
    const a = await session()
    const fixture = buildLegacyFixture()
    try {
      const legacy = openLegacyDatabase(fixture.dbPath)
      const [org] = await a.sql<{ id: string }>('SELECT id FROM organizations LIMIT 1')
      const [admin] = await a.sql<{ id: string }>("SELECT id FROM users WHERE username_normalized = 'admin'")
      const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Migration Guard Device' })
      await a.ok('devices.approve', { deviceId: device.id, trustNotes: 'Verified' })
      await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset_code_range', count: 10 }, durationHours: 4 })

      const opts = { organizationId: org!.id, actorUserId: admin!.id, legacyDocumentsRoot: fixture.docsRoot, storage: a.s.storage }
      // plan/dry-run is unaffected: it never writes, so it stays usable for inspection.
      const plan = await planLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(plan.aborted).toBe(false)

      const applied = await applyLegacyMigration(legacy, a.s.tdb.db, opts)
      expect(applied.aborted).toBe(true)
      expect(applied.items[0]).toMatchObject({ action: 'reject', reason: expect.stringContaining('offline lease is active') })
      expect(await a.sql('SELECT 1 FROM departments')).toHaveLength(0)
      expect(await a.sql('SELECT 1 FROM assets WHERE asset_code = \'AST-000042\'')).toHaveLength(0)

      legacy.close()
    } finally {
      fixture.close()
    }
  })
})
