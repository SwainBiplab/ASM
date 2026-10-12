import type { AcknowledgmentMethod, AcknowledgmentPolicy, AcknowledgmentStatus, AssignmentTargetType, MovementType, ReturnOutcome } from '@shared/allocations'
import { TARGET_TYPE_LABELS } from '@shared/allocations'
import {
  acknowledgeInputSchema,
  assignmentListSchema,
  inspectInputSchema,
  issueInputSchema,
  reportLostInputSchema,
  returnInputSchema,
  transferInputSchema,
  type AcknowledgeInput,
  type AssignmentListInput,
  type AssignmentTarget,
  type InspectInput,
  type IssueInput,
  type ReportLostInput,
  type ReturnInput,
  type TransferInput
} from '@shared/allocationSchemas'
import type { AssetCustody, AssignmentView, HandoverItemView, HandoverView, MovementView, Page } from '@shared/api'
import type { AssetCondition, LifecycleStatus, OperationalStatus } from '@shared/assets'
import type { PermissionKey } from '@shared/permissions'
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import { pgErrorCode, type Db, type SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { listDocumentLinks } from './documents'
import { auditFrom, getSettings, recordAudit } from './foundation'
import { loadLocationPaths } from './organization'
import { assertAssetsNotLeased } from './offlineLeases'

/**
 * Allocation, transfer, return, inspection and loss (W4, TAS §9). Every mutation runs in one
 * transaction: assets are row-locked in a stable order, the partial unique index
 * `one_active_assignment_per_asset` is the final guard against concurrent issues, and the
 * assignment, handover, movement, asset state and audit event commit together or not at all.
 */

const TARGET_COLUMN: Record<AssignmentTargetType, string> = {
  employee: 'employee_id',
  workstation: 'workstation_id',
  department: 'department_id',
  team: 'team_id',
  pool: 'pool_id'
}
const TARGET_COLUMNS = Object.values(TARGET_COLUMN)

export const VIEW_ASSIGNMENTS: readonly PermissionKey[] = ['allocations.view']

// ------------------------------------------------------------------ shared helpers

/** Next number from the per-organization counter; the UPDATE row lock serializes callers. */
export async function nextNumber(t: SqlClient, org: string, kind: 'handover' | 'clearance'): Promise<string> {
  const column = kind === 'handover' ? 'next_handover' : 'next_clearance'
  await t.exec('INSERT INTO allocation_counters (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [org])
  const r = await t.one<{ n: number }>(`UPDATE allocation_counters SET ${column} = ${column} + 1 WHERE organization_id = $1 RETURNING ${column} - 1 AS n`, [org])
  return `${kind === 'handover' ? 'HO' : 'EXC'}-${String(r!.n).padStart(6, '0')}`
}

interface ResolvedTarget {
  type: AssignmentTargetType
  id: string
  label: string
  /** Physical location implied by the target (a workstation's location), if any. */
  defaultLocationId: string | null
}

/** The target must exist in the caller's organization, be active, and not be on an allocation hold. */
async function resolveTarget(t: SqlClient, ctx: OpContext, target: AssignmentTarget): Promise<ResolvedTarget> {
  const org = ctx.actor.organizationId
  const fail = (message: string): never => invalid('target', message)
  switch (target.type) {
    case 'employee': {
      // FOR SHARE: issuing waits for a clearance being opened for this employee (which locks FOR UPDATE).
      const e = await t.one<{ name: string; code: string; status: string }>('SELECT full_name AS name, employee_code AS code, employment_status AS status FROM employees WHERE id = $1 AND organization_id = $2 FOR SHARE', [target.id, org])
      if (!e) return fail('Employee not found')
      if (e.status === 'exited') return fail('This employee has exited; assets cannot be issued to them')
      if (await t.one("SELECT 1 FROM exit_clearances WHERE employee_id = $1 AND organization_id = $2 AND status = 'open'", [target.id, org])) {
        return fail('This employee has an open exit clearance; new assets cannot be issued to them')
      }
      return { type: 'employee', id: target.id, label: `${e.name} (${e.code})`, defaultLocationId: null }
    }
    case 'workstation': {
      const w = await t.one<{ code: string; a: boolean; l: string }>('SELECT code, is_active AS a, location_id AS l FROM workstations WHERE id = $1 AND organization_id = $2', [target.id, org])
      if (!w) return fail('Workstation not found')
      if (!w.a) return fail('This workstation is deactivated')
      return { type: 'workstation', id: target.id, label: w.code, defaultLocationId: w.l }
    }
    case 'department':
    case 'team':
    case 'pool': {
      const table = target.type === 'department' ? 'departments' : target.type === 'team' ? 'teams' : 'asset_pools'
      const r = await t.one<{ name: string; a: boolean }>(`SELECT name, is_active AS a FROM ${table} WHERE id = $1 AND organization_id = $2`, [target.id, org])
      if (!r) return fail(`${TARGET_TYPE_LABELS[target.type]} not found`)
      if (!r.a) return fail(`This ${TARGET_TYPE_LABELS[target.type].toLowerCase()} is deactivated`)
      return { type: target.type, id: target.id, label: r.name, defaultLocationId: null }
    }
  }
}

async function assertLocation(t: SqlClient, ctx: OpContext, locationId: string | null, field: string): Promise<void> {
  if (!locationId) return
  const l = await t.one<{ a: boolean }>('SELECT is_active AS a FROM locations WHERE id = $1 AND organization_id = $2', [locationId, ctx.actor.organizationId])
  if (!l) invalid(field, 'Location not found')
  if (!l.a) invalid(field, 'This location is deactivated')
}

interface LockedAsset {
  id: string
  code: string
  lifecycle: LifecycleStatus
  operational: OperationalStatus
  locationId: string | null
}

/** Locks the assets in a stable order (prevents deadlocks between overlapping handovers). */
async function lockAssets(t: SqlClient, ctx: OpContext, ids: string[]): Promise<Map<string, LockedAsset>> {
  const rows = await t.many<LockedAsset>(
    `SELECT id, asset_code AS code, lifecycle_status AS lifecycle, operational_status AS operational, location_id AS "locationId"
     FROM assets WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [ctx.actor.organizationId, ids]
  )
  if (rows.length !== ids.length) throw new AppError('NOT_FOUND', 'One or more assets were not found.')
  // C1 (W9.2): an asset under an active offline lease cannot be mutated through the browser, even
  // by the lease's own holder, since that could race their own not-yet-synced offline work.
  await assertAssetsNotLeased(t, ctx.actor.organizationId, ids)
  return new Map(rows.map((r) => [r.id, r]))
}

interface ActiveAssignment {
  id: string
  targetType: AssignmentTargetType
  targetId: string
}

async function activeAssignment(t: SqlClient, ctx: OpContext, assetId: string, lock: boolean): Promise<ActiveAssignment | null> {
  return (
    (await t.one<ActiveAssignment>(
      `SELECT id, target_type AS "targetType", COALESCE(employee_id, workstation_id, department_id, team_id, pool_id) AS "targetId"
       FROM asset_assignments WHERE organization_id = $1 AND asset_id = $2 AND status = 'active'${lock ? ' FOR UPDATE' : ''}`,
      [ctx.actor.organizationId, assetId]
    )) ?? null
  )
}

/** Eligibility for issue (TAS §6.4): active, operationally ready and unassigned. */
function issueBlocker(a: LockedAsset, assigned: boolean): string | null {
  if (a.lifecycle !== 'active') return `${a.code} is ${a.lifecycle} and cannot be issued.`
  if (assigned) return `${a.code} is already assigned. Return or transfer it instead.`
  if (a.operational !== 'ready') return `${a.code} is not ready for issue (status: ${a.operational.replace(/_/g, ' ')}).`
  return null
}

/** Inserting a second active assignment trips the partial unique index; report it as a conflict. */
async function insertAssignment(t: SqlClient, sql: string, params: unknown[], assetCode: string): Promise<void> {
  try {
    await t.exec(sql, params)
  } catch (err) {
    if (pgErrorCode(err) === '23505' && String((err as { constraint?: string }).constraint) === 'one_active_assignment_per_asset') {
      throw new AppError('STATE_CONFLICT', `${assetCode} was assigned by another request just now. Refresh and try again.`)
    }
    throw err
  }
}

async function recordMovement(
  t: SqlClient,
  ctx: OpContext,
  m: { assetId: string; type: MovementType; assignmentId: string | null; handoverId: string | null; locationId: string | null; notes: string | null }
): Promise<void> {
  await t.exec(
    'INSERT INTO asset_movements (id, organization_id, asset_id, movement_type, assignment_id, handover_id, location_id, actor_user_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [newId(), ctx.actor.organizationId, m.assetId, m.type, m.assignmentId, m.handoverId, m.locationId, ctx.actor.userId, m.notes]
  )
}

/** Acknowledgment state for an issue/transfer under the organization's policy (TAS B3, D39). */
function acknowledgmentFor(policy: AcknowledgmentPolicy, ack: { acknowledgedByName: string } | null): { status: AcknowledgmentStatus; method: AcknowledgmentMethod | null; name: string | null } {
  if (policy === 'signed_receipt') {
    if (ack) invalid('acknowledgment', 'This organization records handovers with a signed receipt. Print the receipt and attach the signed copy.')
    return { status: 'pending', method: null, name: null }
  }
  if (!ack) {
    if (policy === 'in_app') invalid('acknowledgment', 'The recipient must confirm receipt on screen')
    return { status: 'pending', method: null, name: null }
  }
  return { status: 'acknowledged', method: 'in_app', name: ack.acknowledgedByName }
}

async function insertHandover(
  t: SqlClient,
  ctx: OpContext,
  h: {
    type: 'issue' | 'transfer' | 'return'
    target: ResolvedTarget | null
    locationId: string | null
    reason: string | null
    notes: string | null
    policy: AcknowledgmentPolicy
    ack: { status: AcknowledgmentStatus; method: AcknowledgmentMethod | null; name: string | null }
  }
): Promise<{ id: string; number: string }> {
  const org = ctx.actor.organizationId
  const id = newId()
  const number = await nextNumber(t, org, 'handover')
  const targetValues = TARGET_COLUMNS.map((c) => (h.target && TARGET_COLUMN[h.target.type] === c ? h.target.id : null))
  const acknowledged = h.ack.status === 'acknowledged'
  await t.exec(
    `INSERT INTO handovers (id, organization_id, handover_number, handover_type, target_type, ${TARGET_COLUMNS.join(', ')}, location_id, performed_by, reason, notes,
                            ack_policy, ack_status, ack_method, acknowledged_by_name, acknowledged_at, ack_recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, CASE WHEN $19::boolean THEN now() END, $20)`,
    [id, org, number, h.type, h.target?.type ?? null, ...targetValues, h.locationId, ctx.actor.userId, h.reason, h.notes,
      h.policy, h.ack.status, h.ack.method, h.ack.name, acknowledged, acknowledged ? ctx.actor.userId : null]
  )
  return { id, number }
}

// ------------------------------------------------------------------ issue

export async function issueAssets(db: Db, storage: DocumentStorage, raw: IssueInput, ctx: OpContext): Promise<HandoverView> {
  assertPermission(ctx.actor.permissions, 'allocations.issue')
  const input = issueInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const target = await resolveTarget(t, ctx, input.target)
    await assertLocation(t, ctx, input.locationId, 'locationId')
    const policy = (await getSettings(t, org)).handoverAcknowledgment
    const ack = acknowledgmentFor(policy, input.acknowledgment)
    const assets = await lockAssets(t, ctx, input.lines.map((l) => l.assetId))
    for (const line of input.lines) {
      const a = assets.get(line.assetId)!
      const blocker = issueBlocker(a, (await activeAssignment(t, ctx, a.id, false)) !== null)
      if (blocker) throw new AppError('STATE_CONFLICT', blocker)
    }
    const location = input.locationId ?? target.defaultLocationId
    const handover = await insertHandover(t, ctx, { type: 'issue', target, locationId: location, reason: null, notes: input.notes, policy, ack })
    for (const line of input.lines) {
      const a = assets.get(line.assetId)!
      const assignmentId = await createAssignment(t, ctx, { assetId: a.id, assetCode: a.code, target, locationId: location ?? a.locationId, handoverId: handover.id, expectedReturnDate: input.expectedReturnDate, condition: line.condition, accessories: line.accessories })
      await t.exec('INSERT INTO handover_items (handover_id, organization_id, asset_id, condition, accessories) VALUES ($1, $2, $3, $4, $5)', [handover.id, org, a.id, line.condition, line.accessories])
      await t.exec('UPDATE assets SET condition = $2, location_id = COALESCE($3, location_id), updated_at = now() WHERE id = $1', [a.id, line.condition, location])
      await recordMovement(t, ctx, { assetId: a.id, type: 'issued', assignmentId, handoverId: handover.id, locationId: location ?? a.locationId, notes: null })
    }
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'allocation.issued', entityType: 'handover', entityId: handover.id,
      summary: { handoverNumber: handover.number, targetType: target.type, targetId: target.id, assetCodes: input.lines.map((l) => assets.get(l.assetId)!.code), locationId: location, acknowledgment: ack.status, acknowledgmentMethod: ack.method }
    })
    return getHandover(t, storage, handover.id, ctx, true)
  })
}

async function createAssignment(
  t: SqlClient,
  ctx: OpContext,
  a: { assetId: string; assetCode: string; target: ResolvedTarget; locationId: string | null; handoverId: string; expectedReturnDate: string | null; condition: AssetCondition; accessories: string | null }
): Promise<string> {
  const id = newId()
  const targetValues = TARGET_COLUMNS.map((c) => (TARGET_COLUMN[a.target.type] === c ? a.target.id : null))
  await insertAssignment(
    t,
    `INSERT INTO asset_assignments (id, organization_id, asset_id, target_type, ${TARGET_COLUMNS.join(', ')}, location_id, issued_by, issue_handover_id, expected_return_date, condition_at_issue, accessories)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, ctx.actor.organizationId, a.assetId, a.target.type, ...targetValues, a.locationId, ctx.actor.userId, a.handoverId, a.expectedReturnDate, a.condition, a.accessories],
    a.assetCode
  )
  return id
}

// ------------------------------------------------------------------ transfer

export async function transferAssets(db: Db, storage: DocumentStorage, raw: TransferInput, ctx: OpContext): Promise<HandoverView> {
  assertPermission(ctx.actor.permissions, 'allocations.transfer')
  const input = transferInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const target = await resolveTarget(t, ctx, input.target)
    await assertLocation(t, ctx, input.locationId, 'locationId')
    const policy = (await getSettings(t, org)).handoverAcknowledgment
    const ack = acknowledgmentFor(policy, input.acknowledgment)
    const assets = await lockAssets(t, ctx, input.lines.map((l) => l.assetId))
    const current = new Map<string, ActiveAssignment>()
    for (const line of input.lines) {
      const a = assets.get(line.assetId)!
      const active = await activeAssignment(t, ctx, a.id, true)
      if (!active) conflict(`${a.code} is not currently assigned. Issue it instead.`)
      if (active.targetType === target.type && active.targetId === target.id) conflict(`${a.code} is already assigned to ${target.label}.`)
      if (await openClearanceItem(t, ctx, active.id)) conflict(`${a.code} is part of an open exit clearance. Record its return through the clearance instead.`)
      current.set(a.id, active)
    }
    const location = input.locationId ?? target.defaultLocationId
    const handover = await insertHandover(t, ctx, { type: 'transfer', target, locationId: location, reason: input.reason, notes: null, policy, ack })
    for (const line of input.lines) {
      const a = assets.get(line.assetId)!
      const old = current.get(a.id)!
      // Close the old assignment first (frees the unique index slot), then open the new one.
      await t.exec(
        `UPDATE asset_assignments SET status = 'transferred', ended_at = now(), ended_by = $2, end_handover_id = $3, condition_at_return = $4, end_reason = $5, updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [old.id, ctx.actor.userId, handover.id, line.condition, input.reason]
      )
      const assignmentId = await createAssignment(t, ctx, { assetId: a.id, assetCode: a.code, target, locationId: location ?? a.locationId, handoverId: handover.id, expectedReturnDate: input.expectedReturnDate, condition: line.condition, accessories: line.accessories })
      await t.exec('INSERT INTO handover_items (handover_id, organization_id, asset_id, condition, accessories) VALUES ($1, $2, $3, $4, $5)', [handover.id, org, a.id, line.condition, line.accessories])
      await t.exec('UPDATE assets SET condition = $2, location_id = COALESCE($3, location_id), updated_at = now() WHERE id = $1', [a.id, line.condition, location])
      await recordMovement(t, ctx, { assetId: a.id, type: 'transferred', assignmentId, handoverId: handover.id, locationId: location ?? a.locationId, notes: input.reason })
    }
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'allocation.transferred', entityType: 'handover', entityId: handover.id, reason: input.reason,
      summary: { handoverNumber: handover.number, targetType: target.type, targetId: target.id, assetCodes: input.lines.map((l) => assets.get(l.assetId)!.code), fromAssignmentIds: [...current.values()].map((c) => c.id), acknowledgment: ack.status }
    })
    return getHandover(t, storage, handover.id, ctx, true)
  })
}

async function openClearanceItem(t: SqlClient, ctx: OpContext, assignmentId: string): Promise<{ id: string; resolution: string } | null> {
  return (
    (await t.one<{ id: string; resolution: string }>(
      `SELECT i.id, i.resolution FROM exit_clearance_items i JOIN exit_clearances c ON c.id = i.clearance_id
       WHERE i.organization_id = $1 AND i.assignment_id = $2 AND c.status = 'open' FOR UPDATE OF i`,
      [ctx.actor.organizationId, assignmentId]
    )) ?? null
  )
}

// ------------------------------------------------------------------ return

/** `ready` is an inspection result: it needs the inspection permission and a sound condition. */
function assertOutcome(ctx: OpContext, outcome: ReturnOutcome, condition: AssetCondition, field: string): void {
  if (outcome !== 'ready') return
  if (!ctx.actor.permissions.has('allocations.inspect')) invalid(field, 'Only users who inspect assets can release a returned asset as ready. Choose "Needs inspection".')
  if (condition === 'damaged' || condition === 'unknown') invalid(field, 'A damaged or unchecked asset cannot be released as ready')
}

export interface ReturnLine {
  assetId: string
  condition: AssetCondition
  outcome: ReturnOutcome
  accessoriesReturned: string | null
  notes: string | null
}

/**
 * Closes the active assignments of the given assets with one return handover. Used by the
 * Allocations screen and by exit clearance (which passes `fromClearanceItemId`).
 */
export async function returnInTx(t: SqlClient, ctx: OpContext, lines: ReturnLine[], returnLocationId: string | null, notes: string | null): Promise<{ handoverId: string; handoverNumber: string; assignmentIds: Map<string, string> }> {
  const org = ctx.actor.organizationId
  await assertLocation(t, ctx, returnLocationId, 'returnLocationId')
  lines.forEach((l, i) => assertOutcome(ctx, l.outcome, l.condition, `lines.${i}.outcome`))
  const assets = await lockAssets(t, ctx, lines.map((l) => l.assetId))
  const active = new Map<string, ActiveAssignment>()
  for (const line of lines) {
    const a = assets.get(line.assetId)!
    const current = await activeAssignment(t, ctx, a.id, true)
    if (!current) conflict(`${a.code} is not currently assigned, so it cannot be returned (it may already have been returned).`)
    active.set(a.id, current)
  }
  const policy = (await getSettings(t, org)).handoverAcknowledgment
  const handover = await insertHandover(t, ctx, { type: 'return', target: null, locationId: returnLocationId, reason: null, notes, policy, ack: { status: 'not_required', method: null, name: null } })
  for (const line of lines) {
    const a = assets.get(line.assetId)!
    const current = active.get(a.id)!
    await t.exec(
      `UPDATE asset_assignments SET status = 'returned', ended_at = now(), ended_by = $2, end_handover_id = $3, condition_at_return = $4, return_outcome = $5, end_reason = $6, updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [current.id, ctx.actor.userId, handover.id, line.condition, line.outcome, line.notes]
    )
    await t.exec('INSERT INTO handover_items (handover_id, organization_id, asset_id, condition, accessories, outcome, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      handover.id, org, a.id, line.condition, line.accessoriesReturned, line.outcome, line.notes
    ])
    // The closed assignment never makes the asset available by itself: the outcome decides.
    await t.exec('UPDATE assets SET operational_status = $2, condition = $3, location_id = COALESCE($4, location_id), updated_at = now() WHERE id = $1', [a.id, line.outcome, line.condition, returnLocationId])
    await recordMovement(t, ctx, { assetId: a.id, type: 'returned', assignmentId: current.id, handoverId: handover.id, locationId: returnLocationId ?? a.locationId, notes: line.notes })
    // A return recorded outside the clearance screen still resolves the employee's clearance item.
    const item = await openClearanceItem(t, ctx, current.id)
    if (item && item.resolution !== 'returned' && item.resolution !== 'exception_approved' && item.resolution !== 'damaged') {
      const damaged = line.condition === 'damaged' || line.outcome === 'non_operational'
      await t.exec(
        `UPDATE exit_clearance_items SET resolution = $2, received_condition = $3, return_outcome = $4, return_handover_id = $5,
                exception_type = CASE WHEN $6::boolean THEN 'damaged' ELSE exception_type END,
                exception_reason = CASE WHEN $6::boolean THEN COALESCE($7, 'Returned damaged or faulty') ELSE exception_reason END,
                reported_by = CASE WHEN $6::boolean THEN $8::uuid ELSE reported_by END, reported_at = CASE WHEN $6::boolean THEN now() ELSE reported_at END, updated_at = now()
         WHERE id = $1`,
        [item.id, damaged ? 'damaged' : 'returned', line.condition, line.outcome, handover.id, damaged, line.notes, ctx.actor.userId]
      )
    }
  }
  return { handoverId: handover.id, handoverNumber: handover.number, assignmentIds: new Map([...active].map(([k, v]) => [k, v.id])) }
}

