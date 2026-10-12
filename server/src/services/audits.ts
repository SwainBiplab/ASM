import { UNRESOLVED_AUDIT_ITEM_STATUSES, type AuditClosureType, type DiscrepancyType } from '@shared/audits'
import {
  acceptExceptionSchema,
  assignDiscrepancySchema,
  auditItemListSchema,
  auditListSchema,
  auditRefSchema,
  cancelAuditSchema,
  closeAuditSchema,
  correctLocationSchema,
  createAuditSchema,
  flagMissingSchema,
  resolveDiscrepancySchema,
  verifyItemSchema,
  type AcceptExceptionInput,
  type AssignDiscrepancyInput,
  type AuditItemListInput,
  type AuditScope,
  type CancelAuditInput,
  type CloseAuditInput,
  type CorrectLocationInput,
  type CreateAuditInput,
  type FlagMissingInput,
  type PhysicalAuditListInput,
  type ResolveDiscrepancyInput,
  type VerifyItemInput
} from '@shared/auditSchemas'
import type { AuditItemView, Page, PhysicalAuditDetail, PhysicalAuditSummary } from '@shared/api'
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { listDocumentLinks } from './documents'
import { auditFrom, recordAudit } from './foundation'
import { loadLocationPaths } from './organization'
import { assertAssetsNotLeased } from './offlineLeases'
import { nextW5Number } from './maintenance'

/**
 * Physical audits (W5, TAS §13). The expected inventory is frozen into `audit_items` at creation
 * time; later edits to the master asset record never retroactively change what was expected. A
 * scan only ever confirms an observation — it is never permission to edit the inventory directly.
 */

const MAX_SCOPE_ASSETS = 2000

/** Active users who can investigate discrepancies, without exposing full user-management data. */
export async function listReviewers(c: SqlClient, ctx: OpContext): Promise<Array<{ id: string; displayName: string }>> {
  assertPermission(ctx.actor.permissions, 'audits.resolve')
  return c.many<{ id: string; displayName: string }>(
    `SELECT DISTINCT u.id, u.display_name AS "displayName"
     FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE u.organization_id = $1 AND u.is_active AND rp.permission_key IN ('audits.resolve', 'audits.manage', 'audits.close')
     ORDER BY u.display_name`,
    [ctx.actor.organizationId]
  )
}

async function resolveScope(c: SqlClient, ctx: OpContext, scope: AuditScope): Promise<{ assetIds: string[]; mode: 'criteria' | 'selected' }> {
  const org = ctx.actor.organizationId
  if (scope.assetIds && scope.assetIds.length) {
    const rows = await c.many<{ id: string }>('SELECT id FROM assets WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND lifecycle_status = $3', [org, scope.assetIds, 'active'])
    if (rows.length !== scope.assetIds.length) invalid('scope', 'One or more selected assets were not found or are not active')
    return { assetIds: rows.map((r) => r.id), mode: 'selected' }
  }
  const p = new Params()
  const where = [`a.organization_id = ${p.add(org)}`, `a.lifecycle_status = ${p.add('active')}`]
  if (scope.locationId) {
    where.push(`a.location_id IN (WITH RECURSIVE sub(id) AS (SELECT ${p.add(scope.locationId)}::uuid UNION ALL SELECT x.id FROM locations x JOIN sub ON x.parent_location_id = sub.id) SELECT id FROM sub)`)
  }
  if (scope.categoryId) where.push(`a.category_id = ${p.add(scope.categoryId)}`)
  if (scope.custodianEmployeeId) {
    where.push(`a.id IN (SELECT asset_id FROM asset_assignments WHERE organization_id = ${p.add(org)} AND employee_id = ${p.add(scope.custodianEmployeeId)} AND status = 'active')`)
  }
  const rows = await c.many<{ id: string }>(`SELECT a.id FROM assets a WHERE ${where.join(' AND ')} LIMIT ${MAX_SCOPE_ASSETS + 1}`, p.values)
  if (rows.length > MAX_SCOPE_ASSETS) invalid('scope', `This scope matches more than ${MAX_SCOPE_ASSETS} assets; narrow it (e.g. by location or category).`)
  if (rows.length === 0) invalid('scope', 'No active assets match this scope')
  return { assetIds: rows.map((r) => r.id), mode: 'criteria' }
}

