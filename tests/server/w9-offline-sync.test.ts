import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiSession, type ApiSession } from './session-helpers'
import { count, w4Setup } from './w4-helpers'

/**
 * W9.7: the first real sync path turning locally-pending offline records into authoritative server
 * records (DECISIONS.md D50/D51, KNOWN_ISSUES W-44/W-45). Every test runs against a real
 * ephemeral PostgreSQL database; the safety-gate tests specifically verify the *default-off*
 * behavior matters -- `SYNC_UPLOADS_ENABLED` is only turned on for the sessions that need it.
 */

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})

async function syncSession(): Promise<ApiSession> {
  const a = await createApiSession({ env: { SYNC_UPLOADS_ENABLED: 'true' } })
  sessions.push(a)
  return a
}

async function arrangeLease(a: ApiSession) {
  const f = await w4Setup(a, 2)
  const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: 'Sync Device' })
  await a.ok('devices.approve', { deviceId: device.id, trustNotes: 'Verified' })
  const lease = await a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset', assetIds: [f.assets[0]!.id] }, durationHours: 4 })
  return { f, device, lease }
}

function observationPayload(overrides: Record<string, unknown> = {}) {
  return { clientRecordId: randomUUID(), observationType: 'verified', observedCondition: 'good', notes: 'Looks fine', clientObservedAt: new Date().toISOString(), ...overrides }
}

function authority(lease: { id: string; fencingEpoch: number }, device: { id: string }, assetId: string) {
  return { leaseId: lease.id, deviceId: device.id, fencingEpoch: lease.fencingEpoch, assetId }
}

describe('offline sync uploads: the SYNC_UPLOADS_ENABLED safety gate (W-44/W-45)', () => {
  it('refuses every upload while the gate is off (the default), even with an otherwise fully valid, authorized record', async () => {
    const a = await createApiSession()
    sessions.push(a)
    const { f, device, lease } = await arrangeLease(a)
    const result = await a.call('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() } as never)
    expect(result).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('not enabled') } })
  })
})

describe('offline sync uploads: authorization derived from real server state, never trusted from the client', () => {
  it('accepts a valid observation, and a maintenance request becomes a real ticket, reusing createTicket\'s own authorization', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)

    const obs = await a.ok('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() } as never)
    expect(obs).toMatchObject({ duplicate: false })
    const [row] = await a.sql<{ assetCode: string }>('SELECT a.asset_code AS "assetCode" FROM offline_observation_records r JOIN assets a ON a.id = r.asset_id WHERE r.id = $1', [obs.serverEntityId])
    expect(row!.assetCode).toBe(f.assets[0]!.assetCode)

    const req = await a.ok('offlineSync.uploadMaintenanceRequest', {
      ...authority(lease, device, f.assets[0]!.id), clientRecordId: randomUUID(), faultCategory: 'hardware', priority: 'high', description: 'Screen flickers', clientRequestedAt: new Date().toISOString()
    } as never)
    expect(req).toMatchObject({ duplicate: false, ticketNumber: expect.stringMatching(/^MT-/) })
    const [ticket] = await a.sql<{ status: string }>('SELECT status FROM maintenance_tickets WHERE id = $1', [req.serverEntityId])
    expect(ticket!.status).toBe('open')
  })

  it('rejects an asset outside the lease\'s authorized scope, even though the lease/device/epoch are all genuinely valid', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const result = await a.call('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[1]!.id), ...observationPayload() } as never)
    expect(result).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('authorized scope') } })
  })

  it('rejects a stale fencing epoch (the lease was reissued since this record was created)', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const staleAuthority = { ...authority(lease, device, f.assets[0]!.id), fencingEpoch: lease.fencingEpoch + 10000 }
    const result = await a.call('offlineSync.uploadObservation', { ...staleAuthority, ...observationPayload() } as never)
    expect(result).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('fencing epoch mismatch') } })
  })

  it('rejects an upload from a lease that has since been revoked/reclaimed, proving a revoked device cannot upload', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    await a.ok('devices.revoke', { deviceId: device.id, reason: 'Lost' })
    const result = await a.call('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() } as never)
    expect(result).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('no longer accept uploads') } })
  })

  it('rejects an invalid payload (bad condition enum / missing required field) before any authorization check runs', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const badCondition = await a.call('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[0]!.id), ...observationPayload({ observedCondition: 'pristine' }) } as never)
    expect(badCondition).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })

    const missingDescription = await a.call('offlineSync.uploadMaintenanceRequest', {
      ...authority(lease, device, f.assets[0]!.id), clientRecordId: randomUUID(), faultCategory: 'hardware', priority: 'high', description: '', clientRequestedAt: new Date().toISOString()
    } as never)
    expect(missingDescription).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })
})