export async function returnAssets(db: Db, storage: DocumentStorage, raw: ReturnInput, ctx: OpContext): Promise<HandoverView> {
  assertPermission(ctx.actor.permissions, 'allocations.return')
  const input = returnInputSchema.parse(raw)
  return db.tx(async (t) => {
    const r = await returnInTx(t, ctx, input.lines, input.returnLocationId, input.notes)
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'allocation.returned', entityType: 'handover', entityId: r.handoverId,
      summary: { handoverNumber: r.handoverNumber, assignmentIds: [...r.assignmentIds.values()], outcomes: input.lines.map((l) => ({ assetId: l.assetId, condition: l.condition, outcome: l.outcome })) }
    })
    return getHandover(t, storage, r.handoverId, ctx, true)
  })
}

// ------------------------------------------------------------------ inspection and loss

export async function inspectAsset(db: Db, raw: InspectInput, ctx: OpContext): Promise<AssetCustody> {
  assertPermission(ctx.actor.permissions, 'allocations.inspect')
  const input = inspectInputSchema.parse(raw)
  return db.tx(async (t) => {
    const a = (await lockAssets(t, ctx, [input.assetId])).get(input.assetId)!
    if (a.lifecycle !== 'active') conflict(`${a.code} is ${a.lifecycle}; only active assets are inspected for reuse.`)
    if (a.operational !== 'awaiting_inspection') conflict(`${a.code} is not awaiting inspection.`)
    assertOutcome(ctx, input.outcome, input.condition, 'outcome')
    await t.exec('UPDATE assets SET operational_status = $2, condition = $3, updated_at = now() WHERE id = $1', [a.id, input.outcome, input.condition])
    await recordMovement(t, ctx, { assetId: a.id, type: 'inspected', assignmentId: null, handoverId: null, locationId: a.locationId, notes: input.notes })
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset.inspected', entityType: 'asset', entityId: a.id, reason: input.notes, summary: { assetCode: a.code, outcome: input.outcome, condition: input.condition } })
    return getCustody(t, a.id, ctx)
  })
}

