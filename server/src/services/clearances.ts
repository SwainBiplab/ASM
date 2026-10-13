import { CLEARANCE_RESOLUTION_LABELS, UNRESOLVED_RESOLUTIONS, type ClearanceResolution } from '@shared/allocations'
import {
  approveExceptionSchema,
  cancelClearanceSchema,
  clearanceListSchema,
  closeClearanceSchema,
  flagClearanceItemSchema,
  openClearanceSchema,
  recordClearanceReturnSchema,
  type ApproveExceptionInput,
  type CancelClearanceInput,
  type ClearanceListInput,
  type CloseClearanceInput,
  type FlagClearanceItemInput,
  type OpenClearanceInput,
  type RecordClearanceReturnInput
} from '@shared/allocationSchemas'
import type { ClearanceDetail, ClearanceItemView, ClearanceSummary, Page } from '@shared/api'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { custodyAssignmentsForEmployee, nextNumber, reportLostInTx, returnInTx } from './allocations'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { listDocumentLinks } from './documents'
import { auditFrom, recordAudit } from './foundation'

/**
 * Employee exit clearance (W4, TAS §10). Items are a snapshot of the employee's active
 * assignments when the clearance opens. Nothing is returned automatically: each item is
 * returned (closing its assignment through a normal return), or flagged missing/disputed and
 * resolved by an authorized exception decision. Closure requires every item to be resolved.
 */

const SUMMARY_SELECT = `
  SELECT x.id, x.clearance_number AS "clearanceNumber", x.employee_id AS "employeeId", e.employee_code AS "employeeCode", e.full_name AS "employeeName",
         e.employment_status AS "employmentStatus", x.exit_date AS "exitDate", ou.display_name AS "ownerName", x.status, x.closure_type AS "closureType",
         x.opened_at AS "openedAt", opu.display_name AS "openedByName", x.closed_at AS "closedAt",
         (SELECT count(*) FROM exit_clearance_items i WHERE i.clearance_id = x.id) AS "itemCount",
         (SELECT count(*) FROM exit_clearance_items i WHERE i.clearance_id = x.id AND i.resolution IN ('outstanding', 'damaged', 'missing', 'disputed')) AS "unresolvedCount"
  FROM exit_clearances x JOIN employees e ON e.id = x.employee_id
  LEFT JOIN users ou ON ou.id = x.owner_user_id LEFT JOIN users opu ON opu.id = x.opened_by`

const toSummary = (r: ClearanceSummary): ClearanceSummary => ({ ...r, itemCount: Number(r.itemCount), unresolvedCount: Number(r.unresolvedCount) })

