import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { hashPassword } from '../auth/password'
import { newId } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { normalizeKey } from '../services/common'
import type { DocumentStorage } from '../storage/storage'

/**
 * One-way SQLite (frozen Electron prototype) -> PostgreSQL (cloud app) migration (W8, TAS §21,
 * ARCHITECTURE_V2 §8, B5). The source database is opened read-only and is never written to.
 *
 * Scope: the prototype predates allocations, maintenance, physical audits and procurement
 * entirely (they don't exist in its schema — confirmed by reading
 * `src/main/database/migrations/000{1,2,3}_*.ts`, not inferred from the old spec), so there is
 * nothing to migrate for those modules. Migrated: departments, locations (hierarchical),
 * employees, asset categories/models, suppliers, assets, asset documents, users and their role
 * assignments. Explicitly NOT migrated (see `EXCLUDED` below and KNOWN_ISSUES.md): teams,
 * workstations, and asset pools (unreferenced by any other migrated row in this schema, so
 * skipping them loses no relationship); `audit_events` and `backup_history` (operational/history
 * data of the old app, not business records); `app_settings` and `asset_code_config` (the target
 * organization's own configuration is authoritative; only the asset-code *counter* is bumped
 * past the highest migrated code to prevent future collisions); legacy password hashes (a fresh,
 * random, must-change password is issued instead, per the explicit instruction not to let legacy
 * local authentication bypass the server's password policy).
 */
export const EXCLUDED_ENTITIES = ['teams', 'workstations', 'asset_pools', 'audit_events', 'app_settings', 'asset_code_config (counter only)', 'password_hash'] as const

export interface LegacyMigrationOptions {
  organizationId: string
  /** Attributed as the actor on migration audit events; must be an existing active user in the target organization. */
  actorUserId: string
  /** Required only if documents are to be migrated: the prototype's documents folder and storage driver for the target. */
  legacyDocumentsRoot?: string
  storage?: DocumentStorage
  /** Rows whose name/code match this pattern are skipped as demo/test data (TAS: "exclude demo and test data"). */
  demoPattern?: RegExp
}

export type PlanAction = 'insert' | 'skip' | 'reject'
export interface PlanItem {
  entity: string
  sourceId: string
  label: string
  action: PlanAction
  reason: string
}
export interface MigrationReport {
  mode: 'plan' | 'apply'
  items: PlanItem[]
  counts: Record<string, { insert: number; skip: number; reject: number }>
  /** Set when apply was aborted before writing anything, because at least one row conflicted with an existing, unrelated target record. */
  aborted: boolean
}

const DEFAULT_DEMO_PATTERN = /\b(demo|test|sample)\b/i

function tally(items: PlanItem[]): MigrationReport['counts'] {
  const counts: MigrationReport['counts'] = {}
  for (const i of items) {
    counts[i.entity] ??= { insert: 0, skip: 0, reject: 0 }
    counts[i.entity]![i.action]++
  }
  return counts
}

/** Opens the legacy database strictly read-only; `query_only` makes even an accidental write throw. */
export function openLegacyDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

interface Ctx {
  legacy: Database.Database
  t: SqlClient
  org: string
  opts: Required<Pick<LegacyMigrationOptions, 'organizationId' | 'actorUserId'>> & LegacyMigrationOptions
  write: boolean
  items: PlanItem[]
  idMap: Map<string, string> // `${table}:${legacyId}` -> target uuid
}

async function alreadyMigrated(c: Ctx, table: string, sourceId: string): Promise<string | null> {
  const row = await c.t.one<{ targetId: string }>(
    'SELECT target_id AS "targetId" FROM legacy_migration_records WHERE organization_id = $1 AND source_table = $2 AND source_id = $3',
    [c.org, table, sourceId]
  )
  return row?.targetId ?? null
}

async function recordMigrated(c: Ctx, table: string, sourceId: string, targetTable: string, targetId: string): Promise<void> {
  await c.t.exec(
    'INSERT INTO legacy_migration_records (organization_id, source_table, source_id, target_table, target_id) VALUES ($1, $2, $3, $4, $5)',
    [c.org, table, sourceId, targetTable, targetId]
  )
}