/**
 * Explicit loss report (TAS §6.4): ends an active assignment visibly as `lost` with a reason and
 * the responsible actor, then moves the asset to lifecycle `lost`. Never done silently.
 */
export async function reportLostInTx(t: SqlClient, ctx: OpContext, assetId: string, effectiveDate: string, reason: string, viaClearance: boolean): Promise<{ assetCode: string; assignmentId: string | null }> {
  assertPermission(ctx.actor.permissions, 'assets.retire')
  const a = (await lockAssets(t, ctx, [assetId])).get(assetId)!
  if (a.lifecycle !== 'active') conflict(`${a.code} is ${a.lifecycle}; only active assets can be reported lost.`)
  if (a.operational === 'under_maintenance') conflict('Close the maintenance ticket before reporting the asset lost.')
  const current = await activeAssignment(t, ctx, a.id, true)
  if (current && !viaClearance) {
    const item = await openClearanceItem(t, ctx, current.id)
    if (item && item.resolution !== 'exception_approved') conflict(`${a.code} is part of an open exit clearance. Record it as missing there and approve the exception.`)
  }
  if (current) {
    await t.exec(`UPDATE asset_assignments SET status = 'lost', ended_at = now(), ended_by = $2, end_reason = $3, updated_at = now() WHERE id = $1 AND status = 'active'`, [current.id, ctx.actor.userId, reason])
  }
  await t.exec("UPDATE assets SET lifecycle_status = 'lost', updated_at = now() WHERE id = $1", [a.id])
  await recordMovement(t, ctx, { assetId: a.id, type: 'reported_lost', assignmentId: current?.id ?? null, handoverId: null, locationId: a.locationId, notes: reason })
  await recordAudit(t, {
    ...auditFrom(ctx), eventType: 'asset.reported_lost', entityType: 'asset', entityId: a.id, reason,
    summary: { assetCode: a.code, effectiveDate, endedAssignmentId: current?.id ?? null, viaClearance }
  })
  return { assetCode: a.code, assignmentId: current?.id ?? null }
}

