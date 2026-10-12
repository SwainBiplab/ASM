import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreateTicketInput } from '../../src/shared/maintenanceSchemas'
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

const createInput = (assetId: string, extra: Partial<CreateTicketInput> = {}): CreateTicketInput => ({
  assetId, category: 'hardware', priority: 'high', description: 'Screen flickers intermittently',
  targetResolutionDate: null, assignedTechnicianId: null, vendorName: null, vendorReference: null, forceAdditional: false, justification: null, ...extra
})

describe('creating a ticket', () => {
  it('flags the asset under maintenance, records the first event, and blocks a second ticket', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const [one] = f.assets
    const t = await a.ok('maintenance.create', createInput(one!.id))
    expect(t).toMatchObject({ ticketNumber: 'MT-000001', status: 'open', assetCode: one!.assetCode, priority: 'high', faultCategory: 'hardware' })
    expect(t.events).toHaveLength(1)
    expect(t.events[0]).toMatchObject({ eventType: 'created' })
    const [row] = await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [one!.id])
    expect(row!.s).toBe('under_maintenance')

    // A second, accidental ticket for the same asset is refused with a clear message.
    expect(await a.call('maintenance.create', createInput(one!.id))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('MT-000001') } })
    expect(await count(a, "SELECT count(*) AS n FROM maintenance_tickets WHERE asset_id = $1", [one!.id])).toBe(1)

    // A justified second ticket, with the elevated permission, is allowed and does not touch the first.
    const t2 = await a.ok('maintenance.create', createInput(one!.id, { forceAdditional: true, justification: 'Separate, unrelated keyboard fault reported by a different user' }))
    expect(t2.ticketNumber).not.toBe(t.ticketNumber)
    expect(await count(a, "SELECT count(*) AS n FROM maintenance_tickets WHERE asset_id = $1 AND status = 'open'", [one!.id])).toBe(2)

    // Creating a ticket for a disposed/retired/non-active asset is refused.
    await a.ok('assets.changeLifecycle', { id: f.assets[1]!.id, toStatus: 'retired', reason: 'eol', effectiveDate: '2026-10-11', disposalMethod: null, disposalProceeds: null } as never)
    expect(await a.call('maintenance.create', createInput(f.assets[1]!.id))).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })

  it('lets at most one of several simultaneous HTTP create requests for the same asset open a normal ticket', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const results = await Promise.all(Array.from({ length: 5 }, () => rpcWithKey(a, 'maintenance.create', createInput(f.assets[0]!.id), randomUUID())))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    for (const r of results.filter((x) => x.status !== 200)) expect(r.body.error?.code).toBe('STATE_CONFLICT')
    expect(await count(a, "SELECT count(*) AS n FROM maintenance_tickets WHERE asset_id = $1 AND status = 'open'", [f.assets[0]!.id])).toBe(1)
  })

  it('creates the ticket already in progress when a technician is assigned at creation', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const [admin] = await a.sql<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id, { assignedTechnicianId: admin!.id }))
    expect(t.status).toBe('in_progress')
    expect(t.events.map((e) => e.eventType)).toEqual(['created', 'assigned'])
  })

  it('requires a justification when forcing an additional ticket, and the permission to do so', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    expect(await a.call('maintenance.create', createInput(f.assets[0]!.id, { forceAdditional: true }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { justification: expect.any(String) } } })
    await a.becomeNewUser('itperson', ['it_technician'])
    expect(await a.call('maintenance.create', createInput(f.assets[0]!.id, { forceAdditional: true, justification: 'Second unrelated fault' }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('refuses to assign a technician at creation without technician-assignment authority, and rejects a non-technician assignee', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const [admin] = await a.sql<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')
    // An HR officer is an active user but holds no maintenance permission at all.
    await a.becomeAdmin()
    const hr = await a.ok('users.create', { username: 'hrassignee', displayName: 'HR Assignee', password: 'Test-Password-1', roleKeys: ['hr_officer'] })

    await a.becomeNewUser('employee1', ['employee'])
    // maintenance.create alone must not grant the effect of maintenance.assign (self-reported faults cannot be routed to a chosen technician).
    expect(await a.call('maintenance.create', createInput(f.assets[0]!.id, { assignedTechnicianId: admin!.id }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', fieldErrors: { assignedTechnicianId: expect.any(String) } } })
    expect(await count(a, 'SELECT count(*) AS n FROM maintenance_tickets')).toBe(0)
    // Without a technician, the same report succeeds and stays open (no privilege needed).
    expect((await a.ok('maintenance.create', createInput(f.assets[0]!.id))).status).toBe('open')

    await a.becomeAdmin()
    // Even with maintenance.assign, the chosen assignee must actually hold a maintenance permission.
    expect(await a.call('maintenance.create', createInput(f.assets[1]!.id, { assignedTechnicianId: hr.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { assignedTechnicianId: expect.any(String) } } })
    const t2 = await a.ok('maintenance.create', createInput(f.assets[1]!.id))
    expect(await a.call('maintenance.assign', { ticketId: t2.id, assignedTechnicianId: hr.id, notes: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { assignedTechnicianId: expect.any(String) } } })
    const assigned = await a.ok('maintenance.assign', { ticketId: t2.id, assignedTechnicianId: admin!.id, notes: null })
    expect(assigned.status).toBe('in_progress')
  })
})

describe('transaction rollback', () => {
  it('leaves no partial ticket, event or asset-status change when a mid-transaction step fails', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.sql(`CREATE FUNCTION fail_ticket_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
    await a.sql('CREATE TRIGGER fail_ticket_event BEFORE INSERT ON maintenance_ticket_events FOR EACH ROW EXECUTE FUNCTION fail_ticket_event()')
    const failed = await a.call('maintenance.create', createInput(f.assets[0]!.id))
    expect(failed).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } })
    expect(await count(a, 'SELECT count(*) AS n FROM maintenance_tickets')).toBe(0)
    expect(await count(a, 'SELECT count(*) AS n FROM maintenance_ticket_events')).toBe(0)
    expect(await count(a, "SELECT count(*) AS n FROM audit_events WHERE event_type = 'maintenance.ticket_created'")).toBe(0)
    const [row] = await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [f.assets[0]!.id])
    expect(row!.s).toBe('ready')
    await a.sql('DROP TRIGGER fail_ticket_event ON maintenance_ticket_events')
    expect((await a.ok('maintenance.create', createInput(f.assets[0]!.id))).status).toBe('open')
  })
})

describe('idempotent retries', () => {
  it('replays create, resolve and close retries; a reused key with a different body is rejected', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const key = randomUUID()
    const first = await rpcWithKey(a, 'maintenance.create', createInput(f.assets[0]!.id), key)
    const retry = await rpcWithKey(a, 'maintenance.create', createInput(f.assets[0]!.id), key)
    expect(retry.body.data?.id).toBe(first.body.data?.id)
    const conflicting = await rpcWithKey(a, 'maintenance.create', createInput(f.assets[1]!.id), key)
    expect(conflicting.status).toBe(409)
    expect(await count(a, 'SELECT count(*) AS n FROM maintenance_tickets')).toBe(1)

    const ticketId = (first.body.data as { id: string }).id
    const resolveKey = randomUUID()
    const r1 = await rpcWithKey(a, 'maintenance.resolve', { ticketId, diagnosis: 'Loose cable', workPerformed: 'Reseated the display cable', downtimeMinutes: 30, notes: null }, resolveKey)
    const r2 = await rpcWithKey(a, 'maintenance.resolve', { ticketId, diagnosis: 'Loose cable', workPerformed: 'Reseated the display cable', downtimeMinutes: 30, notes: null }, resolveKey)
    expect(r2.body.data?.id).toBe(r1.body.data?.id)
    expect(await count(a, "SELECT count(*) AS n FROM maintenance_ticket_events WHERE ticket_id = $1 AND event_type = 'resolved'", [ticketId])).toBe(1)

    const closeKey = randomUUID()
    const c1 = await rpcWithKey(a, 'maintenance.close', { ticketId, resultOutcome: 'awaiting_inspection', closingNotes: 'Done' }, closeKey)
    const c2 = await rpcWithKey(a, 'maintenance.close', { ticketId, resultOutcome: 'awaiting_inspection', closingNotes: 'Done' }, closeKey)
    expect(c2.body.data?.id).toBe(c1.body.data?.id)
    expect(await count(a, "SELECT count(*) AS n FROM maintenance_ticket_events WHERE ticket_id = $1 AND event_type = 'closed'", [ticketId])).toBe(1)
    // A new key cannot close the already-closed ticket again.
    expect((await rpcWithKey(a, 'maintenance.close', { ticketId, resultOutcome: 'ready', closingNotes: 'x' }, randomUUID())).body.error?.code).toBe('STATE_CONFLICT')
  })
})

describe('assignment, updates and cost visibility', () => {
  it('assigns a technician, records diagnosis/work/cost, and gates cost on the finance permission', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    expect(await a.call('maintenance.assign', { ticketId: t.id, assignedTechnicianId: randomUUID(), notes: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const [admin] = await a.sql<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')
    const assigned = await a.ok('maintenance.assign', { ticketId: t.id, assignedTechnicianId: admin!.id, notes: 'Please take a look' })
    expect(assigned.status).toBe('in_progress')
    expect(assigned.assignedTechnicianName).toBeTruthy()

    const full = { ticketId: t.id, priority: 'high', description: t.description, diagnosis: 'Backlight failure', workPerformed: null, vendorName: null, vendorReference: null, downtimeMinutes: 120, targetResolutionDate: null, notes: 'Parts ordered' }
    const updated = await a.ok('maintenance.update', { ...full, partsCost: '1500.00', laborCost: '500.00' } as never)
    expect(updated).toMatchObject({ costVisible: true, partsCostMinor: 150000, laborCostMinor: 50000, diagnosis: 'Backlight failure' })

    await a.becomeNewUser('itperson', ['it_technician'])
    const viaTech = await a.ok('maintenance.get', { ticketId: t.id })
    expect(viaTech).toMatchObject({ costVisible: false, partsCostMinor: null, laborCostMinor: null })
    // A non-finance viewer cannot set a cost, but their update (with no cost given) leaves the existing cost untouched.
    expect(await a.call('maintenance.update', { ...full, partsCost: '1.00', laborCost: null } as never)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    const noncost = await a.ok('maintenance.update', { ...full, workPerformed: 'Replaced the backlight panel', partsCost: null, laborCost: null } as never)
    expect(noncost.workPerformed).toBe('Replaced the backlight panel')
    await a.becomeAdmin()
    expect((await a.ok('maintenance.get', { ticketId: t.id })).partsCostMinor).toBe(150000)
  })

  it('attaches repair evidence under document permissions', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    const up = await a.upload(`/api/v1/uploads/documents?entityType=maintenance_ticket&entityId=${t.id}&purpose=repair_evidence`, { name: 'before.png', content: PNG }, { 'idempotency-key': randomUUID() })
    expect(up.status).toBe(200)
    const after = await a.ok('maintenance.get', { ticketId: t.id })
    expect(after.documents).toHaveLength(1)
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    expect((await a.get(`/api/v1/documents/${after.documents[0]!.documentId}/content`)).status).toBe(403)
  })
})

describe('closing and returning to service', () => {
  it('requires resolution before closing, never makes the asset ready by itself, and gates "ready" on inspection authority', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    expect(await a.call('maintenance.close', { ticketId: t.id, resultOutcome: 'ready', closingNotes: 'done' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    await a.ok('maintenance.resolve', { ticketId: t.id, diagnosis: 'Cable fault', workPerformed: 'Replaced cable', downtimeMinutes: 45, notes: null })

    // Closing with "awaiting_inspection" does not release the asset to ready.
    const closed = await a.ok('maintenance.close', { ticketId: t.id, resultOutcome: 'awaiting_inspection', closingNotes: 'Repaired; needs QA check' })
    expect(closed.status).toBe('closed')
    expect((await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [f.assets[0]!.id]))[0]!.s).toBe('awaiting_inspection')

    // A second ticket, closed directly as ready, requires the allocations.inspect permission too.
    const t2 = await a.ok('maintenance.create', createInput(f.assets[0]!.id, { forceAdditional: true, justification: 'Follow-up QA ticket' }))
    await a.ok('maintenance.resolve', { ticketId: t2.id, diagnosis: 'n/a', workPerformed: 'Verified repaired unit', downtimeMinutes: 0, notes: null })
    await a.becomeNewUser('facilities1', ['facilities_manager'])
    expect(await a.call('maintenance.close', { ticketId: t2.id, resultOutcome: 'ready', closingNotes: 'QA passed' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.becomeAdmin()
    const closed2 = await a.ok('maintenance.close', { ticketId: t2.id, resultOutcome: 'ready', closingNotes: 'QA passed' })
    expect(closed2.status).toBe('closed')
    expect((await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [f.assets[0]!.id]))[0]!.s).toBe('ready')
  })

  it('cancels a duplicate ticket without changing asset state, and never overwrites earlier events', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    const t2 = await a.ok('maintenance.create', createInput(f.assets[0]!.id, { forceAdditional: true, justification: 'Accidentally duplicated report' }))
    const cancelled = await a.ok('maintenance.cancel', { ticketId: t2.id, reason: 'Duplicate of MT-000001' })
    expect(cancelled.status).toBe('cancelled')
    expect((await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [f.assets[0]!.id]))[0]!.s).toBe('under_maintenance')
    expect(await a.call('maintenance.cancel', { ticketId: t2.id, reason: 'again' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    const first = await a.ok('maintenance.get', { ticketId: t.id })
    expect(first.events.map((e) => e.eventType)).toEqual(['created'])
  })
})

describe('inspection-to-maintenance link', () => {
  it('lets an authorized user open a ticket after a return inspection finds a fault, preserving history', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.ok('allocations.issue', issue([f.assets[0]!.id], { type: 'employee', id: f.ravi.id }))
    await a.ok('allocations.return', { lines: [{ assetId: f.assets[0]!.id, condition: 'damaged', outcome: 'non_operational', accessoriesReturned: null, notes: 'Screen cracked on return' }], returnLocationId: null, notes: null })
    expect((await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [f.assets[0]!.id]))[0]!.s).toBe('non_operational')
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id, { category: 'cosmetic', description: 'Screen cracked, found on return inspection' }))
    expect(t.status).toBe('open')
    const custody = await a.ok('allocations.custody', { assetId: f.assets[0]!.id })
    expect(custody.movements.map((m) => m.movementType)).toContain('returned')
    expect((await a.sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [f.assets[0]!.id]))[0]!.s).toBe('under_maintenance')
  })
})

describe('permissions and organization isolation', () => {
  it('denies maintenance operations to roles without the permission', async () => {
    const a = await session()
    const f = await w4Setup(a, 2)
    const t = await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    await a.becomeNewUser('hrofficer', ['hr_officer'])
    expect(await a.call('maintenance.create', createInput(f.assets[0]!.id, { forceAdditional: true, justification: 'x' }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('maintenance.list', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('maintenance.get', { ticketId: t.id })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await a.call('maintenance.resolve', { ticketId: t.id, diagnosis: 'x', workPerformed: 'x', downtimeMinutes: null, notes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.becomeNewUser('employee1', ['employee'])
    // The "employee" role may report a fault (maintenance.create) on a fresh asset, but has no general view access.
    expect((await a.ok('maintenance.create', createInput(f.assets[1]!.id))).status).toBe('open')
    expect(await a.call('maintenance.list', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('never lets one organization see or act on another organization\'s tickets', async () => {
    const a = await session()
    const f = await w4Setup(a, 1)
    await a.ok('maintenance.create', createInput(f.assets[0]!.id))
    const other = await bootstrapOrganization(a.s.tdb.db, { organization: { ...SETUP.organization, legalName: 'Other BPO', displayName: 'Other' }, admin: { username: 'otheradmin', displayName: 'Other Admin', password: 'Other-Admin-Pass-1' } }, newCorrelationId(), { allowAdditional: true })
    const o = other.organizationId
    const [cat] = await a.sql<{ id: string }>("INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, asset_domain) VALUES (gen_random_uuid(), $1, 'X', 'x', 'X', 'x', 'it') RETURNING id", [o])
    const [foreignAsset] = await a.sql<{ id: string }>("INSERT INTO assets (id, organization_id, asset_code, category_id) VALUES (gen_random_uuid(), $1, 'AST-000001', $2) RETURNING id", [o, cat!.id])
    const [foreignUser] = await a.sql<{ id: string }>('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [o])
    const [foreignTicket] = await a.sql<{ id: string }>(
      "INSERT INTO maintenance_tickets (id, organization_id, ticket_number, asset_id, fault_category, priority, description, reported_by) VALUES (gen_random_uuid(), $1, 'MT-999999', $2, 'hardware', 'low', 'x', $3) RETURNING id",
      [o, foreignAsset!.id, foreignUser!.id]
    )
    // Organization A cannot see or act on organization B's ticket or asset.
    expect(await a.call('maintenance.get', { ticketId: foreignTicket!.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await a.call('maintenance.create', createInput(foreignAsset!.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await a.call('maintenance.resolve', { ticketId: foreignTicket!.id, diagnosis: 'x', workPerformed: 'x', downtimeMinutes: null, notes: null })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect((await a.ok('maintenance.list', { status: 'all' })).total).toBe(1)
  })
})
