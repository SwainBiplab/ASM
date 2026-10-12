import type { ReturnOutcome } from '@shared/allocations'
import {
  assignTicketSchema,
  cancelTicketSchema,
  closeTicketSchema,
  createTicketSchema,
  resolveTicketSchema,
  ticketListSchema,
  ticketRefSchema,
  updateTicketSchema,
  type AssignTicketInput,
  type CancelTicketInput,
  type CloseTicketInput,
  type CreateTicketInput,
  type ResolveTicketInput,
  type TicketListInput,
  type UpdateTicketInput
} from '@shared/maintenanceSchemas'
import type { TicketEventType } from '@shared/maintenance'
import type { MaintenanceEventView, MaintenanceTicketDetail, MaintenanceTicketSummary, Page } from '@shared/api'
import { parseMoneyToMinor } from '@shared/assets'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import { pgErrorCode, type Db, type SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { listDocumentLinks } from './documents'
import { auditFrom, recordAudit } from './foundation'
import { assertAssetsNotLeased } from './offlineLeases'

/**
 * Maintenance tickets (W5, TAS §11). A ticket is a distinct, append-only-history record: closing
 * or updating it never overwrites earlier service events. Asset operational state and ticket
 * state are always changed together, inside the same transaction (TAS §11.2).
 */

const canViewCost = (ctx: OpContext): boolean => ctx.actor.permissions.has('finance.view_cost')

async function baseCurrency(c: SqlClient, ctx: OpContext): Promise<string> {
  return (await c.one<{ c: string }>('SELECT base_currency AS c FROM organizations WHERE id = $1', [ctx.actor.organizationId]))!.c
}

/** Shared per-organization counter for ticket and audit numbers (row-locked by the UPDATE). */
export async function nextW5Number(t: SqlClient, org: string, kind: 'ticket' | 'audit'): Promise<string> {
  const column = kind === 'ticket' ? 'next_ticket' : 'next_audit'
  await t.exec('INSERT INTO w5_counters (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [org])
  const r = await t.one<{ n: number }>(`UPDATE w5_counters SET ${column} = ${column} + 1 WHERE organization_id = $1 RETURNING ${column} - 1 AS n`, [org])
  return `${kind === 'ticket' ? 'MT' : 'AUD'}-${String(r!.n).padStart(6, '0')}`
}

async function recordEvent(t: SqlClient, ctx: OpContext, ticketId: string, type: TicketEventType, notes: string | null): Promise<void> {
  await t.exec('INSERT INTO maintenance_ticket_events (id, organization_id, ticket_id, event_type, actor_user_id, notes) VALUES ($1, $2, $3, $4, $5, $6)', [
    newId(), ctx.actor.organizationId, ticketId, type, ctx.actor.userId, notes
  ])
}

const TICKET_COLUMNS = `t.id, t.ticket_number AS "ticketNumber", t.asset_id AS "assetId", a.asset_code AS "assetCode", c.name AS "assetCategoryName",
         t.fault_category AS "faultCategory", t.priority, t.status, t.description, ru.display_name AS "reportedByName", t.reported_at AS "reportedAt",
         tu.display_name AS "assignedTechnicianName", t.vendor_name AS "vendorName", t.target_resolution_date AS "targetResolutionDate",
         t.resolved_at AS "resolvedAt", t.closed_at AS "closedAt",
         (t.status IN ('open', 'in_progress') AND t.target_resolution_date IS NOT NULL AND t.target_resolution_date < current_date) AS overdue`
const TICKET_FROM = `FROM maintenance_tickets t
  JOIN assets a ON a.id = t.asset_id
  JOIN asset_categories c ON c.id = a.category_id
  JOIN users ru ON ru.id = t.reported_by
  LEFT JOIN users tu ON tu.id = t.assigned_technician_id`

export async function listTickets(db: Db, raw: TicketListInput, ctx: OpContext): Promise<Page<MaintenanceTicketSummary>> {
  assertPermission(ctx.actor.permissions, 'maintenance.view')
  const input = ticketListSchema.parse(raw)
  const p = new Params()
  const where = [`t.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (input.assetId) where.push(`t.asset_id = ${p.add(input.assetId)}`)
  if (input.status !== 'all') where.push(`t.status = ${p.add(input.status)}`)
  if (input.priority) where.push(`t.priority = ${p.add(input.priority)}`)
  if (input.assignedTechnicianId) where.push(`t.assigned_technician_id = ${p.add(input.assignedTechnicianId)}`)
  if (input.openOnly) where.push(`t.status IN ('open', 'in_progress')`)
  if (input.overdueOnly) where.push(`t.status IN ('open', 'in_progress') AND t.target_resolution_date < current_date`)
  if (input.query) {
    const q = p.add(likePattern(input.query.toLowerCase()))
    where.push(`(lower(t.ticket_number) LIKE ${q} ESCAPE '\\' OR lower(a.asset_code) LIKE ${q} ESCAPE '\\' OR lower(COALESCE(t.vendor_name, '')) LIKE ${q} ESCAPE '\\' OR lower(COALESCE(tu.display_name, '')) LIKE ${q} ESCAPE '\\')`)
  }
  const whereSql = where.join(' AND ')
  const total = Number((await db.one<{ n: number }>(`SELECT count(*) AS n ${TICKET_FROM} WHERE ${whereSql}`, p.values))!.n)
  const rows = await db.many<MaintenanceTicketSummary>(`SELECT ${TICKET_COLUMNS} ${TICKET_FROM} WHERE ${whereSql} ORDER BY t.reported_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`, p.values)
  return { items: rows, total, page: input.page, pageSize: input.pageSize }
}

export async function getTicket(c: SqlClient, storage: DocumentStorage, ticketId: string, ctx: OpContext, afterWrite = false): Promise<MaintenanceTicketDetail> {
  // The actor who just performed an authorized write (e.g. reported a fault) may see its result
  // even without the general maintenance.view permission.
  if (!afterWrite) assertPermission(ctx.actor.permissions, 'maintenance.view')
  const org = ctx.actor.organizationId
  const row = requireRow(
    await c.one<
      MaintenanceTicketSummary & {
        diagnosis: string | null
        workPerformed: string | null
        vendorReference: string | null
        partsCost: number | null
        laborCost: number | null
        currency: string | null
        downtimeMinutes: number | null
        closingNotes: string | null
        cancelReason: string | null
        resultOutcome: ReturnOutcome | null
        justifiedDuplicate: boolean
      }
    >(
      `SELECT ${TICKET_COLUMNS}, t.diagnosis, t.work_performed AS "workPerformed", t.vendor_reference AS "vendorReference", t.parts_cost_minor AS "partsCost",
              t.labor_cost_minor AS "laborCost", t.currency, t.downtime_minutes AS "downtimeMinutes", t.closing_notes AS "closingNotes",
              t.cancel_reason AS "cancelReason", t.result_outcome AS "resultOutcome", t.justified_duplicate AS "justifiedDuplicate"
       ${TICKET_FROM} WHERE t.organization_id = $1 AND t.id = $2`,
      [org, ticketId]
    ),
    'Maintenance ticket'
  )
  const events = await c.many<MaintenanceEventView>(
    `SELECT e.id, e.event_type AS "eventType", e.occurred_at AS "occurredAt", u.display_name AS "actorName", e.notes
     FROM maintenance_ticket_events e LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.organization_id = $1 AND e.ticket_id = $2 ORDER BY e.seq`,
    [org, ticketId]
  )
  const costVisible = canViewCost(ctx)
  const documents = await listDocumentLinks(c, storage, ctx, 'maintenance_ticket', ticketId)
  return {
    ...row,
    costVisible,
    partsCostMinor: costVisible ? row.partsCost : null,
    laborCostMinor: costVisible ? row.laborCost : null,
    currency: row.currency ?? (await baseCurrency(c, ctx)),
    events,
    documents
  }
}

/** Active users who can be assigned tickets, without exposing full user-management data (D35-style scoping). */
export async function listTechnicians(c: SqlClient, ctx: OpContext): Promise<Array<{ id: string; displayName: string }>> {
  assertPermission(ctx.actor.permissions, 'maintenance.assign')
  return c.many<{ id: string; displayName: string }>(
    `SELECT DISTINCT u.id, u.display_name AS "displayName"
     FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE u.organization_id = $1 AND u.is_active AND rp.permission_key IN ('maintenance.update', 'maintenance.assign', 'maintenance.close')
     ORDER BY u.display_name`,
    [ctx.actor.organizationId]
  )
}

/** The assignee must be active and actually hold a maintenance permission (same filter as listTechnicians). */
async function assertTechnician(t: SqlClient, org: string, userId: string, field: string): Promise<void> {
  const row = await t.one<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE u.id = $1 AND u.organization_id = $2 AND u.is_active AND rp.permission_key IN ('maintenance.update', 'maintenance.assign', 'maintenance.close')
     ) AS ok`,
    [userId, org]
  )
  if (!row?.ok) invalid(field, 'Choose an active user who holds a maintenance permission')
}

/** `allowLeaseId` (W9.7): only `offlineSync.ts` passes this, to let a synced ticket through on the
 *  asset its own authorized lease covers; every ordinary caller omits it and the C1 block applies. */
export async function createTicket(db: Db, storage: DocumentStorage, raw: CreateTicketInput, ctx: OpContext, allowLeaseId?: string): Promise<MaintenanceTicketDetail> {
  assertPermission(ctx.actor.permissions, 'maintenance.create')
  const input = createTicketSchema.parse(raw)
  const org = ctx.actor.organizationId
  if (input.forceAdditional && !ctx.actor.permissions.has('maintenance.assign')) {
    throw new AppError('PERMISSION_DENIED', 'Opening an additional ticket for an asset that already has one requires technician-assignment authority.')
  }
  if (input.forceAdditional && !input.justification) invalid('justification', 'Explain why a second concurrent ticket is needed')
  // Assigning a technician at creation is the same privileged action as a later assignTicket call
  // (TAS §11: "Assign technicians" is its own permission) — maintenance.create alone must not grant it.
  if (input.assignedTechnicianId && !ctx.actor.permissions.has('maintenance.assign')) {
    throw new AppError('PERMISSION_DENIED', 'Assigning a technician requires technician-assignment authority.', { assignedTechnicianId: 'Requires maintenance.assign' })
  }
  return db.tx(async (t) => {
    const a = await t.one<{ code: string; lifecycle: string }>('SELECT asset_code AS code, lifecycle_status AS lifecycle FROM assets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.assetId, org])
    if (!a) invalid('assetId', 'Asset not found')
    if (a.lifecycle !== 'active') conflict(`${a.code} is ${a.lifecycle}; a maintenance ticket can only be opened on an active asset.`)
    await assertAssetsNotLeased(t, org, [input.assetId], allowLeaseId)
    const existing = await t.one<{ number: string }>(
      "SELECT ticket_number AS number FROM maintenance_tickets WHERE organization_id = $1 AND asset_id = $2 AND status IN ('open', 'in_progress') AND NOT justified_duplicate FOR UPDATE",
      [org, input.assetId]
    )
    if (existing && !input.forceAdditional) {
      conflict(`${a.code} already has an open ticket (${existing.number}). Work that ticket, or open an additional one with a stated reason.`)
    }
    if (input.assignedTechnicianId) {
      await assertTechnician(t, org, input.assignedTechnicianId, 'assignedTechnicianId')
    }
    const id = newId()
    const number = await nextW5Number(t, org, 'ticket')
    const status = input.assignedTechnicianId ? 'in_progress' : 'open'
    await insertTicket(t, {
      id, org, number, assetId: input.assetId, category: input.category, priority: input.priority, description: input.description,
      status, reportedBy: ctx.actor.userId, assignedTechnicianId: input.assignedTechnicianId, targetResolutionDate: input.targetResolutionDate,
      vendorName: input.vendorName, vendorReference: input.vendorReference, justifiedDuplicate: input.forceAdditional
    }, a.code)
    await recordEvent(t, ctx, id, 'created', input.forceAdditional ? `Additional ticket: ${input.justification}` : null)
    if (input.assignedTechnicianId) await recordEvent(t, ctx, id, 'assigned', null)
    // Any open ticket means the asset needs attention; it is no longer ready for issue (TAS §11.2).
    if (a.lifecycle === 'active') await t.exec("UPDATE assets SET operational_status = 'under_maintenance', updated_at = now() WHERE id = $1 AND operational_status <> 'under_maintenance'", [input.assetId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'maintenance.ticket_created', entityType: 'maintenance_ticket', entityId: id, summary: { ticketNumber: number, assetCode: a.code, category: input.category, priority: input.priority, forceAdditional: input.forceAdditional } })
    return getTicket(t, storage, id, ctx, true)
  })
}

async function insertTicket(
  t: SqlClient,
  v: { id: string; org: string; number: string; assetId: string; category: string; priority: string; description: string; status: string; reportedBy: string; assignedTechnicianId: string | null; targetResolutionDate: string | null; vendorName: string | null; vendorReference: string | null; justifiedDuplicate: boolean },
  assetCode: string
): Promise<void> {
  try {
    await t.exec(
      `INSERT INTO maintenance_tickets (id, organization_id, ticket_number, asset_id, fault_category, priority, description, status, reported_by,
              assigned_technician_id, assigned_at, target_resolution_date, vendor_name, vendor_reference, justified_duplicate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10::uuid IS NOT NULL THEN now() END, $11, $12, $13, $14)`,
      [v.id, v.org, v.number, v.assetId, v.category, v.priority, v.description, v.status, v.reportedBy, v.assignedTechnicianId, v.targetResolutionDate, v.vendorName, v.vendorReference, v.justifiedDuplicate]
    )
  } catch (err) {
    if (pgErrorCode(err) === '23505' && String((err as { constraint?: string }).constraint) === 'one_open_ticket_per_asset') {
      throw new AppError('STATE_CONFLICT', `${assetCode} was given another open ticket by another request just now. Refresh and try again.`)
    }
    throw err
  }
}

async function lockTicket(t: SqlClient, ctx: OpContext, ticketId: string): Promise<{ id: string; assetId: string; assetCode: string; status: string }> {
  const row = await t.one<{ id: string; assetId: string; assetCode: string; status: string }>(
    `SELECT t.id, t.asset_id AS "assetId", a.asset_code AS "assetCode", t.status
     FROM maintenance_tickets t JOIN assets a ON a.id = t.asset_id WHERE t.id = $1 AND t.organization_id = $2 FOR UPDATE OF t`,
    [ticketId, ctx.actor.organizationId]
  )
  return requireRow(row, 'Maintenance ticket')
}

export async function assignTicket(db: Db, storage: DocumentStorage, raw: AssignTicketInput, ctx: OpContext): Promise<MaintenanceTicketDetail> {
  assertPermission(ctx.actor.permissions, 'maintenance.assign')
  const input = assignTicketSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const ticket = await lockTicket(t, ctx, input.ticketId)
    if (!['open', 'in_progress'].includes(ticket.status)) conflict('This ticket is no longer open for work.')
    await assertTechnician(t, org, input.assignedTechnicianId, 'assignedTechnicianId')
    await t.exec("UPDATE maintenance_tickets SET assigned_technician_id = $2, assigned_at = now(), status = 'in_progress', updated_at = now() WHERE id = $1", [input.ticketId, input.assignedTechnicianId])
    await recordEvent(t, ctx, input.ticketId, 'assigned', input.notes)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'maintenance.ticket_assigned', entityType: 'maintenance_ticket', entityId: input.ticketId, summary: { assetCode: ticket.assetCode, assignedTechnicianId: input.assignedTechnicianId } })
    return getTicket(t, storage, input.ticketId, ctx, true)
  })
}

