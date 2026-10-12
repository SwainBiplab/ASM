import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { formatAssetCode } from '../../src/shared/assets'
import { createApiSession, type ApiSession } from './session-helpers'
import { w4Setup } from './w4-helpers'

/**
 * W9.2 server-side foundations: device enrollment/trust/revocation, exclusive PostgreSQL-backed
 * leases, and asset-code range reservations (TAS W9 §4/§8, DECISIONS.md D48/D49). These tests run
 * against a real ephemeral PostgreSQL database and, where concurrency matters, fire real concurrent
 * HTTP requests -- the partial unique index `one_active_lease_per_asset` is the actual guarantee
 * under test, not a mock. No synchronization protocol, local outbox or desktop agent exists yet:
 * these tests cover the *reservation* being safe, never a simulated offline sync.
 */

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})
const session = async () => {
  const a = await createApiSession()
  sessions.push(a)
  return a
}

describe('device enrollment and trust', () => {
  it('requires administrator attestation to approve a device, and blocks self-approval', async () => {
    const a = await session()
    const adminCookie = a.cookie
    await a.becomeNewUser('agent1', ['asset_manager'])
    const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Agent Laptop 1' })
    expect(device.status).toBe('pending')

    // devices.manage is admin-only: the device's own user cannot approve themselves.
    expect(await a.call('devices.approve', { deviceId: device.id, trustNotes: 'self-approved' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    const approveAsAdmin = await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'Verified BitLocker and asset tag APT-1 in person' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(approveAsAdmin.body).toMatchObject({ ok: true, data: { status: 'active', trustVerifiedByName: expect.any(String), trustNotes: expect.stringContaining('BitLocker') } })

    // Approving an already-active device is refused.
    const reApprove = await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'again' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(reApprove.body).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })

  it('revokes a device and force-reclaims its active lease, since there is no live connection to push a revoke signal to', async () => {
    const a = await session()
    const adminCookie = a.cookie
    const f = await w4Setup(a, 1)
    await a.becomeNewUser('agent2', ['asset_manager'])
    const agentCookie = a.cookie
    const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Agent Laptop 2' })
    await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'Verified in person' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })

    const lease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset', assetIds: [f.assets[0]!.id] }, durationHours: 4 })
    expect(lease.status).toBe('active')

    const revoked = await a.s.rpc('devices.revoke', { deviceId: device.id, reason: 'Laptop reported stolen' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(revoked.body).toMatchObject({ ok: true, data: { status: 'revoked' } })

    const [leaseRow] = await a.sql<{ status: string; reason: string }>('SELECT status, reclaim_reason AS reason FROM offline_leases WHERE id = $1', [lease.id])
    expect(leaseRow).toMatchObject({ status: 'reclaimed', reason: expect.stringContaining('Laptop reported stolen') })
    const [scopeRow] = await a.sql<{ active: boolean }>('SELECT is_active AS active FROM offline_lease_scopes WHERE lease_id = $1', [lease.id])
    expect(scopeRow!.active).toBe(false)

    // The asset is free online again now that the lease was reclaimed by the revocation.
    await a.s.rpc(
      'assets.changeLifecycle',
      { id: f.assets[0]!.id, toStatus: 'retired', reason: 'eol', effectiveDate: '2026-10-11', disposalMethod: null, disposalProceeds: null } as never,
      { cookie: agentCookie, headers: { 'idempotency-key': randomUUID() } }
    ).then((r) => expect(r.body).toMatchObject({ ok: true }))
  })
})

describe('requesting an exclusive asset lease', () => {
  it('lets only one of several concurrent requests for the same asset win, across different approved devices', async () => {
    const a = await session()
    const adminCookie = a.cookie
    const f = await w4Setup(a, 1)
    await a.becomeNewUser('agent3', ['asset_manager'])
    const agentCookie = a.cookie
    const devices = await Promise.all(Array.from({ length: 5 }, (_, i) => a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: `Race Device ${i}` })))
    for (const d of devices) {
      await a.s.rpc('devices.approve', { deviceId: d.id, trustNotes: 'Verified' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    }
    const results = await Promise.all(
      devices.map((d) =>
        a.s.rpc('leases.request', { deviceId: d.id, scope: { kind: 'asset', assetIds: [f.assets[0]!.id] }, durationHours: 4 }, { cookie: agentCookie, headers: { 'idempotency-key': randomUUID() } })
      )
    )
    const wins = results.filter((r) => r.body.ok)
    expect(wins).toHaveLength(1)
    for (const r of results.filter((x) => !x.body.ok)) expect((r.body as { error: { code: string } }).error.code).toBe('STATE_CONFLICT')
    const [count] = await a.sql<{ n: string }>("SELECT count(*) AS n FROM offline_lease_scopes WHERE asset_id = $1 AND is_active", [f.assets[0]!.id])
    expect(Number(count!.n)).toBe(1)
  })

  it('blocks every online mutation of a leased asset, including by the lease holder\'s own browser session', async () => {
    const a = await session()
    const adminCookie = a.cookie
    const f = await w4Setup(a, 1)
    await a.becomeNewUser('agent4', ['asset_manager'])
    const agentCookie = a.cookie
    const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Agent Laptop 4' })
    await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'Verified' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    const lease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset', assetIds: [f.assets[0]!.id] }, durationHours: 4 })

    const asAgent = () => a.s.rpc('assets.changeLifecycle', { id: f.assets[0]!.id, toStatus: 'retired', reason: 'eol', effectiveDate: '2026-10-11', disposalMethod: null, disposalProceeds: null } as never, { cookie: agentCookie, headers: { 'idempotency-key': randomUUID() } })
    const asAdmin = () => a.s.rpc('assets.changeLifecycle', { id: f.assets[0]!.id, toStatus: 'retired', reason: 'eol', effectiveDate: '2026-10-11', disposalMethod: null, disposalProceeds: null } as never, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })

    // Blocked for the lease holder themselves (would race their own not-yet-synced offline work)...
    expect((await asAgent()).body).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('offline lease') } })
    // ...and for any other online actor.
    expect((await asAdmin()).body).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    const released = await a.s.rpc('leases.release', { leaseId: lease.id }, { cookie: agentCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(released.body).toMatchObject({ ok: true, data: { status: 'released' } })

    // Now that the lease is released, the same online mutation succeeds.
    expect((await asAdmin()).body).toMatchObject({ ok: true })
  })

  it('lets only the lease holder (or a devices.manage admin) release it, and never lets the holder force-reclaim their own lease', async () => {
    const a = await session()
    const adminCookie = a.cookie
    const f = await w4Setup(a, 2)
    await a.becomeNewUser('agent5', ['asset_manager'])
    const agent5Cookie = a.cookie
    const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Agent Laptop 5' })
    await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'Verified' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    const lease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset', assetIds: [f.assets[0]!.id] }, durationHours: 4 })

    await a.becomeNewUser('agent6', ['asset_manager'])
    const agent6Cookie = a.cookie
    // A different ordinary user, holding leases.manage but not devices.manage, cannot release someone else's lease.
    const wrongUser = await a.s.rpc('leases.release', { leaseId: lease.id }, { cookie: agent6Cookie, headers: { 'idempotency-key': randomUUID() } })
    expect(wrongUser.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    // D49/E: a super_admin who is also the lease's own holder can never force-reclaim their own lease.
    await a.becomeNewUser('agent7', ['super_admin'])
    const agent7Cookie = a.cookie
    const device7 = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Agent Laptop 7' })
    await a.s.rpc('devices.approve', { deviceId: device7.id, trustNotes: 'Verified' }, { cookie: agent7Cookie, headers: { 'idempotency-key': randomUUID() } })
    const lease7 = await a.ok('leases.request', { deviceId: device7.id, scope: { kind: 'asset', assetIds: [f.assets[1]!.id] }, durationHours: 4 })
    const selfReclaim = await a.s.rpc('leases.forceReclaim', { leaseId: lease7.id, reason: 'trying to reclaim my own lease' }, { cookie: agent7Cookie, headers: { 'idempotency-key': randomUUID() } })
    expect(selfReclaim.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    // The original administrator, a distinct recovery authority, can force-reclaim it.
    const reclaimed = await a.s.rpc('leases.forceReclaim', { leaseId: lease7.id, reason: 'Agent 7 is on leave; asset urgently needed' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(reclaimed.body).toMatchObject({ ok: true, data: { status: 'reclaimed', reclaimReason: expect.stringContaining('urgently needed') } })

    // The original holder's own release still works on their own lease.
    const released = await a.s.rpc('leases.release', { leaseId: lease.id }, { cookie: agent5Cookie, headers: { 'idempotency-key': randomUUID() } })
    expect(released.body).toMatchObject({ ok: true, data: { status: 'released' } })
  })
})

describe('asset-code range reservation', () => {
  it('reserves a contiguous range that online issuance never reuses, and blocks a format change while it is outstanding', async () => {
    const a = await session()
    const adminCookie = a.cookie
    await a.becomeNewUser('agent8', ['asset_manager'])
    const agentCookie = a.cookie
    const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Agent Laptop 8' })
    await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'Verified' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })

    const before = await a.ok('assets.getCodeConfig')
    const lease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset_code_range', count: 5 }, durationHours: 4 })
    expect(lease.assetCodeRange).toMatchObject({ rangeStart: before.nextNumber, rangeEnd: before.nextNumber + 5 })

    // Normal online issuance continues from the end of the reserved range, never inside it.
    const category = await a.ok('categories.create', { code: 'LAP2', name: 'Laptop 2', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const created = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: `SN-${randomUUID().slice(0, 8)}`, specifications: null,
      condition: 'good', operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null,
      purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    })
    expect(created.assetCode).toBe(formatAssetCode(before, lease.assetCodeRange!.rangeEnd))

    // A prefix/format change is refused while this reservation is still outstanding.
    const blocked = await a.s.rpc('assets.updateCodeConfig', { prefix: 'NEW', separator: before.separator, padding: before.padding, nextNumber: lease.assetCodeRange!.rangeEnd + 1, reason: 'rebrand' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(blocked.body).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('offline asset-code reservation') } })

    // Once the lease is released, the reservation no longer counts as outstanding and the change succeeds.
    await a.s.rpc('leases.release', { leaseId: lease.id }, { cookie: agentCookie, headers: { 'idempotency-key': randomUUID() } })
    const allowed = await a.s.rpc('assets.updateCodeConfig', { prefix: 'NEW', separator: before.separator, padding: before.padding, nextNumber: lease.assetCodeRange!.rangeEnd + 1, reason: 'rebrand' }, { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } })
    expect(allowed.body).toMatchObject({ ok: true, data: { prefix: 'NEW' } })
  })
})

describe('leases.getScopedAssets (W9.5: work-package-scoped offline inventory)', () => {
  it('returns exactly the asset-scope lease\'s own assets, rejects an asset_code_range lease, and rejects a released lease', async () => {
    const a = await session()
    const f = await w4Setup(a, 3)
    const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Scoped Device' })
    await a.ok('devices.approve', { deviceId: device.id, trustNotes: 'Verified' })

    const lease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset', assetIds: [f.assets[0]!.id, f.assets[1]!.id] }, durationHours: 4 })
    const items = await a.ok('leases.getScopedAssets', { leaseId: lease.id })
    expect(items.map((i) => i.assetCode).sort()).toEqual([f.assets[0]!.assetCode, f.assets[1]!.assetCode].sort())
    expect(items.map((i) => i.assetCode)).not.toContain(f.assets[2]!.assetCode)

    // A range reservation has no specific assets to browse.
    const rangeLease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset_code_range', count: 3 }, durationHours: 4 })
    expect(await a.call('leases.getScopedAssets', { leaseId: rangeLease.id })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('asset scope') } })

    // Once released, the scope is no longer available for download.
    await a.ok('leases.release', { leaseId: lease.id })
    expect(await a.call('leases.getScopedAssets', { leaseId: lease.id })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('released') } })
  })
})