export async function reportLost(db: Db, raw: ReportLostInput, ctx: OpContext): Promise<AssetCustody> {
  const input = reportLostInputSchema.parse(raw)
  assertPermission(ctx.actor.permissions, 'assets.retire')
  return db.tx(async (t) => {
    await reportLostInTx(t, ctx, input.assetId, input.effectiveDate, input.reason, false)
    return getCustody(t, input.assetId, ctx)
  })
}

// ------------------------------------------------------------------ acknowledgment

export async function acknowledgeHandover(db: Db, storage: DocumentStorage, raw: AcknowledgeInput, ctx: OpContext): Promise<HandoverView> {
  assertAnyPermission(ctx, ['allocations.issue', 'allocations.transfer'])
  const input = acknowledgeInputSchema.parse(raw)
  return db.tx(async (t) => {
    const h = requireRow(
      await t.one<{ status: AcknowledgmentStatus; policy: AcknowledgmentPolicy; number: string }>(
        'SELECT ack_status AS status, ack_policy AS policy, handover_number AS number FROM handovers WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [input.handoverId, ctx.actor.organizationId]
      ),
      'Handover'
    )
    if (h.status !== 'pending') conflict(h.status === 'acknowledged' ? 'This handover is already acknowledged.' : 'This handover does not need acknowledgment.')
    if (h.policy === 'signed_receipt') conflict('This handover must be acknowledged with a signed receipt.')
    await t.exec(
      "UPDATE handovers SET ack_status = 'acknowledged', ack_method = 'in_app', acknowledged_by_name = $2, acknowledged_at = now(), ack_recorded_by = $3 WHERE id = $1",
      [input.handoverId, input.acknowledgedByName, ctx.actor.userId]
    )
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'handover.acknowledged', entityType: 'handover', entityId: input.handoverId, summary: { handoverNumber: h.number, method: 'in_app' } })
    return getHandover(t, storage, input.handoverId, ctx, true)
  })
}