/** Rejects a cost value from a non-finance viewer; a null value from them keeps the stored cost untouched. */
async function resolveCost(t: SqlClient, ctx: OpContext, raw: string | null, stored: number | null, field: string): Promise<number | null> {
  if (raw === null) return canViewCost(ctx) ? null : stored
  if (!canViewCost(ctx)) throw new AppError('PERMISSION_DENIED', 'You do not have permission to record maintenance costs.', { [field]: 'Requires finance permission' })
  const currency = await baseCurrency(t, ctx)
  const minor = parseMoneyToMinor(raw, currency)
  if (minor === null) invalid(field, `Enter an amount like 1500.00 (${currency})`)
  return minor
}

/** Full replace, matching `assets.update`: the browser resends every field (D34/D35-style consistency). */
export async function updateTicket(db: Db, storage: DocumentStorage, raw: UpdateTicketInput, ctx: OpContext): Promise<MaintenanceTicketDetail> {
  assertPermission(ctx.actor.permissions, 'maintenance.update')
  const input = updateTicketSchema.parse(raw)
  return db.tx(async (t) => {
    const ticket = await lockTicket(t, ctx, input.ticketId)
    if (!['open', 'in_progress'].includes(ticket.status)) conflict('Only an open or in-progress ticket can be updated.')
    const before = await t.one<{ partsCost: number | null; laborCost: number | null }>('SELECT parts_cost_minor AS "partsCost", labor_cost_minor AS "laborCost" FROM maintenance_tickets WHERE id = $1', [input.ticketId])
    const currency = await baseCurrency(t, ctx)
    const partsCost = await resolveCost(t, ctx, input.partsCost, before!.partsCost, 'partsCost')
    const laborCost = await resolveCost(t, ctx, input.laborCost, before!.laborCost, 'laborCost')
    await t.exec(
      `UPDATE maintenance_tickets SET priority = $2, description = $3, diagnosis = $4, work_performed = $5, vendor_name = $6, vendor_reference = $7,
              parts_cost_minor = $8, labor_cost_minor = $9, currency = COALESCE(currency, $10), downtime_minutes = $11, target_resolution_date = $12, updated_at = now()
       WHERE id = $1`,
      [input.ticketId, input.priority, input.description, input.diagnosis, input.workPerformed, input.vendorName, input.vendorReference,
        partsCost, laborCost, currency, input.downtimeMinutes, input.targetResolutionDate]
    )
    await recordEvent(t, ctx, input.ticketId, 'updated', input.notes)
    const costChanged = partsCost !== before!.partsCost || laborCost !== before!.laborCost
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'maintenance.ticket_updated', entityType: 'maintenance_ticket', entityId: input.ticketId, summary: { assetCode: ticket.assetCode, costChanged } })
    return getTicket(t, storage, input.ticketId, ctx, true)
  })
}