export async function createAudit(db: Db, storage: DocumentStorage, raw: CreateAuditInput, ctx: OpContext): Promise<PhysicalAuditDetail> {
  assertPermission(ctx.actor.permissions, 'audits.manage')
  const input = createAuditSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const { assetIds, mode } = await resolveScope(t, ctx, input.scope)
    const owner = input.responsibleUserId ?? ctx.actor.userId
    const u = await t.one<{ a: boolean }>('SELECT is_active AS a FROM users WHERE id = $1 AND organization_id = $2', [owner, org])
    if (!u?.a) invalid('responsibleUserId', 'Choose an active user as the responsible owner')
    const id = newId()
    const number = await nextW5Number(t, org, 'audit')
    await t.exec(
      `INSERT INTO physical_audits (id, organization_id, audit_number, title, notes, scope_mode, scope_location_id, scope_category_id, scope_custodian_employee_id, responsible_user_id, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, org, number, input.title, input.notes, mode, input.scope.locationId, input.scope.categoryId, input.scope.custodianEmployeeId, owner, ctx.actor.userId]
    )
    const paths = await loadLocationPaths(t, org)
    // Snapshot every asset's current location/condition/custodian as the frozen baseline.
    const assets = await t.many<{ id: string; locationId: string | null; condition: string }>('SELECT id, location_id AS "locationId", condition FROM assets WHERE organization_id = $1 AND id = ANY($2::uuid[])', [org, assetIds])
    const custody = new Map(
      (await t.many<{ assetId: string; label: string }>(
        `SELECT s.asset_id AS "assetId",
                CASE s.target_type WHEN 'employee' THEN e.full_name || ' (' || e.employee_code || ')' WHEN 'workstation' THEN w.code
                     WHEN 'department' THEN d.name WHEN 'team' THEN tm.name ELSE p.name END AS label
         FROM asset_assignments s
         LEFT JOIN employees e ON e.id = s.employee_id LEFT JOIN workstations w ON w.id = s.workstation_id
         LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN teams tm ON tm.id = s.team_id LEFT JOIN asset_pools p ON p.id = s.pool_id
         WHERE s.organization_id = $1 AND s.asset_id = ANY($2::uuid[]) AND s.status = 'active'`,
        [org, assetIds]
      )).map((r) => [r.assetId, r.label])
    )
    for (const a of assets) {
      await t.exec(
        `INSERT INTO audit_items (id, organization_id, audit_id, asset_id, source, expected_location_id, expected_location_path, expected_condition, expected_custodian_label)
         VALUES ($1, $2, $3, $4, 'expected', $5, $6, $7, $8)`,
        [newId(), org, id, a.id, a.locationId, a.locationId ? (paths.get(a.locationId)?.path ?? null) : null, a.condition, custody.get(a.id) ?? null]
      )
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.opened', entityType: 'physical_audit', entityId: id, summary: { auditNumber: number, title: input.title, itemCount: assets.length, scopeMode: mode } })
    return getAudit(t, id, ctx, true)
  })
}

const SUMMARY_COLUMNS = `x.id, x.audit_number AS "auditNumber", x.title, x.status, x.closure_type AS "closureType", x.opened_at AS "openedAt",
         ou.display_name AS "openedByName", x.closed_at AS "closedAt", ru.display_name AS "responsibleUserName",
         (SELECT count(*) FROM audit_items i WHERE i.audit_id = x.id) AS "itemCount",
         (SELECT count(*) FROM audit_items i WHERE i.audit_id = x.id AND i.status = 'verified') AS "verifiedCount",
         (SELECT count(*) FROM audit_items i WHERE i.audit_id = x.id AND i.status IN ('pending', 'discrepancy_open', 'investigating')) AS "unresolvedCount",
         x.scope_location_id AS "scopeLocationId", x.scope_category_id AS "scopeCategoryId", x.scope_custodian_employee_id AS "scopeCustodianEmployeeId"`
const SUMMARY_FROM = `FROM physical_audits x
  LEFT JOIN users ou ON ou.id = x.opened_by LEFT JOIN users ru ON ru.id = x.responsible_user_id`

export async function listAudits(db: Db, raw: PhysicalAuditListInput, ctx: OpContext): Promise<Page<PhysicalAuditSummary>> {
  assertPermission(ctx.actor.permissions, 'audits.view')
  const input = auditListSchema.parse(raw)
  const p = new Params()
  const where = [`x.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (input.status !== 'all') where.push(`x.status = ${p.add(input.status)}`)
  if (input.query) {
    const q = p.add(likePattern(input.query.toLowerCase()))
    where.push(`(lower(x.title) LIKE ${q} ESCAPE '\\' OR lower(x.audit_number) LIKE ${q} ESCAPE '\\')`)
  }
  const w = where.join(' AND ')
  const total = Number((await db.one<{ n: number }>(`SELECT count(*) AS n FROM physical_audits x WHERE ${w}`, p.values))!.n)
  const rows = await db.many<PhysicalAuditSummary & { scopeLocationId: string | null; scopeCategoryId: string | null; scopeCustodianEmployeeId: string | null }>(
    `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM} WHERE ${w} ORDER BY x.opened_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  return { items: await withScopeLabels(db, ctx, rows), total, page: input.page, pageSize: input.pageSize }
}

async function withScopeLabels<T extends { scopeLocationId: string | null; scopeCategoryId: string | null; scopeCustodianEmployeeId: string | null; itemCount: number; verifiedCount: number; unresolvedCount: number }>(
  c: SqlClient,
  ctx: OpContext,
  rows: T[]
): Promise<Array<Omit<T, 'scopeLocationId' | 'scopeCategoryId' | 'scopeCustodianEmployeeId'> & { scopeLocationPath: string | null; scopeCategoryName: string | null; scopeCustodianName: string | null }>> {
  if (!rows.length) return []
  const org = ctx.actor.organizationId
  const paths = await loadLocationPaths(c, org)
  const categoryIds = [...new Set(rows.map((r) => r.scopeCategoryId).filter((x): x is string => !!x))]
  const employeeIds = [...new Set(rows.map((r) => r.scopeCustodianEmployeeId).filter((x): x is string => !!x))]
  const categories = categoryIds.length ? await c.many<{ id: string; name: string }>('SELECT id, name FROM asset_categories WHERE organization_id = $1 AND id = ANY($2::uuid[])', [org, categoryIds]) : []
  const employees = employeeIds.length ? await c.many<{ id: string; name: string }>("SELECT id, full_name AS name FROM employees WHERE organization_id = $1 AND id = ANY($2::uuid[])", [org, employeeIds]) : []
  const catMap = new Map(categories.map((c2) => [c2.id, c2.name]))
  const empMap = new Map(employees.map((e) => [e.id, e.name]))
  return rows.map(({ scopeLocationId, scopeCategoryId, scopeCustodianEmployeeId, ...r }) => ({
    ...r,
    // Defensive: count(*) already arrives as a number via the int8 type parser; Number() is a no-op safety net.
    itemCount: Number(r.itemCount),
    verifiedCount: Number(r.verifiedCount),
    unresolvedCount: Number(r.unresolvedCount),
    scopeLocationPath: scopeLocationId ? (paths.get(scopeLocationId)?.path ?? null) : null,
    scopeCategoryName: scopeCategoryId ? (catMap.get(scopeCategoryId) ?? null) : null,
    scopeCustodianName: scopeCustodianEmployeeId ? (empMap.get(scopeCustodianEmployeeId) ?? null) : null
  }))
}

export async function getAudit(c: SqlClient, auditId: string, ctx: OpContext, afterWrite = false): Promise<PhysicalAuditDetail> {
  // The actor who just performed an authorized write may see its result even without audits.view.
  if (!afterWrite) assertPermission(ctx.actor.permissions, 'audits.view')
  const org = ctx.actor.organizationId
  const row = requireRow(
    await c.one<PhysicalAuditSummary & { scopeLocationId: string | null; scopeCategoryId: string | null; scopeCustodianEmployeeId: string | null; notes: string | null; closingNotes: string | null; closedByName: string | null; cancelReason: string | null }>(
      `SELECT s.*, x.notes, x.closing_notes AS "closingNotes", cu.display_name AS "closedByName", x.cancel_reason AS "cancelReason"
       FROM (SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM} WHERE x.id = $1 AND x.organization_id = $2) s
       JOIN physical_audits x ON x.id = s.id LEFT JOIN users cu ON cu.id = x.closed_by`,
      [auditId, org]
    ),
    'Physical audit'
  )
  const [withLabels] = await withScopeLabels(c, ctx, [row])
  const unresolved = row.status === 'open' ? Number(row.unresolvedCount) : 0
  const blockers = unresolved > 0 ? [`${unresolved} item(s) still need verification, assignment or a resolution/accepted decision.`] : []
  return { ...withLabels!, blockers }
}

const ITEM_SELECT = `
  SELECT i.id, i.audit_id AS "auditId", i.asset_id AS "assetId", a.asset_code AS "assetCode", c.name AS "categoryName",
         NULLIF(concat_ws(' ', COALESCE(m.manufacturer, a.manufacturer), COALESCE(m.model_name, a.model_name)), '') AS "makeModel",
         a.serial_number AS "serialNumber", i.source, i.expected_location_id AS "expectedLocationId", i.expected_location_path AS "expectedLocationPath",
         i.expected_condition AS "expectedCondition", i.expected_custodian_label AS "expectedCustodianLabel", i.observed_at AS "observedAt",
         ou.display_name AS "observedByName", i.observed_location_id AS "observedLocationId", i.observed_condition AS "observedCondition", i.notes,
         i.status, i.discrepancy_type AS "discrepancyType", au.display_name AS "assignedToName", i.assignment_notes AS "assignmentNotes",
         i.resolution_notes AS "resolutionNotes", ru.display_name AS "resolvedByName", i.resolved_at AS "resolvedAt"
  FROM audit_items i
  JOIN assets a ON a.id = i.asset_id
  JOIN asset_categories c ON c.id = a.category_id
  LEFT JOIN asset_models m ON m.id = a.model_id
  LEFT JOIN users ou ON ou.id = i.observed_by
  LEFT JOIN users au ON au.id = i.assigned_to
  LEFT JOIN users ru ON ru.id = i.resolved_by`

type ItemRow = Omit<AuditItemView, 'observedLocationPath' | 'documents'> & { observedLocationId: string | null; expectedLocationId: string | null }

async function withItemLocations(c: SqlClient, ctx: OpContext, rows: ItemRow[]): Promise<Array<Omit<ItemRow, 'observedLocationId' | 'expectedLocationId'> & { observedLocationPath: string | null }>> {
  const paths = rows.length ? await loadLocationPaths(c, ctx.actor.organizationId) : new Map()
  return rows.map(({ observedLocationId, expectedLocationId, ...r }) => ({
    ...r,
    observedLocationPath: observedLocationId ? (paths.get(observedLocationId)?.path ?? null) : null
  }))
}

export async function listAuditItems(db: Db, storage: DocumentStorage, raw: AuditItemListInput, ctx: OpContext): Promise<Page<AuditItemView>> {
  assertPermission(ctx.actor.permissions, 'audits.view')
  const input = auditItemListSchema.parse(raw)
  const p = new Params()
  const where = [`i.organization_id = ${p.add(ctx.actor.organizationId)}`, `i.audit_id = ${p.add(input.auditId)}`]
  if (input.status !== 'all') where.push(`i.status = ${p.add(input.status)}`)
  if (input.query) {
    const q = p.add(likePattern(input.query.toLowerCase()))
    where.push(`(lower(a.asset_code) LIKE ${q} ESCAPE '\\' OR lower(COALESCE(a.serial_number, '')) LIKE ${q} ESCAPE '\\')`)
  }
  const whereSql = where.join(' AND ')
  const total = Number((await db.one<{ n: number }>(`SELECT count(*) AS n FROM audit_items i JOIN assets a ON a.id = i.asset_id WHERE ${whereSql}`, p.values))!.n)
  const rows = await db.many<ItemRow>(`${ITEM_SELECT} WHERE ${whereSql} ORDER BY a.asset_code LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`, p.values)
  const withLoc = await withItemLocations(db, ctx, rows)
  const items = await Promise.all(withLoc.map(async (r) => ({ ...r, documents: await listDocumentLinks(db, storage, ctx, 'audit_item', r.id) })))
  return { items, total, page: input.page, pageSize: input.pageSize }
}

async function getItem(c: SqlClient, storage: DocumentStorage, itemId: string, ctx: OpContext): Promise<AuditItemView> {
  const row = requireRow(await c.one<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1 AND i.organization_id = $2`, [itemId, ctx.actor.organizationId]), 'Audit item')
  const [withLoc] = await withItemLocations(c, ctx, [row])
  return { ...withLoc!, documents: await listDocumentLinks(c, storage, ctx, 'audit_item', itemId) }
}

