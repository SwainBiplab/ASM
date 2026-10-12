import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AssetListItem } from '@shared/api'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAssetRepository } from '../../agent/main/db/assetsRepository'
import { openAgentDatabase } from '../../agent/main/db/connection'
import { createLocalMaintenanceRequestRepository } from '../../agent/main/db/maintenanceRepository'
import { LocalScopeError } from '../../agent/main/db/scopeGuard'

const dirs: string[] = []
const dbs: Database[] = []
function tempDb(): { file: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'bpoam-agent-maintenance-'))
  dirs.push(dir)
  const file = join(dir, 'agent.sqlite')
  const db = openAgentDatabase(file)
  dbs.push(db)
  return { file, db }
}
afterEach(() => {
  // See assetsRepository.test.ts: closing every opened db here (not inline per test) avoids a
  // Windows EPERM on cleanup whenever an assertion throws before a test reaches its own close().
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed by the test itself */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sample = (id: string, assetCode: string): AssetListItem => ({
  id, assetCode, categoryName: 'Laptop', assetDomain: 'it', manufacturer: 'Dell', modelName: 'Latitude', serialNumber: 'SN-1',
  lifecycleStatus: 'active', operationalStatus: 'ready', condition: 'good', locationPath: 'Pune / Floor 3', warrantyEnd: null, updatedAt: '2026-01-01T00:00:00.000Z'
})

describe('local maintenance requests against a frozen lease-scoped snapshot (W9.5 continued)', () => {
  it('records a valid request tagged with the active lease, asset and exact snapshot, as local_pending', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalMaintenanceRequestRepository(db, assetsRepo)
    const { snapshotId } = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')

    const request = await repo.create({ assetId: 'a1', snapshotId, faultCategory: 'hardware', priority: 'high', description: 'Screen flickers intermittently' })
    expect(request).toMatchObject({
      scopeLeaseId: 'lease-1', snapshotId, assetId: 'a1', assetCode: 'AST-000001',
      faultCategory: 'hardware', priority: 'high', description: 'Screen flickers intermittently',
      syncStatus: 'local_pending', isCurrentSnapshot: true
    })
    expect(await repo.list()).toHaveLength(1)
  })

  it('refuses a request before any inventory has been downloaded', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalMaintenanceRequestRepository(db, assetsRepo)
    await expect(repo.create({ assetId: 'a1', snapshotId: 'whatever', faultCategory: 'hardware', priority: 'high', description: 'x' })).rejects.toMatchObject({ code: 'NO_ACTIVE_SCOPE' })
  })

  it('rejects a request for an asset outside the active cached scope', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalMaintenanceRequestRepository(db, assetsRepo)
    const { snapshotId } = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    await expect(repo.create({ assetId: 'not-in-scope', snapshotId, faultCategory: 'hardware', priority: 'high', description: 'x' })).rejects.toBeInstanceOf(LocalScopeError)
    await expect(repo.create({ assetId: 'not-in-scope', snapshotId, faultCategory: 'hardware', priority: 'high', description: 'x' })).rejects.toMatchObject({ code: 'ASSET_OUT_OF_SCOPE' })
    expect(await repo.list()).toHaveLength(0)
  })

  it('rejects a request made against a snapshot id that no longer matches the currently cached one (stale/mismatched snapshot)', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalMaintenanceRequestRepository(db, assetsRepo)
    const first = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T10:00:00.000Z')

    await expect(repo.create({ assetId: 'a1', snapshotId: first.snapshotId, faultCategory: 'hardware', priority: 'high', description: 'x' })).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' })
  })

  it('keeps request history across a scope switch, but marks it as no longer belonging to the currently active snapshot', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalMaintenanceRequestRepository(db, assetsRepo)
    const first = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    const older = await repo.create({ assetId: 'a1', snapshotId: first.snapshotId, faultCategory: 'hardware', priority: 'low', description: 'Under lease-1' })

    const second = await assetsRepo.replaceAll('lease-2', [sample('a2', 'AST-000002')], '2026-10-12T10:00:00.000Z')
    const newer = await repo.create({ assetId: 'a2', snapshotId: second.snapshotId, faultCategory: 'software', priority: 'critical', description: 'Under lease-2' })

    const all = await repo.list()
    expect(all).toHaveLength(2)
    expect(all.find((r) => r.id === older.id)!.isCurrentSnapshot).toBe(false)
    expect(all.find((r) => r.id === newer.id)!.isCurrentSnapshot).toBe(true)
  })

  it('persists recorded requests across a full close and reopen of the database file (simulated restart)', async () => {
    const { file, db: firstDb } = tempDb()
    const firstAssets = createLocalAssetRepository(firstDb)
    const { snapshotId } = await firstAssets.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    await createLocalMaintenanceRequestRepository(firstDb, firstAssets).create({ assetId: 'a1', snapshotId, faultCategory: 'electrical', priority: 'medium', description: 'Buzzing noise' })
    firstDb.close()

    const reopenedDb = openAgentDatabase(file)
    dbs.push(reopenedDb)
    const reopenedAssets = createLocalAssetRepository(reopenedDb)
    const requests = await createLocalMaintenanceRequestRepository(reopenedDb, reopenedAssets).list()
    expect(requests).toMatchObject([{ assetId: 'a1', faultCategory: 'electrical', priority: 'medium', description: 'Buzzing noise', syncStatus: 'local_pending' }])
  })
})