/**
 * Called inside the document-attach transaction when a signed receipt (purpose `handover`) is
 * attached to a pending handover whose policy accepts signed receipts.
 */
export async function recordSignedReceipt(t: SqlClient, ctx: OpContext, handoverId: string, documentId: string): Promise<void> {
  const h = await t.one<{ status: AcknowledgmentStatus; policy: AcknowledgmentPolicy; number: string }>(
    'SELECT ack_status AS status, ack_policy AS policy, handover_number AS number FROM handovers WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [handoverId, ctx.actor.organizationId]
  )
  if (!h || h.status !== 'pending' || h.policy === 'in_app') return
  await t.exec("UPDATE handovers SET ack_status = 'acknowledged', ack_method = 'signed_receipt', ack_document_id = $2, acknowledged_at = now(), ack_recorded_by = $3 WHERE id = $1", [
    handoverId, documentId, ctx.actor.userId
  ])
  await recordAudit(t, { ...auditFrom(ctx), eventType: 'handover.acknowledged', entityType: 'handover', entityId: handoverId, summary: { handoverNumber: h.number, method: 'signed_receipt', documentId } })
}

// ------------------------------------------------------------------ queries

const ASSIGNMENT_SELECT = `
  SELECT s.id, s.asset_id AS "assetId", a.asset_code AS "assetCode", c.name AS "categoryName",
         NULLIF(concat_ws(' ', COALESCE(m.manufacturer, a.manufacturer), COALESCE(m.model_name, a.model_name)), '') AS "makeModel",
         a.serial_number AS "serialNumber", s.target_type AS "targetType",
         COALESCE(s.employee_id, s.workstation_id, s.department_id, s.team_id, s.pool_id) AS "targetId",
         CASE s.target_type WHEN 'employee' THEN e.full_name || ' (' || e.employee_code || ')' WHEN 'workstation' THEN w.code
              WHEN 'department' THEN d.name WHEN 'team' THEN tm.name ELSE p.name END AS "targetLabel",
         s.location_id AS "locationId", s.status, s.assigned_at AS "assignedAt", s.expected_return_date AS "expectedReturnDate",
         (s.status = 'active' AND s.expected_return_date IS NOT NULL AND s.expected_return_date < current_date) AS overdue,
         iu.display_name AS "issuedByName", s.condition_at_issue AS "conditionAtIssue", s.accessories, s.ended_at AS "endedAt",
         eu.display_name AS "endedByName", s.condition_at_return AS "conditionAtReturn", s.return_outcome AS "returnOutcome", s.end_reason AS "endReason",
         s.issue_handover_id AS "issueHandoverId", h.handover_number AS "issueHandoverNumber", s.end_handover_id AS "endHandoverId",
         h.ack_status AS "acknowledgmentStatus"
  FROM asset_assignments s
  JOIN assets a ON a.id = s.asset_id
  JOIN asset_categories c ON c.id = a.category_id
  LEFT JOIN asset_models m ON m.id = a.model_id
  JOIN handovers h ON h.id = s.issue_handover_id
  LEFT JOIN employees e ON e.id = s.employee_id
  LEFT JOIN workstations w ON w.id = s.workstation_id
  LEFT JOIN departments d ON d.id = s.department_id
  LEFT JOIN teams tm ON tm.id = s.team_id
  LEFT JOIN asset_pools p ON p.id = s.pool_id
  LEFT JOIN users iu ON iu.id = s.issued_by
  LEFT JOIN users eu ON eu.id = s.ended_by`

