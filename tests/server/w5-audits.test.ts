import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreateAuditInput } from '../../src/shared/auditSchemas'
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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const byAssets = (assetIds: string[], extra: Partial<CreateAuditInput> = {}): CreateAuditInput => ({
  title: 'Q4 spot check', scope: { locationId: null, categoryId: null, custodianEmployeeId: null, assetIds }, responsibleUserId: null, notes: null, ...extra
})

describe('creating an audit and freezing the baseline', () => {
  it('snapshots every expected asset and keeps the baseline stable after later master-data edits', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const [one, two, three] = f.assets
    await a.sql('UPDATE assets SET location_id = $2, condition = $3 WHERE id = $1', [one!.id, f.floor.id, 'good'])
    const x = await a.ok('audits.create', byAssets([one!.id, two!.id, three!.id]))
    expect(x).toMatchObject({ auditNumber: 'AUD-000001', status: 'open', itemCount: 3, verifiedCount: 0, unresolvedCount: 3 })
    const items = await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 50 })
    const item1 = items.items.find((i) => i.assetId === one!.id)!
    expect(item1).toMatchObject({ source: 'expected', status: 'pending', expectedCondition: 'good' })
    expect(item1.expectedLocationPath).toContain('Floor 3')

    // Editing the asset AFTER the audit opened must not retroactively change the frozen baseline.
    await a.sql('UPDATE assets SET location_id = $2, condition = $3 WHERE id = $1', [one!.id, f.store.id, 'damaged'])
    const stillFrozen = (await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 50 })).items.find((i) => i.assetId === one!.id)!
    expect(stillFrozen).toMatchObject({ expectedCondition: 'good' })
    expect(stillFrozen.expectedLocationPath).toContain('Floor 3')
  })

  it('builds the scope from criteria (location, including sub-locations) and from a custodian', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    await a.sql('UPDATE assets SET location_id = $2 WHERE id = $1', [f.assets[0]!.id, f.floor.id])
    const byLocation = await a.ok('audits.create', { title: 'Floor sweep', scope: { locationId: f.site.id, categoryId: null, custodianEmployeeId: null, assetIds: null }, responsibleUserId: null, notes: null })
    expect(byLocation.itemCount).toBe(1)

    await a.ok('allocations.issue', { target: { type: 'employee', id: f.ravi.id }, lines: [{ assetId: f.assets[1]!.id, condition: 'good', accessories: null }], locationId: null, expectedReturnDate: null, notes: null, acknowledgment: { acknowledgedByName: 'x' } })
    const byCustodian = await a.ok('audits.create', { title: 'Ravi custody check', scope: { locationId: null, categoryId: null, custodianEmployeeId: f.ravi.id, assetIds: null }, responsibleUserId: null, notes: null })
    expect(byCustodian.itemCount).toBe(1)

    expect(await a.call('audits.create', { title: 'No scope', scope: { locationId: null, categoryId: null, custodianEmployeeId: null, assetIds: null }, responsibleUserId: null, notes: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })
})