function isDemo(opts: LegacyMigrationOptions, ...fields: Array<string | null | undefined>): boolean {
  const pattern = opts.demoPattern ?? DEFAULT_DEMO_PATTERN
  return fields.some((f) => f && pattern.test(f))
}

/** Generic "insert, or skip if already migrated, or reject if it would collide with an unrelated existing row" step. */
async function migrateRow(
  c: Ctx,
  entity: string,
  sourceId: string,
  label: string,
  demo: boolean,
  conflict: () => Promise<boolean>,
  insert: () => Promise<string>
): Promise<string | null> {
  const existing = await alreadyMigrated(c, entity, sourceId)
  if (existing) {
    c.items.push({ entity, sourceId, label, action: 'skip', reason: 'already migrated in a previous run' })
    return existing
  }
  if (demo) {
    c.items.push({ entity, sourceId, label, action: 'skip', reason: 'matches the demo/test data pattern' })
    return null
  }
  if (await conflict()) {
    c.items.push({ entity, sourceId, label, action: 'reject', reason: 'conflicts with an existing record not created by this migration' })
    return null
  }
  c.items.push({ entity, sourceId, label, action: 'insert', reason: c.write ? 'inserted' : 'would be inserted' })
  if (!c.write) return null
  const targetId = await insert()
  await recordMigrated(c, entity, sourceId, entity, targetId)
  c.idMap.set(`${entity}:${sourceId}`, targetId)
  return targetId
}

async function migrateDepartments(c: Ctx): Promise<void> {
  const rows = c.legacy.prepare('SELECT id, code, name, notes, is_active FROM departments').all() as Array<{ id: string; code: string | null; name: string; notes: string | null; is_active: number }>
  for (const r of rows) {
    await migrateRow(
      c, 'departments', r.id, r.name, isDemo(c.opts, r.code, r.name),
      async () => !!(await c.t.one('SELECT 1 FROM departments WHERE organization_id = $1 AND name_normalized = $2', [c.org, normalizeKey(r.name)])),
      async () => {
        const id = newId()
        await c.t.exec(
          'INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, notes, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [id, c.org, r.code, r.code ? normalizeKey(r.code) : null, r.name, normalizeKey(r.name), r.notes, r.is_active === 1]
        )
        return id
      }
    )
  }
}

async function migrateLocations(c: Ctx): Promise<void> {
  const rows = c.legacy.prepare('SELECT id, parent_location_id, location_type, code, name, notes, is_active FROM locations').all() as Array<{
    id: string; parent_location_id: string | null; location_type: string; code: string | null; name: string; notes: string | null; is_active: number
  }>
  const pending = new Map(rows.map((r) => [r.id, r]))
  // Parents must exist before children; loop until nothing more resolves (legacy data cannot cycle, its own CHECK forbids self-reference).
  let progressed = true
  while (pending.size > 0 && progressed) {
    progressed = false
    for (const [id, r] of [...pending]) {
      const parentTargetId = r.parent_location_id ? c.idMap.get(`locations:${r.parent_location_id}`) : null
      if (r.parent_location_id && parentTargetId === undefined && !(await alreadyMigrated(c, 'locations', r.parent_location_id))) continue
      const resolvedParent = r.parent_location_id ? (parentTargetId ?? (await alreadyMigrated(c, 'locations', r.parent_location_id))) : null
      await migrateRow(
        c, 'locations', id, r.name, isDemo(c.opts, r.code, r.name),
        async () => !!(await c.t.one('SELECT 1 FROM locations WHERE organization_id = $1 AND COALESCE(parent_location_id::text, $4) = COALESCE($2::text, $4) AND name_normalized = $3', [c.org, resolvedParent, normalizeKey(r.name), '00000000-0000-0000-0000-000000000000'])),
        async () => {
          const newLocId = newId()
          await c.t.exec(
            'INSERT INTO locations (id, organization_id, parent_location_id, location_type, code, code_normalized, name, name_normalized, notes, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [newLocId, c.org, resolvedParent, r.location_type, r.code, r.code ? normalizeKey(r.code) : null, r.name, normalizeKey(r.name), r.notes, r.is_active === 1]
          )
          return newLocId
        }
      )
      pending.delete(id)
      progressed = true
    }
  }
  for (const [id, r] of pending) c.items.push({ entity: 'locations', sourceId: id, label: r.name, action: 'reject', reason: 'parent location could not be resolved' })
}