interface LockedItem {
  id: string
  auditId: string
  auditStatus: string
  assetId: string
  assetCode: string
  source: 'expected' | 'unexpected'
  status: string
  discrepancyType: DiscrepancyType | null
  expectedLocationId: string | null
  expectedCondition: string | null
}

async function lockItemAndAudit(t: SqlClient, ctx: OpContext, itemId: string): Promise<LockedItem> {
  const row = await t.one<LockedItem>(
    `SELECT i.id, i.audit_id AS "auditId", x.status AS "auditStatus", i.asset_id AS "assetId", a.asset_code AS "assetCode", i.source, i.status,
            i.discrepancy_type AS "discrepancyType", i.expected_location_id AS "expectedLocationId", i.expected_condition AS "expectedCondition"
     FROM audit_items i JOIN physical_audits x ON x.id = i.audit_id JOIN assets a ON a.id = i.asset_id
     WHERE i.id = $1 AND i.organization_id = $2 FOR UPDATE OF i, x`,
    [itemId, ctx.actor.organizationId]
  )
  const item = requireRow(row, 'Audit item')
  if (item.auditStatus !== 'open') conflict('This audit is no longer open.')
  return item
}

/**
 * The core scan/lookup action. A match against the frozen baseline verifies the item; a
 * difference opens a discrepancy; an asset with no expected row at all becomes an unexpected
 * find. The audit's expected baseline itself is never changed by this action (TAS §13).
 */