export async function listClearances(db: Db, raw: ClearanceListInput, ctx: OpContext): Promise<Page<ClearanceSummary>> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.view')
  const input = clearanceListSchema.parse(raw)
  const p = new Params()
  const where = [`x.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (input.status !== 'all') where.push(`x.status = ${p.add(input.status)}`)
  if (input.query) {
    const q = p.add(likePattern(input.query.toLowerCase()))
    where.push(`(lower(e.full_name) LIKE ${q} ESCAPE '\\' OR lower(e.employee_code) LIKE ${q} ESCAPE '\\' OR lower(x.clearance_number) LIKE ${q} ESCAPE '\\')`)
  }
  const w = where.join(' AND ')
  const total = Number((await db.one<{ n: number }>(`SELECT count(*) AS n FROM exit_clearances x JOIN employees e ON e.id = x.employee_id WHERE ${w}`, p.values))!.n)
  const rows = await db.many<ClearanceSummary>(`${SUMMARY_SELECT} WHERE ${w} ORDER BY x.opened_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`, p.values)
  return { items: rows.map(toSummary), total, page: input.page, pageSize: input.pageSize }
}

export async function getClearance(c: SqlClient, storage: DocumentStorage, id: string, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.view')
  const org = ctx.actor.organizationId
  const head = requireRow(
    await c.one<ClearanceSummary & { notes: string | null; closingNotes: string | null; closedByName: string | null; cancelReason: string | null }>(
      `SELECT s.*, x.notes, x.closing_notes AS "closingNotes", cu.display_name AS "closedByName", x.cancel_reason AS "cancelReason"
       FROM (${SUMMARY_SELECT} WHERE x.id = $1 AND x.organization_id = $2) s JOIN exit_clearances x ON x.id = s.id LEFT JOIN users cu ON cu.id = x.closed_by`,
      [id, org]
    ),
    'Exit clearance'
  )
  const rows = await c.many<Omit<ClearanceItemView, 'documents'>>(
    `SELECT i.id, i.asset_id AS "assetId", a.asset_code AS "assetCode", cat.name AS "categoryName",
            NULLIF(concat_ws(' ', COALESCE(m.manufacturer, a.manufacturer), COALESCE(m.model_name, a.model_name)), '') AS "makeModel",
            a.serial_number AS "serialNumber", i.assignment_id AS "assignmentId", s.assigned_at AS "assignedAt", i.resolution,
            i.received_condition AS "receivedCondition", i.return_outcome AS "returnOutcome", i.exception_reason AS "exceptionReason",
            ru.display_name AS "reportedByName", i.reported_at AS "reportedAt", i.decision_notes AS "decisionNotes",
            vu.display_name AS "reviewedByName", i.reviewed_at AS "reviewedAt", i.return_handover_id AS "returnHandoverId"
     FROM exit_clearance_items i JOIN assets a ON a.id = i.asset_id JOIN asset_categories cat ON cat.id = a.category_id
     LEFT JOIN asset_models m ON m.id = a.model_id JOIN asset_assignments s ON s.id = i.assignment_id
     LEFT JOIN users ru ON ru.id = i.reported_by LEFT JOIN users vu ON vu.id = i.reviewed_by
     WHERE i.clearance_id = $1 AND i.organization_id = $2 ORDER BY a.asset_code`,
    [id, org]
  )
  const items = await Promise.all(rows.map(async (r) => ({ ...r, documents: await listDocumentLinks(c, storage, ctx, 'clearance_item', r.id) })))
  const blockers =
    head.status !== 'open'
      ? []
      : items.filter((i) => UNRESOLVED_RESOLUTIONS.includes(i.resolution)).map((i) => `${i.assetCode}: ${CLEARANCE_RESOLUTION_LABELS[i.resolution].toLowerCase()}${i.resolution === 'outstanding' ? '' : ', needs an exception decision'}`)
  return { ...toSummary(head), notes: head.notes, closingNotes: head.closingNotes, closedByName: head.closedByName, cancelReason: head.cancelReason, items, blockers }
}

export async function openClearance(db: Db, storage: DocumentStorage, raw: OpenClearanceInput, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.manage')
  const input = openClearanceSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    // FOR UPDATE serializes with concurrent issues to this employee (they lock it FOR SHARE).
    const emp = await t.one<{ code: string }>('SELECT employee_code AS code FROM employees WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.employeeId, org])
    if (!emp) invalid('employeeId', 'Employee not found')
    if (await t.one("SELECT 1 FROM exit_clearances WHERE employee_id = $1 AND organization_id = $2 AND status = 'open'", [input.employeeId, org])) {
      conflict('This employee already has an open exit clearance.')
    }
    const owner = input.ownerUserId ?? ctx.actor.userId
    const u = await t.one<{ a: boolean }>('SELECT is_active AS a FROM users WHERE id = $1 AND organization_id = $2', [owner, org])
    if (!u?.a) invalid('ownerUserId', 'Choose an active user as the responsible owner')
    const id = newId()
    const number = await nextNumber(t, org, 'clearance')
    await t.exec(
      'INSERT INTO exit_clearances (id, organization_id, clearance_number, employee_id, exit_date, owner_user_id, notes, opened_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, org, number, input.employeeId, input.exitDate, owner, input.notes, ctx.actor.userId]
    )
    // W-16: sweeps direct assignments plus anything held by a department/team/pool this employee
    // manages or leads -- not just what was personally assigned to them.
    const outstanding = await custodyAssignmentsForEmployee(t, org, input.employeeId, true)
    for (const s of outstanding) {
      await t.exec('INSERT INTO exit_clearance_items (id, organization_id, clearance_id, asset_id, assignment_id) VALUES ($1, $2, $3, $4, $5)', [newId(), org, id, s.assetId, s.id])
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'exit_clearance.opened', entityType: 'exit_clearance', entityId: id, summary: { clearanceNumber: number, employeeId: input.employeeId, exitDate: input.exitDate, ownerUserId: owner, itemCount: outstanding.length } })
    return getClearance(t, storage, id, ctx)
  })
}

interface LockedItem {
  id: string
  clearanceId: string
  clearanceNumber: string
  clearanceStatus: string
  assetId: string
  assignmentId: string
  resolution: ClearanceResolution
  exceptionType: string | null
  assignmentStatus: string
}

async function lockItem(t: SqlClient, ctx: OpContext, itemId: string): Promise<LockedItem> {
  const item = requireRow(
    await t.one<LockedItem>(
      `SELECT i.id, i.clearance_id AS "clearanceId", x.clearance_number AS "clearanceNumber", x.status AS "clearanceStatus", i.asset_id AS "assetId",
              i.assignment_id AS "assignmentId", i.resolution, i.exception_type AS "exceptionType", s.status AS "assignmentStatus"
       FROM exit_clearance_items i JOIN exit_clearances x ON x.id = i.clearance_id JOIN asset_assignments s ON s.id = i.assignment_id
       WHERE i.id = $1 AND i.organization_id = $2 FOR UPDATE OF i, x`,
      [itemId, ctx.actor.organizationId]
    ),
    'Clearance item'
  )
  if (item.clearanceStatus !== 'open') conflict('This exit clearance is no longer open.')
  return item
}

/** Records the physical return of a clearance item: a normal return handover closes its assignment. */
export async function recordClearanceReturn(db: Db, storage: DocumentStorage, raw: RecordClearanceReturnInput, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.manage')
  assertPermission(ctx.actor.permissions, 'allocations.return')
  const input = recordClearanceReturnSchema.parse(raw)
  return db.tx(async (t) => {
    const item = await lockItem(t, ctx, input.itemId)
    if (!['outstanding', 'missing', 'disputed'].includes(item.resolution)) conflict('This item has already been returned or resolved.')
    if (item.assignmentStatus !== 'active') conflict('The assignment for this item is no longer active.')
    // returnInTx also moves the item to returned/damaged in the same transaction.
    const r = await returnInTx(t, ctx, [{ assetId: item.assetId, condition: input.condition, outcome: input.outcome, accessoriesReturned: null, notes: input.notes }], input.returnLocationId, input.notes)
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'exit_clearance.item_returned', entityType: 'exit_clearance', entityId: item.clearanceId,
      summary: { clearanceNumber: item.clearanceNumber, itemId: item.id, assetId: item.assetId, handoverNumber: r.handoverNumber, condition: input.condition, outcome: input.outcome, previousResolution: item.resolution }
    })
    return getClearance(t, storage, item.clearanceId, ctx)
  })
}

/** Flags an unreturned item as missing or disputed. The assignment stays active until a decision. */
export async function flagClearanceItem(db: Db, storage: DocumentStorage, raw: FlagClearanceItemInput, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.manage')
  const input = flagClearanceItemSchema.parse(raw)
  return db.tx(async (t) => {
    const item = await lockItem(t, ctx, input.itemId)
    if (!['outstanding', 'missing', 'disputed'].includes(item.resolution)) conflict('Only items that have not been returned can be flagged.')
    await t.exec('UPDATE exit_clearance_items SET resolution = $2, exception_type = $2, exception_reason = $3, reported_by = $4, reported_at = now(), updated_at = now() WHERE id = $1', [
      item.id, input.resolution, input.reason, ctx.actor.userId
    ])
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'exit_clearance.item_flagged', entityType: 'exit_clearance', entityId: item.clearanceId, reason: input.reason,
      summary: { clearanceNumber: item.clearanceNumber, itemId: item.id, assetId: item.assetId, resolution: input.resolution }
    })
    return getClearance(t, storage, item.clearanceId, ctx)
  })
}

/**
 * Authorized exception decision. Missing/disputed items are written off through the explicit
 * loss process (assignment ends as `lost`, asset becomes lost); damaged returns keep their state.
 */
export async function approveClearanceException(db: Db, storage: DocumentStorage, raw: ApproveExceptionInput, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.approve_exception')
  const input = approveExceptionSchema.parse(raw)
  return db.tx(async (t) => {
    const item = await lockItem(t, ctx, input.itemId)
    if (!['damaged', 'missing', 'disputed'].includes(item.resolution)) conflict('Only damaged, missing or disputed items need an exception decision.')
    if (item.resolution !== 'damaged') {
      if (!ctx.actor.permissions.has('assets.retire')) throw new AppError('PERMISSION_DENIED', 'Writing off a missing asset also requires permission to report assets lost.')
      await reportLostInTx(t, ctx, item.assetId, new Date().toISOString().slice(0, 10), `Exit clearance ${item.clearanceNumber}: ${input.decisionNotes}`, true)
    }
    await t.exec("UPDATE exit_clearance_items SET resolution = 'exception_approved', exception_type = COALESCE(exception_type, $2), decision_notes = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now() WHERE id = $1", [
      item.id, item.resolution, input.decisionNotes, ctx.actor.userId
    ])
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'exit_clearance.exception_approved', entityType: 'exit_clearance', entityId: item.clearanceId, reason: input.decisionNotes,
      summary: { clearanceNumber: item.clearanceNumber, itemId: item.id, assetId: item.assetId, exceptionType: item.resolution, assetWrittenOff: item.resolution !== 'damaged' }
    })
    return getClearance(t, storage, item.clearanceId, ctx)
  })
}

export async function closeClearance(db: Db, storage: DocumentStorage, raw: CloseClearanceInput, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.close')
  const input = closeClearanceSchema.parse(raw)
  return db.tx(async (t) => {
    const x = requireRow(
      await t.one<{ status: string; number: string }>('SELECT status, clearance_number AS number FROM exit_clearances WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.clearanceId, ctx.actor.organizationId]),
      'Exit clearance'
    )
    if (x.status !== 'open') conflict('This exit clearance is not open.')
    const items = await t.many<{ resolution: ClearanceResolution }>('SELECT resolution FROM exit_clearance_items WHERE clearance_id = $1 FOR UPDATE', [input.clearanceId])
    const unresolved = items.filter((i) => UNRESOLVED_RESOLUTIONS.includes(i.resolution)).length
    if (unresolved > 0) conflict(`${unresolved} item(s) are still unresolved. Record their return or an approved exception before closing.`)
    const closureType = items.some((i) => i.resolution === 'exception_approved') ? 'with_exceptions' : 'cleared'
    await t.exec("UPDATE exit_clearances SET status = 'closed', closure_type = $2, closed_by = $3, closed_at = now(), closing_notes = $4, updated_at = now() WHERE id = $1", [
      input.clearanceId, closureType, ctx.actor.userId, input.closingNotes
    ])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'exit_clearance.closed', entityType: 'exit_clearance', entityId: input.clearanceId, summary: { clearanceNumber: x.number, closureType, itemCount: items.length } })
    return getClearance(t, storage, input.clearanceId, ctx)
  })
}

/** Cancels an open clearance (e.g. the exit was withdrawn). Items and evidence are kept as history. */
export async function cancelClearance(db: Db, storage: DocumentStorage, raw: CancelClearanceInput, ctx: OpContext): Promise<ClearanceDetail> {
  assertPermission(ctx.actor.permissions, 'exit_clearance.manage')
  const input = cancelClearanceSchema.parse(raw)
  return db.tx(async (t) => {
    const x = requireRow(
      await t.one<{ status: string; number: string }>('SELECT status, clearance_number AS number FROM exit_clearances WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.clearanceId, ctx.actor.organizationId]),
      'Exit clearance'
    )
    if (x.status !== 'open') conflict('This exit clearance is not open.')
    await t.exec("UPDATE exit_clearances SET status = 'cancelled', cancel_reason = $2, closed_by = $3, closed_at = now(), updated_at = now() WHERE id = $1", [input.clearanceId, input.reason, ctx.actor.userId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'exit_clearance.cancelled', entityType: 'exit_clearance', entityId: input.clearanceId, reason: input.reason, summary: { clearanceNumber: x.number } })
    return getClearance(t, storage, input.clearanceId, ctx)
  })
}

/** Dashboard figures; null when the user cannot view clearances. */
export async function clearanceMetrics(c: SqlClient, ctx: OpContext): Promise<{ open: number; withUnresolvedItems: number } | null> {
  if (!ctx.actor.permissions.has('exit_clearance.view')) return null
  const r = await c.one<{ open: number; unresolved: number }>(
    `SELECT count(*) AS open,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM exit_clearance_items i WHERE i.clearance_id = x.id AND i.resolution IN ('outstanding', 'damaged', 'missing', 'disputed'))) AS unresolved
     FROM exit_clearances x WHERE x.organization_id = $1 AND x.status = 'open'`,
    [ctx.actor.organizationId]
  )
  return { open: Number(r!.open), withUnresolvedItems: Number(r!.unresolved) }
}