async function migrateCategories(c: Ctx): Promise<void> {
  const rows = c.legacy.prepare('SELECT id, code, name, description, asset_domain, tracking_mode, serial_required, serial_unique, is_active FROM asset_categories').all() as Array<{
    id: string; code: string; name: string; description: string | null; asset_domain: string; tracking_mode: string; serial_required: number; serial_unique: number; is_active: number
  }>
  for (const r of rows) {
    await migrateRow(
      c, 'asset_categories', r.id, r.name, isDemo(c.opts, r.code, r.name),
      async () => !!(await c.t.one('SELECT 1 FROM asset_categories WHERE organization_id = $1 AND name_normalized = $2', [c.org, normalizeKey(r.name)])),
      async () => {
        const id = newId()
        await c.t.exec(
          `INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, description, asset_domain, tracking_mode, serial_required, serial_unique, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [id, c.org, r.code, normalizeKey(r.code), r.name, normalizeKey(r.name), r.description, r.asset_domain, r.tracking_mode, r.serial_required === 1, r.serial_unique === 1, r.is_active === 1]
        )
        return id
      }
    )
  }
}

async function migrateModels(c: Ctx): Promise<void> {
  const rows = c.legacy.prepare('SELECT id, category_id, manufacturer, model_name, model_number, specifications, is_active FROM asset_models').all() as Array<{
    id: string; category_id: string; manufacturer: string; model_name: string; model_number: string | null; specifications: string | null; is_active: number
  }>
  for (const r of rows) {
    const categoryId = c.idMap.get(`asset_categories:${r.category_id}`) ?? (await alreadyMigrated(c, 'asset_categories', r.category_id))
    if (!categoryId) {
      c.items.push({ entity: 'asset_models', sourceId: r.id, label: `${r.manufacturer} ${r.model_name}`, action: 'reject', reason: 'category was not migrated' })
      continue
    }
    await migrateRow(
      c, 'asset_models', r.id, `${r.manufacturer} ${r.model_name}`, isDemo(c.opts, r.manufacturer, r.model_name),
      async () => !!(await c.t.one('SELECT 1 FROM asset_models WHERE category_id = $1 AND manufacturer_normalized = $2 AND model_name_normalized = $3', [categoryId, normalizeKey(r.manufacturer), normalizeKey(r.model_name)])),
      async () => {
        const id = newId()
        await c.t.exec(
          `INSERT INTO asset_models (id, organization_id, category_id, manufacturer, manufacturer_normalized, model_name, model_name_normalized, model_number, specifications, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, c.org, categoryId, r.manufacturer, normalizeKey(r.manufacturer), r.model_name, normalizeKey(r.model_name), r.model_number, r.specifications, r.is_active === 1]
        )
        return id
      }
    )
  }
}