type AssignmentRow = Omit<AssignmentView, 'locationPath'>

async function withLocationPaths(c: SqlClient, ctx: OpContext, rows: AssignmentRow[]): Promise<AssignmentView[]> {
  if (!rows.length) return []
  const paths = await loadLocationPaths(c, ctx.actor.organizationId)
  return rows.map((r) => ({ ...r, locationPath: r.locationId ? (paths.get(r.locationId)?.path ?? null) : null }))
}

export async function listAssignments(db: Db, raw: AssignmentListInput, ctx: OpContext): Promise<Page<AssignmentView>> {
  assertPermission(ctx.actor.permissions, 'allocations.view')
  const input = assignmentListSchema.parse(raw)
  const p = new Params()
  const where = [`s.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (input.status !== 'all') where.push(`s.status = ${p.add(input.status)}`)
  if (input.assetId) where.push(`s.asset_id = ${p.add(input.assetId)}`)
  if (input.employeeId) where.push(`s.employee_id = ${p.add(input.employeeId)}`)
  if (input.targetType) where.push(`s.target_type = ${p.add(input.targetType)}`)
  if (input.overdueOnly) where.push(`s.status = 'active' AND s.expected_return_date < current_date`)
  if (input.pendingAcknowledgmentOnly) where.push(`h.ack_status = 'pending'`)
  if (input.query) {
    const q = p.add(likePattern(input.query.toLowerCase()))
    where.push(`(lower(a.asset_code) LIKE ${q} ESCAPE '\\' OR lower(COALESCE(a.serial_number, '')) LIKE ${q} ESCAPE '\\' OR lower(COALESCE(e.full_name, '')) LIKE ${q} ESCAPE '\\'
              OR lower(COALESCE(e.employee_code, '')) LIKE ${q} ESCAPE '\\' OR lower(COALESCE(w.code, d.name, tm.name, p.name, '')) LIKE ${q} ESCAPE '\\')`)
  }
  const whereSql = where.join(' AND ')
  const total = Number((await db.one<{ n: number }>(`SELECT count(*) AS n FROM (${ASSIGNMENT_SELECT} WHERE ${whereSql}) x`, p.values))!.n)
  const rows = await db.many<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE ${whereSql} ORDER BY s.assigned_at DESC, a.asset_code LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`, p.values)
  return { items: await withLocationPaths(db, ctx, rows), total, page: input.page, pageSize: input.pageSize }
}