export async function resolveTicket(db: Db, storage: DocumentStorage, raw: ResolveTicketInput, ctx: OpContext): Promise<MaintenanceTicketDetail> {
  assertPermission(ctx.actor.permissions, 'maintenance.update')
  const input = resolveTicketSchema.parse(raw)
  return db.tx(async (t) => {
    const ticket = await lockTicket(t, ctx, input.ticketId)
    if (!['open', 'in_progress'].includes(ticket.status)) conflict('Only an open or in-progress ticket can be resolved.')
    await t.exec("UPDATE maintenance_tickets SET status = 'resolved', diagnosis = $2, work_performed = $3, downtime_minutes = COALESCE($4, downtime_minutes), resolved_at = now(), updated_at = now() WHERE id = $1", [
      input.ticketId, input.diagnosis, input.workPerformed, input.downtimeMinutes
    ])
    await recordEvent(t, ctx, input.ticketId, 'resolved', input.notes)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'maintenance.ticket_resolved', entityType: 'maintenance_ticket', entityId: input.ticketId, summary: { assetCode: ticket.assetCode } })
    return getTicket(t, storage, input.ticketId, ctx, true)
  })
}

/**
 * Closes the ticket and applies the authorized return-to-service decision to the asset. Closing
 * never makes the asset available by itself: `ready` requires the same inspection authority used
 * for a normal return (TAS §11.2, resolves KNOWN_ISSUES W-19).
 */