async function migrateSuppliers(c: Ctx): Promise<void> {
  const rows = c.legacy.prepare('SELECT id, code, name, contact_name, email, phone, address, tax_reference, notes, is_active FROM suppliers').all() as Array<{
    id: string; code: string | null; name: string; contact_name: string | null; email: string | null; phone: string | null; address: string | null; tax_reference: string | null; notes: string | null; is_active: number
  }>
  for (const r of rows) {
    await migrateRow(
      c, 'suppliers', r.id, r.name, isDemo(c.opts, r.code, r.name),
      async () => !!(await c.t.one('SELECT 1 FROM suppliers WHERE organization_id = $1 AND name_normalized = $2', [c.org, normalizeKey(r.name)])),
      async () => {
        const id = newId()
        await c.t.exec(
          `INSERT INTO suppliers (id, organization_id, code, code_normalized, name, name_normalized, contact_name, email, phone, address, tax_reference, notes, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [id, c.org, r.code, r.code ? normalizeKey(r.code) : null, r.name, normalizeKey(r.name), r.contact_name, r.email, r.phone, r.address, r.tax_reference, r.notes, r.is_active === 1]
        )
        return id
      }
    )
  }
}

async function migrateEmployees(c: Ctx): Promise<void> {
  const rows = c.legacy.prepare(
    `SELECT id, employee_code, full_name, email, phone, job_title, department_id, work_location_id, manager_employee_id, employment_status, joining_date, expected_exit_date, actual_exit_date, notes
     FROM employees`
  ).all() as Array<{
    id: string; employee_code: string; full_name: string; email: string | null; phone: string | null; job_title: string | null; department_id: string | null; work_location_id: string | null;
    manager_employee_id: string | null; employment_status: string; joining_date: string | null; expected_exit_date: string | null; actual_exit_date: string | null; notes: string | null
  }>
  const managerBySource = new Map<string, string>() // legacy employee id -> legacy manager id
  for (const r of rows) {
    if (r.manager_employee_id) managerBySource.set(r.id, r.manager_employee_id)
    const departmentId = r.department_id ? (c.idMap.get(`departments:${r.department_id}`) ?? (await alreadyMigrated(c, 'departments', r.department_id))) : null
    const locationId = r.work_location_id ? (c.idMap.get(`locations:${r.work_location_id}`) ?? (await alreadyMigrated(c, 'locations', r.work_location_id))) : null
    await migrateRow(
      c, 'employees', r.id, r.full_name, isDemo(c.opts, r.employee_code, r.full_name),
      async () => !!(await c.t.one('SELECT 1 FROM employees WHERE organization_id = $1 AND employee_code_normalized = $2', [c.org, normalizeKey(r.employee_code)])),
      async () => {
        const id = newId()
        await c.t.exec(
          `INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, email, email_normalized, phone, job_title, department_id, team_id, work_location_id, employment_status, joining_date, expected_exit_date, actual_exit_date, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13, $14, $15, $16)`,
          [id, c.org, r.employee_code, normalizeKey(r.employee_code), r.full_name, r.email, r.email ? normalizeKey(r.email) : null, r.phone, r.job_title, departmentId, locationId, r.employment_status, r.joining_date, r.expected_exit_date, r.actual_exit_date, r.notes]
        )
        return id
      }
    )
  }
  // Second pass: managers, once every employee that will exist has an id (team_id is left NULL -- teams are not migrated).
  for (const [sourceId, sourceManagerId] of managerBySource) {
    const empId = c.idMap.get(`employees:${sourceId}`)
    const managerId = c.idMap.get(`employees:${sourceManagerId}`) ?? (await alreadyMigrated(c, 'employees', sourceManagerId))
    if (c.write && empId && managerId) await c.t.exec('UPDATE employees SET manager_employee_id = $2 WHERE id = $1', [empId, managerId])
  }
}

async function migrateAssets(c: Ctx): Promise<Map<string, string>> {
  const rows = c.legacy.prepare(
    `SELECT id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, specifications, lifecycle_status, operational_status, condition,
            location_id, supplier_id, purchase_date, acquisition_cost_minor, currency, invoice_reference, purchase_reference, warranty_start, warranty_end,
            disposal_date, disposal_method, disposal_proceeds_minor, notes
     FROM assets`
  ).all() as Array<Record<string, string | number | null>>
  const assetIds = new Map<string, string>()
  let maxNumber = 0
  const codeFmt = (await c.t.one<{ prefix: string; separator: string; padding: number }>('SELECT prefix, separator, padding FROM asset_code_config WHERE organization_id = $1', [c.org])) ?? { prefix: 'AST', separator: '-', padding: 6 }
  const codePattern = new RegExp(`^${codeFmt.prefix}${codeFmt.separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`)

  for (const r of rows) {
    const categoryId = r['category_id'] ? (c.idMap.get(`asset_categories:${r['category_id']}`) ?? (await alreadyMigrated(c, 'asset_categories', String(r['category_id'])))) : null
    const modelId = r['model_id'] ? (c.idMap.get(`asset_models:${r['model_id']}`) ?? (await alreadyMigrated(c, 'asset_models', String(r['model_id'])))) : null
    const locationId = r['location_id'] ? (c.idMap.get(`locations:${r['location_id']}`) ?? (await alreadyMigrated(c, 'locations', String(r['location_id'])))) : null
    const supplierId = r['supplier_id'] ? (c.idMap.get(`suppliers:${r['supplier_id']}`) ?? (await alreadyMigrated(c, 'suppliers', String(r['supplier_id'])))) : null
    if (!categoryId) {
      c.items.push({ entity: 'assets', sourceId: String(r['id']), label: String(r['asset_code']), action: 'reject', reason: 'category was not migrated' })
      continue
    }
    const code = String(r['asset_code'])
    const m = codePattern.exec(code)
    if (m) maxNumber = Math.max(maxNumber, Number(m[1]))
    const targetId = await migrateRow(
      c, 'assets', String(r['id']), code, false,
      async () => !!(await c.t.one('SELECT 1 FROM assets WHERE organization_id = $1 AND asset_code = $2', [c.org, code])),
      async () => {
        const id = newId()
        await c.t.exec(
          `INSERT INTO assets (id, organization_id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, specifications,
                               lifecycle_status, operational_status, condition, location_id, supplier_id, purchase_date, acquisition_cost_minor, currency,
                               invoice_reference, purchase_reference, warranty_start, warranty_end, disposal_date, disposal_method, disposal_proceeds_minor, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
          [id, c.org, code, categoryId, modelId, r['manufacturer'], r['model_name'], r['serial_number'], r['serial_normalized'], r['specifications'],
            r['lifecycle_status'], r['operational_status'], r['condition'], locationId, supplierId, r['purchase_date'], r['acquisition_cost_minor'], r['currency'],
            r['invoice_reference'], r['purchase_reference'], r['warranty_start'], r['warranty_end'], r['disposal_date'], r['disposal_method'], r['disposal_proceeds_minor'], r['notes']]
        )
        return id
      }
    )
    if (targetId) assetIds.set(String(r['id']), targetId)
  }
  if (c.write && maxNumber > 0) {
    await c.t.exec('UPDATE asset_code_config SET next_number = GREATEST(next_number, $2) WHERE organization_id = $1', [c.org, maxNumber + 1])
  }
  return assetIds
}

async function migrateDocuments(c: Ctx, assetIds: Map<string, string>): Promise<void> {
  if (!c.opts.legacyDocumentsRoot || !c.opts.storage) {
    c.items.push({ entity: 'documents', sourceId: '*', label: 'documents', action: 'skip', reason: 'legacyDocumentsRoot / storage not provided; document migration not attempted' })
    return
  }
  const links = c.legacy.prepare(
    `SELECT dl.id AS link_id, dl.document_id, dl.entity_type, dl.entity_id, dl.purpose, d.storage_key, d.original_name, d.mime_type, d.byte_size, d.sha256
     FROM document_links dl JOIN documents d ON d.id = dl.document_id WHERE dl.removed_at IS NULL AND dl.entity_type = 'asset'`
  ).all() as Array<{ link_id: string; document_id: string; entity_type: string; entity_id: string; purpose: string; storage_key: string; original_name: string; mime_type: string; byte_size: number; sha256: string }>

  for (const link of links) {
    const assetId = assetIds.get(link.entity_id) ?? c.idMap.get(`assets:${link.entity_id}`)
    if (!assetId) {
      c.items.push({ entity: 'documents', sourceId: link.link_id, label: link.original_name, action: 'reject', reason: 'owning asset was not migrated' })
      continue
    }
    const existing = await alreadyMigrated(c, 'documents', link.link_id)
    if (existing) {
      c.items.push({ entity: 'documents', sourceId: link.link_id, label: link.original_name, action: 'skip', reason: 'already migrated in a previous run' })
      continue
    }
    let bytes: Buffer
    try {
      bytes = await readFile(join(c.opts.legacyDocumentsRoot, link.storage_key))
    } catch {
      c.items.push({ entity: 'documents', sourceId: link.link_id, label: link.original_name, action: 'reject', reason: 'source file is missing on disk' })
      continue
    }
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== link.sha256) {
      c.items.push({ entity: 'documents', sourceId: link.link_id, label: link.original_name, action: 'reject', reason: 'checksum mismatch: source file does not match its recorded sha256' })
      continue
    }
    c.items.push({ entity: 'documents', sourceId: link.link_id, label: link.original_name, action: c.write ? 'insert' : 'insert', reason: c.write ? 'inserted' : 'would be inserted' })
    if (!c.write) continue
    const documentId = newId()
    const now = new Date()
    const ext = extname(link.original_name).slice(1).toLowerCase() || 'bin'
    const key = `${c.org}/assets/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${documentId}.${ext}`
    await c.opts.storage.put(key, bytes)
    await c.t.exec(
      'INSERT INTO documents (id, organization_id, storage_key, original_name, mime_type, byte_size, sha256, scan_status, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [documentId, c.org, key, link.original_name, link.mime_type, link.byte_size, link.sha256, 'not_scanned', c.opts.actorUserId]
    )
    await c.t.exec(
      'INSERT INTO document_links (id, organization_id, document_id, entity_type, entity_id, purpose, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [newId(), c.org, documentId, 'asset', assetId, link.purpose, c.opts.actorUserId]
    )
    await recordMigrated(c, 'documents', link.link_id, 'documents', documentId)
  }
}

