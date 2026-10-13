import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { newCorrelationId } from '../../server/src/core'
import { bootstrapOrganization } from '../../server/src/services/identity'
import { SETUP } from './api-helpers'
import { createApiSession, type ApiSession } from './session-helpers'
import { count, issue, rpcWithKey, w4Setup } from './w4-helpers'

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})
const session = async () => {
  const a = await createApiSession()
  sessions.push(a)
  return a
}
const PDF = Buffer.from('%PDF-1.4\n% signed receipt\n%%EOF\n')
const ret = (assetId: string, outcome: 'ready' | 'awaiting_inspection' | 'non_operational' = 'awaiting_inspection', condition: 'good' | 'damaged' = 'good') => ({
  lines: [{ assetId, condition, outcome, accessoriesReturned: null, notes: null }], returnLocationId: null, notes: null
})

describe('issue and the one-active-assignment invariant', () => {
  it('lets at most one of many simultaneous HTTP issue requests for the same asset succeed', async () => {
    const a = await session()
    const f = await w4Setup(a, 4)
    for (const target of f.assets) {
      // Competing requests to different targets, all in flight at once against the real API and database.
      const results = await Promise.all(
        [f.ravi.id, f.asha.id, f.ravi.id, f.asha.id, f.ravi.id].map((id) => rpcWithKey(a, 'allocations.issue', issue([target.id], { type: 'employee', id }), randomUUID()))
      )
      expect(results.filter((r) => r.status === 200)).toHaveLength(1)
      for (const r of results.filter((x) => x.status !== 200)) expect(r.body.error?.code).toBe('STATE_CONFLICT')
      expect(await count(a, "SELECT count(*) AS n FROM asset_assignments WHERE asset_id = $1 AND status = 'active'", [target.id])).toBe(1)
    }
    // No partial writes from the losing requests.
    expect(await count(a, 'SELECT count(*) AS n FROM handovers')).toBe(4)
    expect(await count(a, 'SELECT count(*) AS n FROM asset_movements')).toBe(4)
  })

  it('is enforced by the database itself, even without the service checks', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const h = await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'pool', id: f.pool.id }))
    const [row] = await a.sql<Record<string, string>>('SELECT organization_id, issued_by FROM asset_assignments WHERE asset_id = $1', [f.assets[0]!.id])
    await expect(
      a.sql(
        "INSERT INTO asset_assignments (id, organization_id, asset_id, target_type, employee_id, issued_by, issue_handover_id, condition_at_issue) VALUES (gen_random_uuid(), $1, $2, 'employee', $3, $4, $5, 'good')",
        [row!['organization_id'], f.assets[0]!.id, f.ravi.id, row!['issued_by'], h.id]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'one_active_assignment_per_asset' })
    // Exactly one target per assignment.
    await expect(
      a.sql(
        "INSERT INTO asset_assignments (id, organization_id, asset_id, target_type, employee_id, pool_id, issued_by, issue_handover_id, condition_at_issue, status, ended_at, ended_by, end_reason) VALUES (gen_random_uuid(), $1, $2, 'employee', $3, $4, $5, $6, 'good', 'lost', now(), $5, 'x')",
        [row!['organization_id'], f.assets[0]!.id, f.ravi.id, f.pool.id, row!['issued_by'], h.id]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('validates asset state, target and acknowledgment, and records everything atomically', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const [one, two, three] = f.assets
    // Missing on-screen confirmation under the default in-app policy.
    expect(await a.call('allocations.issue', issue([one!.id], { type: 'employee', id: f.ravi.id }, { acknowledgment: null }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { acknowledgment: expect.any(String) } } })
    // Unknown, deactivated and cross-type targets.
    expect(await a.call('allocations.issue', issue([one!.id], { type: 'employee', id: f.pool.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await a.ok('pools.setActive', { id: f.pool.id, isActive: false, reason: 'closed' } as never)
    expect(await a.call('allocations.issue', issue([one!.id], { type: 'pool', id: f.pool.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    // Not ready assets cannot be issued.
    await a.sql("UPDATE assets SET operational_status = 'awaiting_inspection' WHERE id = $1", [three!.id])
    expect(await a.call('allocations.issue', issue([three!.id], { type: 'employee', id: f.ravi.id }))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    const h = await a.ok('allocations.issue', issue([one!.id, two!.id], { type: 'workstation', id: f.desk.id }, { expectedReturnDate: '2030-01-31', notes: 'Night shift seat' }))
    expect(h).toMatchObject({ handoverType: 'issue', handoverNumber: 'HO-000001', targetLabel: 'PUN-3A-001', acknowledgmentStatus: 'acknowledged', acknowledgmentMethod: 'in_app', acknowledgedByName: 'Recipient Name' })
    expect(h.items.map((i) => i.assetCode).sort()).toEqual([one!.assetCode, two!.assetCode].sort())
    // The workstation's location becomes the assets' physical location (separate from the target).
    expect(h.locationPath).toContain('Floor 3')
    const custody = await a.ok('allocations.custody', { assetId: one!.id })
    expect(custody).toMatchObject({ eligibleForIssue: false, currentAssignment: { targetType: 'workstation', targetLabel: 'PUN-3A-001', expectedReturnDate: '2030-01-31' } })
    expect(custody.movements.map((m) => m.movementType)).toEqual(['issued'])
    const audit = await a.sql<{ s: { assetCodes: string[] } }>("SELECT summary AS s FROM audit_events WHERE event_type = 'allocation.issued'")
    expect(audit).toHaveLength(1)
    expect(audit[0]!.s.assetCodes).toHaveLength(2)
  })
})

describe('idempotent retries', () => {
  it('replays issue, transfer and return retries and rejects a reused key with a different body', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const [one, two] = f.assets
    const key = randomUUID()
    const first = await rpcWithKey(a, 'allocations.issue', issue([one!.id], { type: 'employee', id: f.ravi.id }), key)
    const retry = await rpcWithKey(a, 'allocations.issue', issue([one!.id], { type: 'employee', id: f.ravi.id }), key)
    expect(first.status).toBe(200)
    expect(retry.body.data?.id).toBe(first.body.data?.id)
    const conflicting = await rpcWithKey(a, 'allocations.issue', issue([two!.id], { type: 'employee', id: f.ravi.id }), key)
    expect(conflicting.status).toBe(409)
    expect(await count(a, 'SELECT count(*) AS n FROM asset_assignments')).toBe(1)
    expect(await count(a, 'SELECT count(*) AS n FROM handovers')).toBe(1)
    expect(await count(a, 'SELECT count(*) AS n FROM asset_movements')).toBe(1)

    const transfer = { target: { type: 'pool' as const, id: f.pool.id }, lines: [{ assetId: one!.id, condition: 'good' as const, accessories: null }], locationId: f.store.id, expectedReturnDate: null, reason: 'Employee moved to WFH', acknowledgment: { acknowledgedByName: 'Pool owner' } }
    const tKey = randomUUID()
    const t1 = await rpcWithKey(a, 'allocations.transfer', transfer, tKey)
    const t2 = await rpcWithKey(a, 'allocations.transfer', transfer, tKey)
    expect(t1.status).toBe(200)
    expect(t2.body.data?.id).toBe(t1.body.data?.id)
    expect(await count(a, 'SELECT count(*) AS n FROM asset_assignments WHERE asset_id = $1', [one!.id])).toBe(2)

    const rKey = randomUUID()
    const r1 = await rpcWithKey(a, 'allocations.return', ret(one!.id), rKey)
    const r2 = await rpcWithKey(a, 'allocations.return', ret(one!.id), rKey)
    expect(r2.body.data?.id).toBe(r1.body.data?.id)
    // A new request (new key) cannot close the assignment a second time.
    const r3 = await rpcWithKey(a, 'allocations.return', ret(one!.id), randomUUID())
    expect(r3.body.error?.code).toBe('STATE_CONFLICT')
    expect(await count(a, "SELECT count(*) AS n FROM asset_movements WHERE movement_type = 'returned'")).toBe(1)
    expect(await count(a, "SELECT count(*) AS n FROM handovers WHERE handover_type = 'return'")).toBe(1)
  })
})

describe('transfers', () => {
  it('closes the old assignment and opens a new one, preserving the chain of custody', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const id = f.assets[0]!.id
    await a.ok('allocations.issue', issue([id], { type: 'employee', id: f.ravi.id }))
    expect(await a.call('allocations.transfer', { target: { type: 'employee', id: f.ravi.id }, lines: [{ assetId: id, condition: 'good', accessories: null }], locationId: null, expectedReturnDate: null, reason: 'x', acknowledgment: { acknowledgedByName: 'R' } })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    const h = await a.ok('allocations.transfer', { target: { type: 'team', id: (await a.ok('teams.create', { departmentId: f.dept.id, kind: 'team', code: null, name: 'Voice', leadEmployeeId: null, notes: null })).id }, lines: [{ assetId: id, condition: 'fair', accessories: 'Charger' }], locationId: null, expectedReturnDate: null, reason: 'Team laptop', acknowledgment: { acknowledgedByName: 'Team lead' } })
    expect(h).toMatchObject({ handoverType: 'transfer', reason: 'Team laptop', targetType: 'team' })
    const c = await a.ok('allocations.custody', { assetId: id })
    expect(c.assignments.map((s) => [s.targetType, s.status])).toEqual([['team', 'active'], ['employee', 'transferred']])
    expect(c.assignments[1]).toMatchObject({ endReason: 'Team laptop', conditionAtReturn: 'fair', endHandoverId: h.id })
    expect(c.movements.map((m) => m.movementType)).toEqual(['transferred', 'issued'])
  })

  it('rolls back completely when a step fails mid-transfer (injected database failure)', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const id = f.assets[0]!.id
    await a.ok('allocations.issue', issue([id], { type: 'employee', id: f.ravi.id }))
    // Inject a failure on the new assignment insert, after the old assignment was closed in the same transaction.
    await a.sql(`CREATE FUNCTION fail_pool_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_type = 'pool' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`)
    await a.sql('CREATE TRIGGER fail_pool_assignment BEFORE INSERT ON asset_assignments FOR EACH ROW EXECUTE FUNCTION fail_pool_assignment()')
    const body = { target: { type: 'pool' as const, id: f.pool.id }, lines: [{ assetId: id, condition: 'good' as const, accessories: null }], locationId: f.store.id, expectedReturnDate: null, reason: 'To spares', acknowledgment: { acknowledgedByName: 'Owner' } }
    const failed = await a.call('allocations.transfer', body)
    expect(failed).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } })
    const rows = await a.sql<{ status: string; target_type: string }>('SELECT status, target_type FROM asset_assignments WHERE asset_id = $1', [id])
    expect(rows).toEqual([{ status: 'active', target_type: 'employee' }])
    expect(await count(a, "SELECT count(*) AS n FROM handovers WHERE handover_type = 'transfer'")).toBe(0)
    expect(await count(a, "SELECT count(*) AS n FROM asset_movements WHERE movement_type = 'transferred'")).toBe(0)
    expect(await count(a, "SELECT count(*) AS n FROM audit_events WHERE event_type = 'allocation.transferred'")).toBe(0)
    expect((await a.sql<{ l: string | null }>('SELECT location_id AS l FROM assets WHERE id = $1', [id]))[0]!.l).toBeNull()
    await a.sql('DROP TRIGGER fail_pool_assignment ON asset_assignments')
    expect((await a.ok('allocations.transfer', body)).handoverType).toBe('transfer')
  })
})

describe('returns and inspection', () => {
  it('never makes a returned asset available automatically and gates release on inspection', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const [one, two, three] = f.assets
    await a.ok('allocations.issue', issue([one!.id, two!.id, three!.id], { type: 'employee', id: f.ravi.id }))

    // Default: needs inspection.
    const r = await a.ok('allocations.return', { ...ret(one!.id), returnLocationId: f.store.id })
    expect(r.items[0]).toMatchObject({ outcome: 'awaiting_inspection' })
    let c = await a.ok('allocations.custody', { assetId: one!.id })
    expect(c).toMatchObject({ operationalStatus: 'awaiting_inspection', eligibleForIssue: false, currentAssignment: null })
    expect(c.assignments[0]).toMatchObject({ status: 'returned', returnOutcome: 'awaiting_inspection' })
    // An asset edit cannot skip the inspection.
    const detail = await a.ok('assets.get', { id: one!.id })
    const edit = { id: one!.id, categoryId: detail.categoryId, modelId: null, manufacturer: detail.manufacturer, modelName: detail.modelName, serialNumber: detail.serialNumber, specifications: null, condition: 'good' as const, operationalStatus: 'ready' as const, locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null, reason: null }
    expect(await a.call('assets.update', edit)).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    // Damaged cannot be released as ready.
    expect(await a.call('allocations.inspect', { assetId: one!.id, outcome: 'ready', condition: 'damaged', notes: 'cracked' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    c = await a.ok('allocations.inspect', { assetId: one!.id, outcome: 'ready', condition: 'good', notes: 'Wiped and checked' })
    expect(c).toMatchObject({ operationalStatus: 'ready', eligibleForIssue: true })
    expect(c.movements.map((m) => m.movementType)).toEqual(['inspected', 'returned', 'issued'])

    // Faulty returns become non-operational.
    await a.ok('allocations.return', ret(two!.id, 'non_operational', 'damaged'))
    expect((await a.ok('allocations.custody', { assetId: two!.id })).operationalStatus).toBe('non_operational')

    // A receiver without inspection permission cannot release as ready (facilities manager can receive returns only).
    await a.becomeNewUser('facilities', ['facilities_manager'])
    expect(await a.call('allocations.return', ret(three!.id, 'ready'))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect((await a.ok('allocations.return', ret(three!.id))).items[0]!.outcome).toBe('awaiting_inspection')
    expect(await a.call('allocations.inspect', { assetId: three!.id, outcome: 'ready', condition: 'good', notes: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})

describe('lifecycle versus assignment state', () => {
  it('refuses to retire, dispose or silently lose an assigned asset, and reports loss explicitly', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const [one, two] = f.assets
    await a.ok('allocations.issue', issue([one!.id], { type: 'employee', id: f.ravi.id }))
    const life = (id: string, toStatus: string) => ({ id, toStatus, reason: 'test', effectiveDate: '2026-10-11', disposalMethod: null, disposalProceeds: null }) as never
    expect(await a.call('assets.changeLifecycle', life(one!.id, 'retired'))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('Ravi Kumar') } })
    expect(await a.call('assets.changeLifecycle', life(one!.id, 'lost'))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('Report lost') } })
    expect(await count(a, "SELECT count(*) AS n FROM asset_assignments WHERE asset_id = $1 AND status = 'active'", [one!.id])).toBe(1)

    // Explicit loss report: the assignment ends visibly as lost, with reason and actor.
    const c = await a.ok('allocations.reportLost', { assetId: one!.id, effectiveDate: '2026-10-11', reason: 'Stolen from cab, FIR 123' })
    expect(c.lifecycleStatus).toBe('lost')
    expect(c.assignments[0]).toMatchObject({ status: 'lost', endReason: 'Stolen from cab, FIR 123', endedByName: expect.any(String) })
    expect(c.movements[0]).toMatchObject({ movementType: 'reported_lost' })
    // Lost and retired assets cannot be issued; found assets come back for inspection, not ready.
    expect(await a.call('allocations.issue', issue([one!.id], { type: 'employee', id: f.asha.id }))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect((await a.ok('assets.changeLifecycle', life(one!.id, 'active'))).operationalStatus).toBe('awaiting_inspection')
    await a.ok('assets.changeLifecycle', life(two!.id, 'retired'))
    expect(await a.call('allocations.issue', issue([two!.id], { type: 'employee', id: f.asha.id }))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })

  it('keeps assignment and movement history immutable', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const id = f.assets[0]!.id
    await a.ok('allocations.issue', issue([id], { type: 'employee', id: f.ravi.id }))
    await a.ok('allocations.return', ret(id))
    await expect(a.sql("UPDATE asset_assignments SET end_reason = 'rewritten' WHERE asset_id = $1", [id])).rejects.toThrow(/closed assignment/)
    await expect(a.sql('DELETE FROM asset_assignments WHERE asset_id = $1', [id])).rejects.toThrow(/never deleted/)
    await expect(a.sql("UPDATE asset_movements SET notes = 'x'")).rejects.toThrow(/append-only/)
    await expect(a.sql('DELETE FROM asset_movements')).rejects.toThrow(/append-only/)
  })
})

describe('authorization and organization boundary', () => {
  it('denies allocation operations to roles without the permission', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const id = f.assets[0]!.id
    const h = await a.ok('allocations.issue', issue([id], { type: 'employee', id: f.ravi.id }))
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    expect(await a.call('allocations.issue', issue([id], { type: 'employee', id: f.asha.id }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('allocations.return', ret(id))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('allocations.list', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('allocations.getHandover', { handoverId: h.id })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.becomeNewUser('auditor1', ['auditor'])
    expect((await a.ok('allocations.list', {})).total).toBe(1) // read-only access
    expect(await a.call('allocations.transfer', { target: { type: 'pool', id: f.pool.id }, lines: [{ assetId: id, condition: 'good', accessories: null }], locationId: null, expectedReturnDate: null, reason: 'x', acknowledgment: { acknowledgedByName: 'x' } })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('allocations.reportLost', { assetId: id, effectiveDate: '2026-10-11', reason: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await count(a, "SELECT count(*) AS n FROM asset_assignments WHERE status = 'active'")).toBe(1)
  })

  it('never lets one organization issue, see or move another organization\'s assets', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: f.ravi.id }))
    const other = await bootstrapOrganization(a.s.tdb.db, { organization: { ...SETUP.organization, legalName: 'Other BPO', displayName: 'Other' }, admin: { username: 'otheradmin', displayName: 'Other Admin', password: 'Other-Admin-Pass-1' } }, newCorrelationId(), { allowAdditional: true })
    const o = other.organizationId
    const [cat] = await a.sql<{ id: string }>("INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, asset_domain) VALUES (gen_random_uuid(), $1, 'X', 'x', 'X', 'x', 'it') RETURNING id", [o])
    const [foreignAsset] = await a.sql<{ id: string }>("INSERT INTO assets (id, organization_id, asset_code, category_id) VALUES (gen_random_uuid(), $1, 'AST-000001', $2) RETURNING id", [o, cat!.id])
    const [foreignEmployee] = await a.sql<{ id: string }>("INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name) VALUES (gen_random_uuid(), $1, 'F1', 'F1', 'Foreign Person') RETURNING id", [o])
    // Organization A cannot see, issue or receive organization B's asset, nor assign to B's employee.
    expect(await a.call('allocations.custody', { assetId: foreignAsset!.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await a.call('allocations.issue', issue([foreignAsset!.id], { type: 'employee', id: f.asha.id }))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await a.call('allocations.return', ret(foreignAsset!.id))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await a.call('allocations.transfer', { target: { type: 'employee', id: foreignEmployee!.id }, lines: [{ assetId: f.assets[0]!.id, condition: 'good', accessories: null }], locationId: null, expectedReturnDate: null, reason: 'x', acknowledgment: { acknowledgedByName: 'x' } })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await a.call('exitClearance.open', { employeeId: foreignEmployee!.id, exitDate: '2026-12-31', ownerUserId: null, notes: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    // The database refuses a cross-organization assignment even if a service check were missed.
    const [mine] = await a.sql<{ org: string; by: string; h: string }>('SELECT organization_id AS org, issued_by AS by, issue_handover_id AS h FROM asset_assignments LIMIT 1')
    await expect(
      a.sql("INSERT INTO asset_assignments (id, organization_id, asset_id, target_type, employee_id, issued_by, issue_handover_id, condition_at_issue) VALUES (gen_random_uuid(), $1, $2, 'employee', $3, $4, $5, 'good')", [mine!.org, foreignAsset!.id, f.asha.id, mine!.by, mine!.h])
    ).rejects.toMatchObject({ code: '23503' })
    expect((await a.ok('allocations.list', { status: 'all' })).total).toBe(1)
  })
})

describe('handover acknowledgment', () => {
  it('supports signed receipts as evidence, under document permissions', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    await a.ok('settings.update', { handoverAcknowledgment: 'signed_receipt' })
    expect(await a.call('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: f.ravi.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const h = await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: f.ravi.id }, { acknowledgment: null }))
    expect(h).toMatchObject({ acknowledgmentStatus: 'pending', acknowledgmentPolicy: 'signed_receipt' })
    expect((await a.ok('allocations.list', { pendingAcknowledgmentOnly: true })).total).toBe(1)
    // In-app acknowledgment is not accepted under this policy.
    expect(await a.call('allocations.acknowledge', { handoverId: h.id, acknowledgedByName: 'Ravi' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    const up = await a.upload(`/api/v1/uploads/documents?entityType=handover&entityId=${h.id}&purpose=handover`, { name: 'signed.pdf', content: PDF }, { 'idempotency-key': randomUUID() })
    expect(up.status).toBe(200)
    const after = await a.ok('allocations.getHandover', { handoverId: h.id })
    expect(after).toMatchObject({ acknowledgmentStatus: 'acknowledged', acknowledgmentMethod: 'signed_receipt', acknowledgmentRecordedByName: expect.any(String) })
    expect(after.documents).toHaveLength(1)
    const docUrl = `/api/v1/documents/${after.acknowledgmentDocumentId}/content`
    expect((await a.get(docUrl)).status).toBe(200)
    // HR has no allocation view permission, so cannot open the receipt.
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    expect((await a.get(docUrl)).status).toBe(403)
    expect((await a.upload(`/api/v1/uploads/documents?entityType=handover&entityId=${h.id}&purpose=handover`, { name: 'x.pdf', content: PDF }, { 'idempotency-key': randomUUID() })).status).toBe(403)

    // Either-method policy: pending handovers can later be confirmed on screen.
    await a.becomeAdmin()
    await a.ok('settings.update', { handoverAcknowledgment: 'in_app_or_signed' })
    const h2 = await a.ok('allocations.issue', issue([f.assets[1]!.id], { type: 'employee', id: f.asha.id }, { acknowledgment: null }))
    expect(h2.acknowledgmentStatus).toBe('pending')
    const ack = await a.ok('allocations.acknowledge', { handoverId: h2.id, acknowledgedByName: 'Asha Menon' })
    expect(ack).toMatchObject({ acknowledgmentStatus: 'acknowledged', acknowledgmentMethod: 'in_app', acknowledgedByName: 'Asha Menon' })
    expect(await a.call('allocations.acknowledge', { handoverId: h2.id, acknowledgedByName: 'Again' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })
})

describe('dashboard overdue-return metric (W-18)', () => {
  it('counts only active assignments past their expected return date, and is null without allocations.view', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: f.ravi.id }, { expectedReturnDate: '2020-01-01' })) // overdue
    await a.ok('allocations.issue', issue([f.assets[1]!.id], { type: 'employee', id: f.asha.id }, { expectedReturnDate: '2099-01-01' })) // not yet due
    await a.ok('allocations.issue', issue([f.assets[2]!.id], { type: 'employee', id: f.ravi.id })) // no expected return date at all

    const summary = await a.ok('dashboard.getSummary')
    expect(summary.allocations).toEqual({ active: 3, overdueReturns: 1 })

    // Filter list matches the metric: exactly the one overdue assignment.
    const overdueList = await a.ok('allocations.list', { status: 'all', overdueOnly: true, page: 1, pageSize: 50 })
    expect(overdueList.items).toHaveLength(1)
    expect(overdueList.items[0]!.assetId).toBe(f.assets[0]!.id)

    await a.becomeNewUser('noalloc', ['employee'])
    expect((await a.ok('dashboard.getSummary')).allocations).toBeNull()
  })
})