export async function verifyItem(db: Db, storage: DocumentStorage, raw: VerifyItemInput, ctx: OpContext): Promise<AuditItemView> {
  assertAnyPermission(ctx, ['audits.verify', 'audits.manage'])
  const input = verifyItemSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const audit = await t.one<{ status: string }>('SELECT status FROM physical_audits WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.auditId, org])
    if (!audit) invalid('auditId', 'Audit not found')
    if (audit.status !== 'open') conflict('This audit is no longer open.')
    await assertLocation(t, ctx, input.observedLocationId)
    const asset = await t.one<{ code: string }>('SELECT asset_code AS code FROM assets WHERE id = $1 AND organization_id = $2', [input.assetId, org])
    if (!asset) invalid('assetId', 'Asset not found')

    const existing = await t.one<{ id: string; status: string; expectedLocationId: string | null; expectedCondition: string | null }>(
      'SELECT id, status, expected_location_id AS "expectedLocationId", expected_condition AS "expectedCondition" FROM audit_items WHERE audit_id = $1 AND asset_id = $2 FOR UPDATE',
      [input.auditId, input.assetId]
    )
    if (existing && !['pending', 'verified'].includes(existing.status)) {
      conflict(`${asset.code} already has a ${existing.status.replace('_', ' ')} item in this audit; resolve it instead of scanning again.`)
    }

    let itemId: string
    if (existing) {
      const matches = !input.identificationMismatch && existing.expectedLocationId === input.observedLocationId && existing.expectedCondition === input.observedCondition
      const discrepancyType: DiscrepancyType | null = matches ? null : input.identificationMismatch ? 'identification_mismatch' : existing.expectedLocationId !== input.observedLocationId ? 'location_mismatch' : 'condition_mismatch'
      await t.exec(
        `UPDATE audit_items SET observed_at = now(), observed_by = $2, observed_location_id = $3, observed_condition = $4, notes = $5,
                status = $6, discrepancy_type = $7, updated_at = now() WHERE id = $1`,
        [existing.id, ctx.actor.userId, input.observedLocationId, input.observedCondition, input.notes, matches ? 'verified' : 'discrepancy_open', discrepancyType]
      )
      itemId = existing.id
    } else {
      itemId = newId()
      await t.exec(
        `INSERT INTO audit_items (id, organization_id, audit_id, asset_id, source, observed_at, observed_by, observed_location_id, observed_condition, notes, status, discrepancy_type)
         VALUES ($1, $2, $3, $4, 'unexpected', now(), $5, $6, $7, $8, 'discrepancy_open', 'unexpected')`,
        [itemId, org, input.auditId, input.assetId, ctx.actor.userId, input.observedLocationId, input.observedCondition, input.notes]
      )
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.item_verified', entityType: 'physical_audit', entityId: input.auditId, summary: { assetCode: asset.code, itemId, source: existing ? 'expected' : 'unexpected' } })
    return getItem(t, storage, itemId, ctx)
  })
}

