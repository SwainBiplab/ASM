import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agent/main/cloudClient', () => ({
  cloudLogin: vi.fn(async () => 'session=fake'),
  listMyLeases: vi.fn(async () => [{ id: 'lease-1', status: 'active', assetIds: ['a1'] }]),
  fetchLeaseScopedAssets: vi.fn(async () => [{ id: 'a1', assetCode: 'AST-000001' }])
}))

import { createAgentDispatcher } from '../../agent/main/dispatcher'
import { cloudLogin, fetchLeaseScopedAssets, listMyLeases } from '../../agent/main/cloudClient'
import { ObservationError } from '../../agent/main/db/observationsRepository'
import { LocalScopeError } from '../../agent/main/db/scopeGuard'

const noObservations = { verifyItem: vi.fn(), flagMissing: vi.fn(), list: vi.fn() }
const noAssets = { replaceAll: vi.fn(), list: vi.fn() }
const noMaintenance = { create: vi.fn(), list: vi.fn() }

beforeEach(() => {
  vi.mocked(cloudLogin).mockClear()
  vi.mocked(listMyLeases).mockClear()
  vi.mocked(fetchLeaseScopedAssets).mockClear()
})

describe('agent IPC dispatcher (W9.4/W9.5)', () => {
  it('routes device.getLocalDevice and assets.listLocal to their own store/repository, and nothing else', async () => {
    const store = { getLocalDevice: vi.fn(async () => ({ id: 'd1', createdAt: '2026-01-01T00:00:00.000Z' })) }
    const assets = { replaceAll: vi.fn(async () => ({ snapshotId: 's1' })), list: vi.fn(async () => ({ items: [], lastSyncedAt: null, scopeLeaseId: null, snapshotId: null })) }
    const dispatch = createAgentDispatcher(store as never, assets as never, noObservations as never, noMaintenance as never)

    expect(await dispatch('device.getLocalDevice', undefined)).toEqual({ id: 'd1', createdAt: '2026-01-01T00:00:00.000Z' })
    expect(await dispatch('assets.listLocal', undefined)).toEqual({ items: [], lastSyncedAt: null, scopeLeaseId: null, snapshotId: null })
    expect(assets.replaceAll).not.toHaveBeenCalled()
  })

  it('lists the authenticated user\'s own leases for cloud.listLeases', async () => {
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, noMaintenance as never)
    const result = await dispatch('cloud.listLeases', { baseUrl: 'http://example.test', username: 'u', password: 'p' })
    expect(cloudLogin).toHaveBeenCalledWith('http://example.test', 'u', 'p')
    expect(listMyLeases).toHaveBeenCalledWith('http://example.test', 'session=fake')
    expect(result).toEqual([{ id: 'lease-1', status: 'active', assetIds: ['a1'] }])
  })

  it('rejects a malformed cloud.listLeases payload before ever calling the network (runtime IPC validation)', async () => {
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, noMaintenance as never)
    await expect(dispatch('cloud.listLeases', { baseUrl: 'http://example.test', password: 'p' })).rejects.toThrow()
    expect(cloudLogin).not.toHaveBeenCalled()
  })

  it('logs in, downloads exactly the given lease\'s scope, and replaces the local snapshot tagged with that lease and a fresh snapshot id', async () => {
    const assets = { replaceAll: vi.fn(async () => ({ snapshotId: 'snap-1' })), list: vi.fn() }
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, assets as never, noObservations as never, noMaintenance as never)

    const result = await dispatch('cloud.downloadLeaseAssets', { baseUrl: 'http://example.test', username: 'u', password: 'p', leaseId: 'lease-1' })
    expect(cloudLogin).toHaveBeenCalledWith('http://example.test', 'u', 'p')
    expect(fetchLeaseScopedAssets).toHaveBeenCalledWith('http://example.test', 'session=fake', 'lease-1')
    expect(assets.replaceAll).toHaveBeenCalledWith('lease-1', [{ id: 'a1', assetCode: 'AST-000001' }], expect.any(String))
    expect(result).toMatchObject({ downloaded: 1, leaseId: 'lease-1', snapshotId: 'snap-1' })
  })

  it('never touches the local snapshot when the download step fails, leaving any previous snapshot exactly as it was', async () => {
    vi.mocked(fetchLeaseScopedAssets).mockRejectedValueOnce(new Error('network interrupted mid-download'))
    const assets = { replaceAll: vi.fn(async () => ({ snapshotId: 'unused' })), list: vi.fn() }
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, assets as never, noObservations as never, noMaintenance as never)

    await expect(dispatch('cloud.downloadLeaseAssets', { baseUrl: 'http://example.test', username: 'u', password: 'p', leaseId: 'lease-1' })).rejects.toThrow('network interrupted mid-download')
    expect(assets.replaceAll).not.toHaveBeenCalled()
  })

  it('routes observations.verifyItem/flagMissing/listLocal to the observation repository with validated input', async () => {
    const observations = {
      verifyItem: vi.fn(async () => ({ id: 'o1', observationType: 'verified' })),
      flagMissing: vi.fn(async () => ({ id: 'o2', observationType: 'missing' })),
      list: vi.fn(async () => [])
    }
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, observations as never, noMaintenance as never)

    const verified = await dispatch('observations.verifyItem', { assetId: 'a1', snapshotId: 's1', observedCondition: 'good', notes: null })
    expect(observations.verifyItem).toHaveBeenCalledWith({ assetId: 'a1', snapshotId: 's1', observedCondition: 'good', notes: null })
    expect(verified).toEqual({ id: 'o1', observationType: 'verified' })

    const missing = await dispatch('observations.flagMissing', { assetId: 'a1', snapshotId: 's1', notes: 'Not on the shelf' })
    expect(observations.flagMissing).toHaveBeenCalledWith({ assetId: 'a1', snapshotId: 's1', notes: 'Not on the shelf' })
    expect(missing).toEqual({ id: 'o2', observationType: 'missing' })

    expect(await dispatch('observations.listLocal', undefined)).toEqual([])
  })

  it('rejects flagMissing with empty notes and verifyItem with an invalid condition before reaching the repository (invalid input)', async () => {
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, noMaintenance as never)
    await expect(dispatch('observations.flagMissing', { assetId: 'a1', snapshotId: 's1', notes: '' })).rejects.toThrow()
    await expect(dispatch('observations.verifyItem', { assetId: 'a1', snapshotId: 's1', observedCondition: 'pristine', notes: null })).rejects.toThrow()
    expect(noObservations.flagMissing).not.toHaveBeenCalled()
    expect(noObservations.verifyItem).not.toHaveBeenCalled()
  })

  it('surfaces a scope/snapshot rejection from the repository as a plain error message over the IPC boundary', async () => {
    const observations = { verifyItem: vi.fn(async () => { throw new ObservationError('The downloaded inventory has changed since this was loaded. Refresh and try again.', 'SNAPSHOT_MISMATCH') }), flagMissing: vi.fn(), list: vi.fn() }
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, observations as never, noMaintenance as never)
    await expect(dispatch('observations.verifyItem', { assetId: 'a1', snapshotId: 'stale', observedCondition: 'good', notes: null })).rejects.toThrow(/changed since this was loaded/)
  })

  it('routes maintenance.createLocalRequest/listLocal to the maintenance repository with validated input', async () => {
    const maintenance = {
      create: vi.fn(async () => ({ id: 'm1', faultCategory: 'hardware', priority: 'high' })),
      list: vi.fn(async () => [])
    }
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, maintenance as never)

    const created = await dispatch('maintenance.createLocalRequest', { assetId: 'a1', snapshotId: 's1', faultCategory: 'hardware', priority: 'high', description: 'Screen flickers' })
    expect(maintenance.create).toHaveBeenCalledWith({ assetId: 'a1', snapshotId: 's1', faultCategory: 'hardware', priority: 'high', description: 'Screen flickers' })
    expect(created).toEqual({ id: 'm1', faultCategory: 'hardware', priority: 'high' })
    expect(await dispatch('maintenance.listLocal', undefined)).toEqual([])
  })

  it('rejects a maintenance request with an empty description or an invalid fault category before reaching the repository (invalid input)', async () => {
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, noMaintenance as never)
    await expect(dispatch('maintenance.createLocalRequest', { assetId: 'a1', snapshotId: 's1', faultCategory: 'hardware', priority: 'high', description: '' })).rejects.toThrow()
    await expect(dispatch('maintenance.createLocalRequest', { assetId: 'a1', snapshotId: 's1', faultCategory: 'haunted', priority: 'high', description: 'ok' })).rejects.toThrow()
    expect(noMaintenance.create).not.toHaveBeenCalled()
  })

  it('surfaces a maintenance request\'s scope/snapshot rejection as a plain error message over the IPC boundary', async () => {
    const maintenance = { create: vi.fn(async () => { throw new LocalScopeError('This asset is not part of the currently downloaded work package.', 'ASSET_OUT_OF_SCOPE') }), list: vi.fn() }
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, maintenance as never)
    await expect(dispatch('maintenance.createLocalRequest', { assetId: 'out-of-scope', snapshotId: 's1', faultCategory: 'hardware', priority: 'high', description: 'ok' })).rejects.toThrow(/not part of the currently downloaded/)
  })

  it('rejects an unrecognized command at runtime, not just by the allow-listed IPC channel binding', async () => {
    const dispatch = createAgentDispatcher({ getLocalDevice: vi.fn() } as never, noAssets as never, noObservations as never, noMaintenance as never)
    await expect(dispatch('not.a.real.command' as never, undefined)).rejects.toThrow(/Unknown agent command/)
  })
})