async function migrateUsers(c: Ctx): Promise<void> {
  const users = c.legacy.prepare('SELECT id, username, display_name, is_active FROM users').all() as Array<{ id: string; username: string; display_name: string; is_active: number }>
  for (const u of users) {
    const roleKeys = (c.legacy.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').all(u.id) as Array<{ key: string }>).map((r) => r.key)
    await migrateRow(
      c, 'users', u.id, u.username, isDemo(c.opts, u.username),
      async () => !!(await c.t.one('SELECT 1 FROM users WHERE organization_id = $1 AND username_normalized = $2', [c.org, u.username.toLowerCase()])),
      async () => {
        const id = newId()
        const tempPassword = `Temp-${randomBytes(9).toString('base64url')}`
        const hash = await hashPassword(tempPassword)
        await c.t.exec(
          'INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash, is_active, must_change_password) VALUES ($1, $2, $3, $4, $5, $6, $7, true)',
          [id, c.org, u.username, u.username.toLowerCase(), u.display_name, hash, u.is_active === 1]
        )
        for (const key of roleKeys) {
          const role = await c.t.one<{ id: string }>('SELECT id FROM roles WHERE organization_id = $1 AND key = $2', [c.org, key])
          if (role) await c.t.exec('INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [c.org, id, role.id])
        }
        return id
      }
    )
  }
}

async function run(legacy: Database.Database, t: SqlClient, opts: LegacyMigrationOptions, write: boolean): Promise<MigrationReport> {
  const c: Ctx = { legacy, t, org: opts.organizationId, opts: opts as Ctx['opts'], write, items: [], idMap: new Map() }
  const org = legacy.prepare('SELECT legal_name, display_name FROM organization_profile').get() as { legal_name: string; display_name: string } | undefined
  if (org && isDemo(opts, org.legal_name, org.display_name)) {
    return { mode: write ? 'apply' : 'plan', items: [{ entity: 'organization', sourceId: '-', label: org.display_name, action: 'reject', reason: 'the source organization itself matches the demo/test pattern; pass a narrower demoPattern to override' }], counts: { organization: { insert: 0, skip: 0, reject: 1 } }, aborted: true }
  }
  await migrateDepartments(c)
  await migrateLocations(c)
  await migrateCategories(c)
  await migrateModels(c)
  await migrateSuppliers(c)
  await migrateEmployees(c)
  const assetIds = await migrateAssets(c)
  await migrateDocuments(c, assetIds)
  await migrateUsers(c)

  const hasConflict = c.items.some((i) => i.action === 'reject')
  return { mode: write ? 'apply' : 'plan', items: c.items, counts: tally(c.items), aborted: write && hasConflict }
}

/** Read-only: reports what would happen. Never writes to either database. */
export async function planLegacyMigration(legacy: Database.Database, pg: Db, opts: LegacyMigrationOptions): Promise<MigrationReport> {
  return run(legacy, pg, opts, false)
}

/**
 * Applies the migration transactionally. If any row would conflict with an existing,
 * unrelated target record, the entire apply is rolled back and reported rather than partially
 * applied (TAS: "do not overwrite existing records; stop and report for resolution").
 * Safe to re-run after an interruption: every previously migrated row is skipped via
 * `legacy_migration_records`, never re-inserted.
 */
export async function applyLegacyMigration(legacy: Database.Database, pg: Db, opts: LegacyMigrationOptions): Promise<MigrationReport> {
  let report!: MigrationReport
  await pg.tx(async (t) => {
    // F (W9.2, DECISIONS.md D49): a legacy import must never run while an offline device still holds
    // a lease -- it could overwrite rows the device will try to reconcile on reconnect. plan/dry-run
    // is unaffected, since it never writes.
    const activeLease = await t.one<{ deviceName: string }>(
      `SELECT d.device_name AS "deviceName" FROM offline_leases l JOIN sync_devices d ON d.id = l.device_id
       WHERE l.organization_id = $1 AND l.status IN ('active', 'expired') LIMIT 1`,
      [opts.organizationId]
    )
    if (activeLease) {
      report = {
        mode: 'apply',
        items: [{ entity: 'organization', sourceId: '-', label: activeLease.deviceName, action: 'reject', reason: `an offline lease is active on device "${activeLease.deviceName}"; release or reclaim it before running the legacy migration` }],
        counts: { organization: { insert: 0, skip: 0, reject: 1 } },
        aborted: true
      }
      throw new RollbackForReport()
    }
    report = await run(legacy, t, opts, true)
    if (report.aborted) throw new RollbackForReport()
  }).catch((err) => {
    if (!(err instanceof RollbackForReport)) throw err
  })
  return report
}

class RollbackForReport extends Error {}

export interface VerificationIssue {
  entity: string
  message: string
}
export interface VerificationReport {
  ok: boolean
  countsMatch: Record<string, { source: number; migrated: number }>
  issues: VerificationIssue[]
}

/** Independently compares source and destination after an apply. Never assumes success from insert counts alone. */
export async function verifyLegacyMigration(legacy: Database.Database, pg: Db, opts: LegacyMigrationOptions): Promise<VerificationReport> {
  const issues: VerificationIssue[] = []
  const countsMatch: VerificationReport['countsMatch'] = {}
  const tables: Array<[string, string]> = [
    ['departments', 'departments'], ['locations', 'locations'], ['asset_categories', 'asset_categories'], ['asset_models', 'asset_models'],
    ['suppliers', 'suppliers'], ['employees', 'employees'], ['assets', 'assets'], ['users', 'users']
  ]
  for (const [legacyTable, targetTable] of tables) {
    const sourceTotal = (legacy.prepare(`SELECT COUNT(*) AS n FROM ${legacyTable}`).get() as { n: number }).n
    const migrated = (await pg.one<{ n: string }>('SELECT COUNT(*) AS n FROM legacy_migration_records WHERE organization_id = $1 AND source_table = $2', [opts.organizationId, legacyTable]))!.n
    countsMatch[legacyTable] = { source: sourceTotal, migrated: Number(migrated) }
    if (Number(migrated) > sourceTotal) issues.push({ entity: legacyTable, message: `${migrated} records marked migrated but only ${sourceTotal} exist in the source` })
  }
  // Referential integrity, asset-code uniqueness, and document-checksum spot checks on the target itself.
  const orphanAssets = (await pg.one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM assets a WHERE a.organization_id = $1 AND NOT EXISTS (SELECT 1 FROM asset_categories c WHERE c.id = a.category_id)`,
    [opts.organizationId]
  ))!.n
  if (Number(orphanAssets) > 0) issues.push({ entity: 'assets', message: `${orphanAssets} migrated assets reference a category that does not exist` })
  const dupeCodes = (await pg.one<{ n: string }>(
    'SELECT COUNT(*) AS n FROM (SELECT asset_code FROM assets WHERE organization_id = $1 GROUP BY asset_code HAVING COUNT(*) > 1) d',
    [opts.organizationId]
  ))!.n
  if (Number(dupeCodes) > 0) issues.push({ entity: 'assets', message: `${dupeCodes} duplicate asset codes exist in the target organization` })
  const docRows = await pg.many<{ id: string; storageKey: string; sha256: string }>(
    'SELECT id, storage_key AS "storageKey", sha256 FROM documents WHERE organization_id = $1 AND id IN (SELECT target_id FROM legacy_migration_records WHERE organization_id = $1 AND source_table = $2)',
    [opts.organizationId, 'documents']
  )
  countsMatch['documents'] = { source: (legacy.prepare("SELECT COUNT(*) AS n FROM document_links WHERE removed_at IS NULL AND entity_type = 'asset'").get() as { n: number }).n, migrated: docRows.length }
  return { ok: issues.length === 0, countsMatch, issues }
}