async function assertLocation(t: SqlClient, ctx: OpContext, locationId: string | null): Promise<void> {
  if (!locationId) return
  const l = await t.one<{ a: boolean }>('SELECT is_active AS a FROM locations WHERE id = $1 AND organization_id = $2', [locationId, ctx.actor.organizationId])
  if (!l) invalid('observedLocationId', 'Location not found')
}

/** An expected item that was never found. A deliberate, reviewed action — never automatic. */
export async function flagMissing(db: Db, storage: DocumentStorage, raw: FlagMissingInput, ctx: OpContext): Promise<AuditItemView> {
  assertPermission(ctx.actor.permissions, 'audits.resolve')
  const input = flagMissingSchema.parse(raw)
  return db.tx(async (t) => {
    const item = await lockItemAndAudit(t, ctx, input.itemId)
    if (item.status !== 'pending') conflict('Only an item that has not been found yet can be flagged missing.')
    await t.exec("UPDATE audit_items SET status = 'discrepancy_open', discrepancy_type = 'missing', resolution_notes = NULL, updated_at = now() WHERE id = $1", [item.id])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.item_missing', entityType: 'physical_audit', entityId: item.auditId, reason: input.notes, summary: { assetCode: item.assetCode, itemId: item.id } })
    return getItem(t, storage, item.id, ctx)
  })
}