export async function closeTicket(db: Db, storage: DocumentStorage, raw: CloseTicketInput, ctx: OpContext): Promise<MaintenanceTicketDetail> {
  assertPermission(ctx.actor.permissions, 'maintenance.close')
  const input = closeTicketSchema.parse(raw)
  if (input.resultOutcome === 'ready' && !ctx.actor.permissions.has('allocations.inspect')) {
    throw new AppError('PERMISSION_DENIED', 'Releasing an asset as ready also requires permission to inspect returned assets.', { resultOutcome: 'Requires inspection permission' })
  }
  return db.tx(async (t) => {
    const ticket = await lockTicket(t, ctx, input.ticketId)
    if (ticket.status !== 'resolved') conflict('Resolve the ticket (diagnosis and work performed) before closing it.')
    // The asset row itself was never locked here (only the ticket was); lock it before mutating its
    // operational status, the same discipline every other asset-state-changing path follows.
    await t.one('SELECT id FROM assets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [ticket.assetId, ctx.actor.organizationId])
    await assertAssetsNotLeased(t, ctx.actor.organizationId, [ticket.assetId])
    await t.exec("UPDATE maintenance_tickets SET status = 'closed', result_outcome = $2, closing_notes = $3, closed_by = $4, closed_at = now(), updated_at = now() WHERE id = $1", [
      input.ticketId, input.resultOutcome, input.closingNotes, ctx.actor.userId
    ])
    await t.exec('UPDATE assets SET operational_status = $2, updated_at = now() WHERE id = $1', [ticket.assetId, input.resultOutcome])
    await recordEvent(t, ctx, input.ticketId, 'closed', input.closingNotes)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'maintenance.ticket_closed', entityType: 'maintenance_ticket', entityId: input.ticketId, reason: input.closingNotes, summary: { assetCode: ticket.assetCode, resultOutcome: input.resultOutcome } })
    return getTicket(t, storage, input.ticketId, ctx, true)
  })
}

