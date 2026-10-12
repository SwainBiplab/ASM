import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('exit clearance', () => {
  it('tracks every outstanding asset, blocks closure until resolved, and keeps history', async () => {
    const a = await session()
    const f = await w4Setup(a, 4)
    const [laptop, headset, phone, other] = f.assets
    await a.ok('allocations.issue', issue([laptop!.id, headset!.id, phone!.id], { type: 'employee', id: f.ravi.id }))
    await a.ok('allocations.issue', issue([other!.id], { type: 'employee', id: f.asha.id }))

    // Marking the employee as exited never returns their assets.
    await a.ok('employees.deactivate', { id: f.ravi.id, actualExitDate: '2026-10-10', reason: 'Resigned' })
    expect(await count(a, "SELECT count(*) AS n FROM asset_assignments WHERE employee_id = $1 AND status = 'active'", [f.ravi.id])).toBe(3)

    const x = await a.ok('exitClearance.open', { employeeId: f.ravi.id, exitDate: '2026-10-10', ownerUserId: null, notes: 'Last day Friday' })
    expect(x).toMatchObject({ clearanceNumber: 'EXC-000001', status: 'open', itemCount: 3, unresolvedCount: 3, ownerName: expect.any(String) })
    expect(x.items.map((i) => i.assetCode).sort()).toEqual([laptop!.assetCode, headset!.assetCode, phone!.assetCode].sort())
    expect(x.blockers).toHaveLength(3)
    expect(await a.call('exitClearance.open', { employeeId: f.ravi.id, exitDate: '2026-10-10', ownerUserId: null, notes: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    const item = (assetId: string, d = x) => d.items.find((i) => i.assetId === assetId)!
    // Returned in good condition.
    let d = await a.ok('exitClearance.recordReturn', { itemId: item(laptop!.id).id, condition: 'good', outcome: 'awaiting_inspection', returnLocationId: f.store.id, notes: null })
    expect(item(laptop!.id, d)).toMatchObject({ resolution: 'returned', receivedCondition: 'good', returnHandoverId: expect.any(String) })
    // Returned damaged: needs an exception decision.
    d = await a.ok('exitClearance.recordReturn', { itemId: item(headset!.id).id, condition: 'damaged', outcome: 'non_operational', returnLocationId: null, notes: 'Broken mic' })
    expect(item(headset!.id, d).resolution).toBe('damaged')
    // Missing: flagged with a reason; the assignment is NOT closed silently.
    d = await a.ok('exitClearance.flagItem', { itemId: item(phone!.id).id, resolution: 'missing', reason: 'Employee says it was lost in transit' })
    expect(item(phone!.id, d)).toMatchObject({ resolution: 'missing', exceptionReason: 'Employee says it was lost in transit' })
    expect(await count(a, "SELECT count(*) AS n FROM asset_assignments WHERE asset_id = $1 AND status = 'active'", [phone!.id])).toBe(1)
    // Evidence attached to the item (photo of the damage).
    const up = await a.upload(`/api/v1/uploads/documents?entityType=clearance_item&entityId=${item(headset!.id).id}&purpose=photo`, { name: 'damage.png', content: PNG }, { 'idempotency-key': randomUUID() })
    expect(up.status).toBe(200)

    // Closure is refused while items are unresolved.
    expect(await a.call('exitClearance.close', { clearanceId: x.id, closingNotes: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect((await a.ok('exitClearance.get', { clearanceId: x.id })).blockers).toHaveLength(2)

    // Asset manager can record items but cannot approve exceptions or close.
    await a.becomeNewUser('assetmgr', ['asset_manager'])
    expect(await a.call('exitClearance.approveException', { itemId: item(phone!.id).id, decisionNotes: 'ok' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('exitClearance.close', { clearanceId: x.id, closingNotes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    // Authorized decisions: the missing phone is written off through the explicit loss process.
    await a.becomeAdmin()
    d = await a.ok('exitClearance.approveException', { itemId: item(headset!.id).id, decisionNotes: 'Normal wear; no recovery' })
    d = await a.ok('exitClearance.approveException', { itemId: item(phone!.id).id, decisionNotes: 'Written off per HR policy 4.2' })
    expect(item(phone!.id, d)).toMatchObject({ resolution: 'exception_approved', decisionNotes: 'Written off per HR policy 4.2', reviewedByName: expect.any(String) })
    const phoneCustody = await a.ok('allocations.custody', { assetId: phone!.id })
    expect(phoneCustody).toMatchObject({ lifecycleStatus: 'lost' })
    expect(phoneCustody.assignments[0]).toMatchObject({ status: 'lost', endReason: expect.stringContaining('EXC-000001') })
    expect(item(headset!.id, d).documents).toHaveLength(1)

    const closed = await a.ok('exitClearance.close', { clearanceId: x.id, closingNotes: 'Cleared with exceptions' })
    expect(closed).toMatchObject({ status: 'closed', closureType: 'with_exceptions', unresolvedCount: 0, blockers: [] })
    expect(await a.call('exitClearance.flagItem', { itemId: item(laptop!.id).id, resolution: 'missing', reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    // History is preserved: every assignment of the employee is still on record, and the audit trail is complete.
    expect(await count(a, 'SELECT count(*) AS n FROM asset_assignments WHERE employee_id = $1', [f.ravi.id])).toBe(3)
    const events = (await a.sql<{ e: string }>("SELECT event_type AS e FROM audit_events WHERE entity_type = 'exit_clearance' ORDER BY seq")).map((r) => r.e)
    expect(events).toEqual(['exit_clearance.opened', 'exit_clearance.item_returned', 'exit_clearance.item_returned', 'exit_clearance.item_flagged', 'exit_clearance.exception_approved', 'exit_clearance.exception_approved', 'exit_clearance.closed'])
  })

  it('blocks new issues during clearance and resolves items returned through the normal return screen', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const [one, two, three] = f.assets
    await a.ok('allocations.issue', issue([one!.id, two!.id], { type: 'employee', id: f.asha.id }))
    const x = await a.ok('exitClearance.open', { employeeId: f.asha.id, exitDate: '2026-11-30', ownerUserId: null, notes: null })
    // An employee under clearance receives no new assets, and clearance items are not transferred away.
    expect(await a.call('allocations.issue', issue([three!.id], { type: 'employee', id: f.asha.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await a.call('allocations.transfer', { target: { type: 'pool', id: f.pool.id }, lines: [{ assetId: one!.id, condition: 'good', accessories: null }], locationId: null, expectedReturnDate: null, reason: 'x', acknowledgment: { acknowledgedByName: 'x' } })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    // A plain return still resolves the clearance item, in the same transaction.
    await a.ok('allocations.return', { lines: [{ assetId: one!.id, condition: 'good', outcome: 'awaiting_inspection', accessoriesReturned: 'Charger', notes: null }], returnLocationId: null, notes: null })
    await a.ok('allocations.return', { lines: [{ assetId: two!.id, condition: 'good', outcome: 'awaiting_inspection', accessoriesReturned: null, notes: null }], returnLocationId: null, notes: null })
    const d = await a.ok('exitClearance.get', { clearanceId: x.id })
    expect(d.items.map((i) => i.resolution)).toEqual(['returned', 'returned'])
    // Retried closure with the same key does not close twice; a new key gets a clear conflict.
    const key = randomUUID()
    const c1 = await rpcWithKey(a, 'exitClearance.close', { clearanceId: x.id, closingNotes: null }, key)
    const c2 = await rpcWithKey(a, 'exitClearance.close', { clearanceId: x.id, closingNotes: null }, key)
    expect(c1.status).toBe(200)
    expect(c2.body).toEqual(c1.body)
    expect((await rpcWithKey(a, 'exitClearance.close', { clearanceId: x.id, closingNotes: null }, randomUUID())).body.error?.code).toBe('STATE_CONFLICT')
    expect(await count(a, "SELECT count(*) AS n FROM audit_events WHERE event_type = 'exit_clearance.closed'")).toBe(1)
    expect((await a.ok('exitClearance.get', { clearanceId: x.id })).closureType).toBe('cleared')
  })

  it('gives HR the clearance status without IT, custody or financial detail', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.sql("UPDATE assets SET acquisition_cost_minor = 5499950 WHERE id = $1", [f.assets[0]!.id])
    await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: f.ravi.id }))
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    const x = await a.ok('exitClearance.open', { employeeId: f.ravi.id, exitDate: '2026-12-01', ownerUserId: null, notes: null })
    expect(x.unresolvedCount).toBe(1)
    expect(JSON.stringify(x)).not.toMatch(/5499950|cost/i)
    expect((await a.ok('exitClearance.list', {})).total).toBe(1)
    // HR cannot record returns (IT receives assets), approve exceptions, or open custody details.
    expect(await a.call('exitClearance.recordReturn', { itemId: x.items[0]!.id, condition: 'good', outcome: 'awaiting_inspection', returnLocationId: null, notes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('exitClearance.approveException', { itemId: x.items[0]!.id, decisionNotes: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('allocations.custody', { assetId: f.assets[0]!.id })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    // HR can flag a dispute with a reason.
    const d = await a.ok('exitClearance.flagItem', { itemId: x.items[0]!.id, resolution: 'disputed', reason: 'Employee says laptop was handed to team lead' })
    expect(d.items[0]!.resolution).toBe('disputed')
    // An auditor sees clearances read-only.
    await a.becomeNewUser('auditor1', ['auditor'])
    expect((await a.ok('exitClearance.get', { clearanceId: x.id })).items).toHaveLength(1)
    expect(await a.call('exitClearance.flagItem', { itemId: x.items[0]!.id, resolution: 'missing', reason: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})