export async function assignDiscrepancy(db: Db, storage: DocumentStorage, raw: AssignDiscrepancyInput, ctx: OpContext): Promise<AuditItemView> {
  assertPermission(ctx.actor.permissions, 'audits.resolve')
  const input = assignDiscrepancySchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const item = await lockItemAndAudit(t, ctx, input.itemId)
    if (item.status !== 'discrepancy_open') conflict('Only an open discrepancy can be assigned.')
    const u = await t.one<{ a: boolean }>('SELECT is_active AS a FROM users WHERE id = $1 AND organization_id = $2', [input.assignedToUserId, org])
    if (!u?.a) invalid('assignedToUserId', 'Choose an active user')
    await t.exec("UPDATE audit_items SET status = 'investigating', assigned_to = $2, assignment_notes = $3, updated_at = now() WHERE id = $1", [item.id, input.assignedToUserId, input.notes])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.item_assigned', entityType: 'physical_audit', entityId: item.auditId, summary: { assetCode: item.assetCode, itemId: item.id, assignedToUserId: input.assignedToUserId } })
    return getItem(t, storage, item.id, ctx)
  })
}

/** Generic resolution: the discrepancy was addressed (not necessarily through a location edit). */
export async function resolveDiscrepancy(db: Db, storage: DocumentStorage, raw: ResolveDiscrepancyInput, ctx: OpContext): Promise<AuditItemView> {
  assertPermission(ctx.actor.permissions, 'audits.resolve')
  const input = resolveDiscrepancySchema.parse(raw)
  return db.tx(async (t) => {
    const item = await lockItemAndAudit(t, ctx, input.itemId)
    if (!['discrepancy_open', 'investigating'].includes(item.status)) conflict('Only an open or investigating discrepancy can be resolved.')
    await t.exec("UPDATE audit_items SET status = 'resolved', resolution_notes = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1", [item.id, input.resolutionNotes, ctx.actor.userId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.item_resolved', entityType: 'physical_audit', entityId: item.auditId, reason: input.resolutionNotes, summary: { assetCode: item.assetCode, itemId: item.id, discrepancyType: item.discrepancyType } })
    return getItem(t, storage, item.id, ctx)
  })
}

/**
 * Corrects the master asset location through an authorized, audited server action (not a raw
 * client edit) and resolves the discrepancy in the same transaction, linking the two (TAS §5).
 */
export async function correctLocation(db: Db, storage: DocumentStorage, raw: CorrectLocationInput, ctx: OpContext): Promise<AuditItemView> {
  assertPermission(ctx.actor.permissions, 'audits.resolve')
  const input = correctLocationSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const item = await lockItemAndAudit(t, ctx, input.itemId)
    if (item.discrepancyType !== 'location_mismatch') conflict('This action only applies to a location discrepancy.')
    if (!['discrepancy_open', 'investigating'].includes(item.status)) conflict('Only an open or investigating discrepancy can be corrected.')
    const loc = await t.one<{ a: boolean }>('SELECT is_active AS a FROM locations WHERE id = $1 AND organization_id = $2', [input.newLocationId, org])
    if (!loc?.a) invalid('newLocationId', 'Choose an active location')
    // Was previously read without a lock before an unlocked UPDATE; a concurrent write could overwrite
    // the correction, or race an unrelated location change, with neither side seeing the other's effect.
    const before = await t.one<{ locationId: string | null }>('SELECT location_id AS "locationId" FROM assets WHERE id = $1 FOR UPDATE', [item.assetId])
    await assertAssetsNotLeased(t, org, [item.assetId])
    await t.exec('UPDATE assets SET location_id = $2, updated_at = now() WHERE id = $1', [item.assetId, input.newLocationId])
    await t.exec("UPDATE audit_items SET status = 'resolved', resolution_notes = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1", [item.id, input.reason, ctx.actor.userId])
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'asset.location_corrected', entityType: 'asset', entityId: item.assetId, reason: input.reason,
      summary: { assetCode: item.assetCode, fromLocationId: before?.locationId ?? null, toLocationId: input.newLocationId, auditItemId: item.id, auditId: item.auditId }
    })
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.item_resolved', entityType: 'physical_audit', entityId: item.auditId, reason: input.reason, summary: { assetCode: item.assetCode, itemId: item.id, discrepancyType: 'location_mismatch', correctedLocation: true } })
    return getItem(t, storage, item.id, ctx)
  })
}