/** Cancels an open/in-progress ticket (e.g. a duplicate or mistaken report). Never touches asset state. */
export async function cancelTicket(db: Db, storage: DocumentStorage, raw: CancelTicketInput, ctx: OpContext): Promise<MaintenanceTicketDetail> {
  assertPermission(ctx.actor.permissions, 'maintenance.close')
  const input = cancelTicketSchema.parse(raw)
  return db.tx(async (t) => {
    const ticket = await lockTicket(t, ctx, input.ticketId)
    if (!['open', 'in_progress'].includes(ticket.status)) conflict('Only an open or in-progress ticket can be cancelled.')
    await t.exec("UPDATE maintenance_tickets SET status = 'cancelled', cancel_reason = $2, closed_by = $3, closed_at = now(), updated_at = now() WHERE id = $1", [input.ticketId, input.reason, ctx.actor.userId])
    await recordEvent(t, ctx, input.ticketId, 'cancelled', input.reason)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'maintenance.ticket_cancelled', entityType: 'maintenance_ticket', entityId: input.ticketId, reason: input.reason, summary: { assetCode: ticket.assetCode } })
    return getTicket(t, storage, input.ticketId, ctx, true)
  })
}

/** Dashboard figures; null when the user cannot view maintenance tickets. */
export async function maintenanceMetrics(c: SqlClient, ctx: OpContext): Promise<{ open: number; overdue: number } | null> {
  if (!ctx.actor.permissions.has('maintenance.view')) return null
  const r = await c.one<{ open: number; overdue: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress')) AS open,
            count(*) FILTER (WHERE status IN ('open', 'in_progress') AND target_resolution_date < current_date) AS overdue
     FROM maintenance_tickets WHERE organization_id = $1`,
    [ctx.actor.organizationId]
  )
  return { open: Number(r!.open), overdue: Number(r!.overdue) }
}