describe('offline sync uploads: idempotency and duplicate prevention', () => {
  it('replays the cached response for a retry with the same Idempotency-Key (the fast path, within the 24h TTL)', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const key = randomUUID()
    const payload = { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() }
    const first = await a.s.rpc('offlineSync.uploadObservation', payload, { cookie: a.cookie, headers: { 'idempotency-key': key } })
    const second = await a.s.rpc('offlineSync.uploadObservation', payload, { cookie: a.cookie, headers: { 'idempotency-key': key } })
    expect(second.body).toEqual(first.body)
    expect(await count(a, 'SELECT count(*) AS n FROM offline_observation_records')).toBe(1)
  })

  it('still refuses to create a second server record for the same clientRecordId even under a different Idempotency-Key (the permanent layer, simulating a retry after the 24h TTL expired)', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const payload = { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() }
    const first = await a.s.rpc('offlineSync.uploadObservation', payload, { cookie: a.cookie, headers: { 'idempotency-key': randomUUID() } })
    const retry = await a.s.rpc('offlineSync.uploadObservation', payload, { cookie: a.cookie, headers: { 'idempotency-key': randomUUID() } })
    expect(retry.body).toMatchObject({ ok: true, data: { serverEntityId: (first.body as { data: { serverEntityId: string } }).data.serverEntityId, duplicate: true } })
    expect(await count(a, 'SELECT count(*) AS n FROM offline_observation_records')).toBe(1)
  })

  it('does the same for a duplicate maintenance-request upload: one ticket, not two, even past a simulated key expiry', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const payload = { ...authority(lease, device, f.assets[0]!.id), clientRecordId: randomUUID(), faultCategory: 'hardware', priority: 'high', description: 'Screen flickers', clientRequestedAt: new Date().toISOString() }
    const first = await a.s.rpc('offlineSync.uploadMaintenanceRequest', payload, { cookie: a.cookie, headers: { 'idempotency-key': randomUUID() } })
    const retry = await a.s.rpc('offlineSync.uploadMaintenanceRequest', payload, { cookie: a.cookie, headers: { 'idempotency-key': randomUUID() } })
    expect(retry.body).toMatchObject({ ok: true, data: { duplicate: true, ticketNumber: (first.body as { data: { ticketNumber: string } }).data.ticketNumber } })
    expect(await count(a, 'SELECT count(*) AS n FROM maintenance_tickets')).toBe(1)
  })

  it('does not let one rejected record in a sequence of uploads discard or block the others (partial-failure isolation)', async () => {
    const a = await syncSession()
    const { f, device, lease } = await arrangeLease(a)
    const badAsset = await a.call('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[1]!.id), ...observationPayload() } as never)
    const good1 = await a.ok('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() } as never)
    const good2 = await a.ok('offlineSync.uploadObservation', { ...authority(lease, device, f.assets[0]!.id), ...observationPayload() } as never)
    expect(badAsset).toMatchObject({ ok: false })
    expect(good1.duplicate).toBe(false)
    expect(good2.duplicate).toBe(false)
    expect(await count(a, 'SELECT count(*) AS n FROM offline_observation_records')).toBe(2)
  })
})