/** Formal acceptance of an unresolved exception without correcting the master data (closer-level authority). */
export async function acceptException(db: Db, storage: DocumentStorage, raw: AcceptExceptionInput, ctx: OpContext): Promise<AuditItemView> {
  assertPermission(ctx.actor.permissions, 'audits.close')
  const input = acceptExceptionSchema.parse(raw)
  return db.tx(async (t) => {
    const item = await lockItemAndAudit(t, ctx, input.itemId)
    if (!['discrepancy_open', 'investigating'].includes(item.status)) conflict('Only an open or investigating discrepancy can be accepted as an exception.')
    await t.exec("UPDATE audit_items SET status = 'accepted', resolution_notes = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1", [item.id, input.decisionNotes, ctx.actor.userId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.exception_accepted', entityType: 'physical_audit', entityId: item.auditId, reason: input.decisionNotes, summary: { assetCode: item.assetCode, itemId: item.id, discrepancyType: item.discrepancyType } })
    return getItem(t, storage, item.id, ctx)
  })
}

export async function closeAudit(db: Db, raw: CloseAuditInput, ctx: OpContext): Promise<PhysicalAuditDetail> {
  assertPermission(ctx.actor.permissions, 'audits.close')
  const input = closeAuditSchema.parse(raw)
  return db.tx(async (t) => {
    const x = requireRow(await t.one<{ status: string; number: string }>('SELECT status, audit_number AS number FROM physical_audits WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.auditId, ctx.actor.organizationId]), 'Physical audit')
    if (x.status !== 'open') conflict('This audit is not open.')
    const items = await t.many<{ status: string; discrepancyType: string | null }>('SELECT status, discrepancy_type AS "discrepancyType" FROM audit_items WHERE audit_id = $1 FOR UPDATE', [input.auditId])
    const unresolved = items.filter((i) => UNRESOLVED_AUDIT_ITEM_STATUSES.includes(i.status as never)).length
    if (unresolved > 0) conflict(`${unresolved} item(s) are still unresolved. Verify, resolve or formally accept them before closing.`)
    const closureType: AuditClosureType = items.some((i) => i.discrepancyType) ? 'with_exceptions' : 'fully_verified'
    await t.exec("UPDATE physical_audits SET status = 'closed', closure_type = $2, closed_by = $3, closed_at = now(), closing_notes = $4, updated_at = now() WHERE id = $1", [input.auditId, closureType, ctx.actor.userId, input.closingNotes])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.closed', entityType: 'physical_audit', entityId: input.auditId, summary: { auditNumber: x.number, closureType, itemCount: items.length } })
    return getAudit(t, input.auditId, ctx, true)
  })
}

export async function cancelAudit(db: Db, raw: CancelAuditInput, ctx: OpContext): Promise<PhysicalAuditDetail> {
  assertPermission(ctx.actor.permissions, 'audits.manage')
  const input = cancelAuditSchema.parse(raw)
  return db.tx(async (t) => {
    const x = requireRow(await t.one<{ status: string; number: string }>('SELECT status, audit_number AS number FROM physical_audits WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.auditId, ctx.actor.organizationId]), 'Physical audit')
    if (x.status !== 'open') conflict('This audit is not open.')
    await t.exec("UPDATE physical_audits SET status = 'cancelled', cancel_reason = $2, closed_by = $3, closed_at = now(), updated_at = now() WHERE id = $1", [input.auditId, input.reason, ctx.actor.userId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'physical_audit.cancelled', entityType: 'physical_audit', entityId: input.auditId, reason: input.reason, summary: { auditNumber: x.number } })
    return getAudit(t, input.auditId, ctx, true)
  })
}

/** Dashboard figures; null when the user cannot view physical audits. */
export async function auditMetrics(c: SqlClient, ctx: OpContext): Promise<{ open: number; withUnresolvedItems: number } | null> {
  if (!ctx.actor.permissions.has('audits.view')) return null
  const r = await c.one<{ open: number; unresolved: number }>(
    `SELECT count(*) AS open,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM audit_items i WHERE i.audit_id = x.id AND i.status IN ('pending', 'discrepancy_open', 'investigating'))) AS unresolved
     FROM physical_audits x WHERE x.organization_id = $1 AND x.status = 'open'`,
    [ctx.actor.organizationId]
  )
  return { open: Number(r!.open), withUnresolvedItems: Number(r!.unresolved) }
}