export async function getCustody(c: SqlClient, assetId: string, ctx: OpContext): Promise<AssetCustody> {
  assertPermission(ctx.actor.permissions, 'allocations.view')
  const org = ctx.actor.organizationId
  const a = requireRow(
    await c.one<{ code: string; lifecycle: LifecycleStatus; operational: OperationalStatus; locationId: string | null }>(
      'SELECT asset_code AS code, lifecycle_status AS lifecycle, operational_status AS operational, location_id AS "locationId" FROM assets WHERE id = $1 AND organization_id = $2',
      [assetId, org]
    ),
    'Asset'
  )
  const assignments = await withLocationPaths(c, ctx, await c.many<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE s.organization_id = $1 AND s.asset_id = $2 ORDER BY s.assigned_at DESC`, [org, assetId]))
  const paths = await loadLocationPaths(c, org)
  const movements = (
    await c.many<Omit<MovementView, 'locationPath'> & { locationId: string | null }>(
      `SELECT mv.id, mv.movement_type AS "movementType", mv.occurred_at AS "occurredAt", u.display_name AS "actorName", mv.assignment_id AS "assignmentId",
              mv.handover_id AS "handoverId", h.handover_number AS "handoverNumber", mv.location_id AS "locationId", mv.notes,
              CASE s.target_type WHEN 'employee' THEN e.full_name || ' (' || e.employee_code || ')' WHEN 'workstation' THEN w.code
                   WHEN 'department' THEN d.name WHEN 'team' THEN tm.name WHEN 'pool' THEN p.name END AS "targetLabel"
       FROM asset_movements mv
       LEFT JOIN users u ON u.id = mv.actor_user_id
       LEFT JOIN handovers h ON h.id = mv.handover_id
       LEFT JOIN asset_assignments s ON s.id = mv.assignment_id
       LEFT JOIN employees e ON e.id = s.employee_id
       LEFT JOIN workstations w ON w.id = s.workstation_id
       LEFT JOIN departments d ON d.id = s.department_id
       LEFT JOIN teams tm ON tm.id = s.team_id
       LEFT JOIN asset_pools p ON p.id = s.pool_id
       WHERE mv.organization_id = $1 AND mv.asset_id = $2 ORDER BY mv.seq DESC`,
      [org, assetId]
    )
  ).map(({ locationId, ...m }) => ({ ...m, locationPath: locationId ? (paths.get(locationId)?.path ?? null) : null }))
  const current = assignments.find((s) => s.status === 'active') ?? null
  const blocker = issueBlocker({ id: assetId, code: a.code, lifecycle: a.lifecycle, operational: a.operational, locationId: a.locationId }, current !== null)
  return {
    assetId, assetCode: a.code, lifecycleStatus: a.lifecycle, operationalStatus: a.operational,
    eligibleForIssue: blocker === null, ineligibleReason: blocker, currentAssignment: current, assignments, movements
  }
}

export async function getHandover(c: SqlClient, storage: DocumentStorage, id: string, ctx: OpContext, afterWrite = false): Promise<HandoverView> {
  // The user who just performed the handover may print its receipt even without the view permission.
  if (!afterWrite) assertPermission(ctx.actor.permissions, 'allocations.view')
  const org = ctx.actor.organizationId
  const h = requireRow(
    await c.one<Omit<HandoverView, 'items' | 'documents' | 'locationPath'> & { locationId: string | null }>(
      `SELECT h.id, h.handover_number AS "handoverNumber", h.handover_type AS "handoverType", o.display_name AS "organizationName", h.target_type AS "targetType",
              CASE h.target_type WHEN 'employee' THEN e.full_name || ' (' || e.employee_code || ')' WHEN 'workstation' THEN w.code
                   WHEN 'department' THEN d.name WHEN 'team' THEN tm.name WHEN 'pool' THEN p.name END AS "targetLabel",
              h.location_id AS "locationId", h.performed_at AS "performedAt", pu.display_name AS "performedByName", h.reason, h.notes,
              h.ack_policy AS "acknowledgmentPolicy", h.ack_status AS "acknowledgmentStatus", h.ack_method AS "acknowledgmentMethod",
              h.acknowledged_by_name AS "acknowledgedByName", h.acknowledged_at AS "acknowledgedAt", au.display_name AS "acknowledgmentRecordedByName",
              h.ack_document_id AS "acknowledgmentDocumentId"
       FROM handovers h JOIN organizations o ON o.id = h.organization_id JOIN users pu ON pu.id = h.performed_by LEFT JOIN users au ON au.id = h.ack_recorded_by
       LEFT JOIN employees e ON e.id = h.employee_id LEFT JOIN workstations w ON w.id = h.workstation_id LEFT JOIN departments d ON d.id = h.department_id
       LEFT JOIN teams tm ON tm.id = h.team_id LEFT JOIN asset_pools p ON p.id = h.pool_id
       WHERE h.id = $1 AND h.organization_id = $2`,
      [id, org]
    ),
    'Handover'
  )
  const items = await c.many<HandoverItemView>(
    `SELECT i.asset_id AS "assetId", a.asset_code AS "assetCode", c.name AS "categoryName",
            NULLIF(concat_ws(' ', COALESCE(m.manufacturer, a.manufacturer), COALESCE(m.model_name, a.model_name)), '') AS "makeModel",
            a.serial_number AS "serialNumber", i.condition, i.accessories, i.outcome
     FROM handover_items i JOIN assets a ON a.id = i.asset_id JOIN asset_categories c ON c.id = a.category_id LEFT JOIN asset_models m ON m.id = a.model_id
     WHERE i.handover_id = $1 ORDER BY a.asset_code`,
    [id]
  )
  const { locationId, ...rest } = h
  const locationPath = locationId ? ((await loadLocationPaths(c, org)).get(locationId)?.path ?? null) : null
  const documents = ctx.actor.permissions.has('allocations.view') ? await listDocumentLinks(c, storage, ctx, 'handover', id) : []
  return { ...rest, locationPath, items, documents }
}