describe('transaction rollback', () => {
  it('leaves no partial audit or item snapshot when a mid-transaction step fails', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    await a.sql(`CREATE FUNCTION fail_audit_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
    await a.sql('CREATE TRIGGER fail_audit_item BEFORE INSERT ON audit_items FOR EACH ROW EXECUTE FUNCTION fail_audit_item()')
    const failed = await a.call('audits.create', byAssets([f.assets[0]!.id, f.assets[1]!.id]))
    expect(failed).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } })
    expect(await count(a, 'SELECT count(*) AS n FROM physical_audits')).toBe(0)
    expect(await count(a, 'SELECT count(*) AS n FROM audit_items')).toBe(0)
    expect(await count(a, "SELECT count(*) AS n FROM audit_events WHERE event_type = 'physical_audit.opened'")).toBe(0)
    await a.sql('DROP TRIGGER fail_audit_item ON audit_items')
    expect((await a.ok('audits.create', byAssets([f.assets[0]!.id]))).itemCount).toBe(1)
  })
})

describe('scanning and discrepancy classification', () => {
  it('verifies a matching scan, and classifies location, condition and unexpected-find discrepancies', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const [matching, moved, damaged] = f.assets
    const notInScope = (await a.ok('assets.create', { categoryId: f.category.id, modelId: null, manufacturer: null, modelName: null, serialNumber: null, specifications: null, condition: 'good', operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null }))
    const x = await a.ok('audits.create', byAssets([matching!.id, moved!.id, damaged!.id]))

    const v1 = await a.ok('audits.verifyItem', { auditId: x.id, assetId: matching!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })
    expect(v1).toMatchObject({ status: 'verified', discrepancyType: null })

    const v2 = await a.ok('audits.verifyItem', { auditId: x.id, assetId: moved!.id, observedLocationId: f.store.id, observedCondition: 'good', identificationMismatch: false, notes: 'Found in IT store' })
    expect(v2).toMatchObject({ status: 'discrepancy_open', discrepancyType: 'location_mismatch' })
    expect(v2.observedLocationPath).toContain('IT Store')

    const v3 = await a.ok('audits.verifyItem', { auditId: x.id, assetId: damaged!.id, observedLocationId: null, observedCondition: 'damaged', identificationMismatch: false, notes: 'Cracked case' })
    expect(v3).toMatchObject({ status: 'discrepancy_open', discrepancyType: 'condition_mismatch' })

    const v4 = await a.ok('audits.verifyItem', { auditId: x.id, assetId: notInScope.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: 'Found during the walk, not on the list' })
    expect(v4).toMatchObject({ source: 'unexpected', status: 'discrepancy_open', discrepancyType: 'unexpected' })

    const summary = await a.ok('audits.get', { auditId: x.id })
    expect(summary).toMatchObject({ itemCount: 4, verifiedCount: 1, unresolvedCount: 3 })

    // Re-scanning an item that already has an open discrepancy must go through resolution, not another scan.
    expect(await a.call('audits.verifyItem', { auditId: x.id, assetId: moved!.id, observedLocationId: f.store.id, observedCondition: 'good', identificationMismatch: false, notes: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })

  it('lets exactly one of several simultaneous scans of the same asset settle the item (no duplicate rows)', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const x = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    const results = await Promise.all(
      Array.from({ length: 5 }, () => rpcWithKey(a, 'audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null }, randomUUID()))
    )
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1)
    expect(await count(a, 'SELECT count(*) AS n FROM audit_items WHERE audit_id = $1 AND asset_id = $2', [x.id, f.assets[0]!.id])).toBe(1)
  })

  it('flags a never-found expected item as missing, never automatically', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const x = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    const [item] = (await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 10 })).items
    const flagged = await a.ok('audits.flagMissing', { itemId: item!.id, notes: 'Not found in the storeroom' })
    expect(flagged).toMatchObject({ status: 'discrepancy_open', discrepancyType: 'missing', observedAt: null })
    // The asset itself is not touched (never auto-lost or auto-disposed).
    const [row] = await a.sql<{ status: string }>('SELECT lifecycle_status AS status FROM assets WHERE id = $1', [f.assets[0]!.id])
    expect(row!.status).toBe('active')
    expect(await a.call('audits.flagMissing', { itemId: item!.id, notes: 'again' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })
})

describe('investigation and resolution', () => {
  it('assigns, resolves generically, corrects a location discrepancy, and accepts a formal exception', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const [locMismatch, condMismatch, missingOne] = f.assets
    const x = await a.ok('audits.create', byAssets([locMismatch!.id, condMismatch!.id, missingOne!.id]))
    await a.ok('audits.verifyItem', { auditId: x.id, assetId: locMismatch!.id, observedLocationId: f.store.id, observedCondition: 'good', identificationMismatch: false, notes: null })
    await a.ok('audits.verifyItem', { auditId: x.id, assetId: condMismatch!.id, observedLocationId: null, observedCondition: 'damaged', identificationMismatch: false, notes: null })
    const items = (await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 10 })).items
    const locItem = items.find((i) => i.assetId === locMismatch!.id)!
    const condItem = items.find((i) => i.assetId === condMismatch!.id)!
    const missingItem = items.find((i) => i.assetId === missingOne!.id)!

    const [reviewer] = await a.sql<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')
    const assigned = await a.ok('audits.assignDiscrepancy', { itemId: condItem.id, assignedToUserId: reviewer!.id, notes: 'Please check with IT' })
    expect(assigned.status).toBe('investigating')

    const resolved = await a.ok('audits.resolveDiscrepancy', { itemId: condItem.id, resolutionNotes: 'Confirmed damaged; maintenance ticket opened separately' })
    expect(resolved.status).toBe('resolved')

    // Correcting the location both updates the master asset record and resolves the discrepancy, linked.
    const corrected = await a.ok('audits.correctLocation', { itemId: locItem.id, newLocationId: f.store.id, reason: 'Physically relocated to IT store without updating the record' })
    expect(corrected.status).toBe('resolved')
    const [assetRow] = await a.sql<{ locationId: string }>('SELECT location_id AS "locationId" FROM assets WHERE id = $1', [locMismatch!.id])
    expect(assetRow!.locationId).toBe(f.store.id)
    const [correctionEvent] = await a.sql<{ s: { auditItemId: string; auditId: string } }>("SELECT summary AS s FROM audit_events WHERE event_type = 'asset.location_corrected'")
    expect(correctionEvent!.s).toMatchObject({ auditItemId: locItem.id, auditId: x.id })
    // correctLocation only applies to a location_mismatch discrepancy.
    expect(await a.call('audits.correctLocation', { itemId: missingItem.id, newLocationId: f.store.id, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    // Formal exception acceptance requires the closer-level permission, distinct from audits.resolve.
    await a.ok('audits.flagMissing', { itemId: missingItem.id, notes: 'Not located after two searches' })
    await a.becomeNewUser('assetmgr', ['asset_manager'])
    expect(await a.call('audits.acceptException', { itemId: missingItem.id, decisionNotes: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.becomeAdmin()
    const accepted = await a.ok('audits.acceptException', { itemId: missingItem.id, decisionNotes: 'Accepted pending a separate loss investigation' })
    expect(accepted.status).toBe('accepted')
    // Acceptance never silently marks the asset lost or disposed.
    const [stillActive] = await a.sql<{ status: string }>('SELECT lifecycle_status AS status FROM assets WHERE id = $1', [missingOne!.id])
    expect(stillActive!.status).toBe('active')
  })

  it('attaches discrepancy evidence under document permissions', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const x = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    const [item] = (await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 10 })).items
    await a.ok('audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'damaged', identificationMismatch: false, notes: null })
    const up = await a.upload(`/api/v1/uploads/documents?entityType=audit_item&entityId=${item!.id}&purpose=audit_evidence`, { name: 'damage.png', content: PNG }, { 'idempotency-key': randomUUID() })
    expect(up.status).toBe(200)
    const after = (await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 10 })).items[0]!
    expect(after.documents).toHaveLength(1)
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    expect((await a.get(`/api/v1/documents/${after.documents[0]!.documentId}/content`)).status).toBe(403)
  })
})

describe('closure', () => {
  it('blocks closure while items are unresolved, and reports exceptions after closing', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const x = await a.ok('audits.create', byAssets([f.assets[0]!.id, f.assets[1]!.id]))
    expect(await a.call('audits.close', { auditId: x.id, closingNotes: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect((await a.ok('audits.get', { auditId: x.id })).blockers).toHaveLength(1)

    await a.ok('audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })
    await a.ok('audits.verifyItem', { auditId: x.id, assetId: f.assets[1]!.id, observedLocationId: f.store.id, observedCondition: 'good', identificationMismatch: false, notes: null })
    const [item2] = (await a.ok('audits.getItems', { auditId: x.id, status: 'discrepancy_open', page: 1, pageSize: 10 })).items
    await a.ok('audits.acceptException', { itemId: item2!.id, decisionNotes: 'Accepted relocation without further action' })

    const closed = await a.ok('audits.close', { auditId: x.id, closingNotes: 'All accounted for' })
    expect(closed).toMatchObject({ status: 'closed', closureType: 'with_exceptions', unresolvedCount: 0, blockers: [] })
    expect(await a.call('audits.flagMissing', { itemId: item2!.id, notes: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    // A clean audit (nothing ever mismatched) closes as fully verified.
    const clean = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    await a.ok('audits.verifyItem', { auditId: clean.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })
    expect((await a.ok('audits.close', { auditId: clean.id, closingNotes: null })).closureType).toBe('fully_verified')
  })

  it('replays close retries idempotently, and supports cancelling an open audit', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const x = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    await a.ok('audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })
    const key = randomUUID()
    const c1 = await rpcWithKey(a, 'audits.close', { auditId: x.id, closingNotes: null }, key)
    const c2 = await rpcWithKey(a, 'audits.close', { auditId: x.id, closingNotes: null }, key)
    expect(c2.body).toEqual(c1.body)
    expect(await count(a, "SELECT count(*) AS n FROM audit_events WHERE event_type = 'physical_audit.closed'")).toBe(1)

    const toCancel = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    const cancelled = await a.ok('audits.cancel', { auditId: toCancel.id, reason: 'Opened in error' })
    expect(cancelled.status).toBe('cancelled')
    expect(await a.call('audits.close', { auditId: toCancel.id, closingNotes: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })
})

describe('permissions and organization isolation', () => {
  it('denies audit operations to roles without the permission, while a verifier can scan but not close', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const x = await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    expect(await a.call('audits.create', byAssets([f.assets[0]!.id]))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('audits.list', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    await a.becomeNewUser('itperson', ['it_technician'])
    const v = await a.ok('audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })
    expect(v.status).toBe('verified')
    expect(await a.call('audits.close', { auditId: x.id, closingNotes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('audits.create', byAssets([f.assets[0]!.id]))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    await a.becomeNewUser('auditor1', ['auditor'])
    expect((await a.ok('audits.get', { auditId: x.id })).id).toBe(x.id)
    expect(await a.call('audits.verifyItem', { auditId: x.id, assetId: f.assets[0]!.id, observedLocationId: null, observedCondition: 'good', identificationMismatch: false, notes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('never lets one organization see or act on another organization\'s audits', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.ok('audits.create', byAssets([f.assets[0]!.id]))
    const other = await bootstrapOrganization(a.s.tdb.db, { organization: { ...SETUP.organization, legalName: 'Other BPO', displayName: 'Other' }, admin: { username: 'otheradmin', displayName: 'Other Admin', password: 'Other-Admin-Pass-1' } }, newCorrelationId(), { allowAdditional: true })
    const o = other.organizationId
    const [cat] = await a.sql<{ id: string }>("INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, asset_domain) VALUES (gen_random_uuid(), $1, 'X', 'x', 'X', 'x', 'it') RETURNING id", [o])
    const [foreignAsset] = await a.sql<{ id: string }>("INSERT INTO assets (id, organization_id, asset_code, category_id) VALUES (gen_random_uuid(), $1, 'AST-000001', $2) RETURNING id", [o, cat!.id])
    expect(await a.call('audits.create', byAssets([foreignAsset!.id]))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect((await a.ok('audits.list', { status: 'all' })).total).toBe(1)
  })
})

describe('audit custodian scope (W-22): sweeps department/team equipment the custodian manages', () => {
  it('matches direct assignments plus anything held by a department they manage or a team they lead', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const manager = await a.ok('employees.create', { employeeCode: 'MGR2', fullName: 'Arjun Manager', email: null, phone: null, jobTitle: null, departmentId: null, teamId: null, managerEmployeeId: null, workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null })
    await a.ok('departments.update', { id: f.dept.id, code: f.dept.code, name: f.dept.name, managerEmployeeId: manager.id, notes: null })
    const team = await a.ok('teams.create', { departmentId: f.dept.id, kind: 'team', code: null, name: 'Backoffice', leadEmployeeId: manager.id, notes: null })

    await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: manager.id }))
    await a.ok('allocations.issue', issue([f.assets[1]!.id], { type: 'department', id: f.dept.id }))
    await a.ok('allocations.issue', issue([f.assets[2]!.id], { type: 'team', id: team.id }))

    const x = await a.ok('audits.create', { title: 'Manager custody check', scope: { locationId: null, categoryId: null, custodianEmployeeId: manager.id, assetIds: null }, responsibleUserId: null, notes: null })
    expect(x.itemCount).toBe(3)
    const items = await a.ok('audits.getItems', { auditId: x.id, status: 'all', page: 1, pageSize: 50 })
    expect(items.items.map((i) => i.assetId).sort()).toEqual([f.assets[0]!.id, f.assets[1]!.id, f.assets[2]!.id].sort())
  })
})
