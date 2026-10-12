import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AssetListItem } from '@shared/api'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAssetRepository } from '../../agent/main/db/assetsRepository'
import { openAgentDatabase } from '../../agent/main/db/connection'
import { createLocalObservationRepository, ObservationError } from '../../agent/main/db/observationsRepository'

const dirs: string[] = []
const dbs: Database[] = []
function tempDb(): { file: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'bpoam-agent-observations-'))
  dirs.push(dir)
  const file = join(dir, 'agent.sqlite')
  const db = openAgentDatabase(file)
  dbs.push(db)
  return { file, db }
}
afterEach(() => {
  // See assetsRepository.test.ts: closing here (not inline per test) avoids a locked-file EPERM
  // on Windows whenever an assertion throws before a test's own db.close() call runs.
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

describe('local audit observations against a frozen lease-scoped snapshot (W9.5)', () => {
  it('refuses any observation before an inventory has ever been downloaded', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalObservationRepository(db, assetsRepo)
    await expect(repo.verifyItem({ assetId: 'a1', snapshotId: 'whatever', observedCondition: 'good', notes: null })).rejects.toMatchObject({ code: 'NO_ACTIVE_SCOPE' })
  })

  it('records a matching and a mismatching verification against the exact cached snapshot, and a missing-item observation', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalObservationRepository(db, assetsRepo)
    const { snapshotId } = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001'), sample('a2', 'AST-000002')], '2026-10-12T09:00:00.000Z')

    const matched = await repo.verifyItem({ assetId: 'a1', snapshotId, observedCondition: 'good', notes: 'Looks fine' })
    expect(matched).toMatchObject({ observationType: 'verified', matchesCachedCondition: true, scopeLeaseId: 'lease-1', snapshotId, syncStatus: 'local_pending', assetCode: 'AST-000001' })

    const mismatched = await repo.verifyItem({ assetId: 'a2', snapshotId, observedCondition: 'damaged', notes: 'Cracked screen' })
    expect(mismatched).toMatchObject({ observationType: 'verified', matchesCachedCondition: false })

    const missing = await repo.flagMissing({ assetId: 'a1', snapshotId, notes: 'Not found at expected desk' })
    expect(missing).toMatchObject({ observationType: 'missing', observedCondition: null, matchesCachedCondition: null })

    expect(await repo.list()).toHaveLength(3)
  })

  it('rejects an observation for an asset outside the active cached scope', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalObservationRepository(db, assetsRepo)
    const { snapshotId } = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')

    await expect(repo.verifyItem({ assetId: 'not-in-scope', snapshotId, observedCondition: 'good', notes: null })).rejects.toMatchObject({ code: 'ASSET_OUT_OF_SCOPE' })
    expect(await repo.list()).toHaveLength(0)
  })

  it('rejects an observation made against a snapshot that has since been replaced by a refresh (snapshot mismatch)', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalObservationRepository(db, assetsRepo)
    const first = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    // The renderer loaded the list under the first snapshot, but a refresh has happened since.
    await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T10:00:00.000Z')

    await expect(repo.verifyItem({ assetId: 'a1', snapshotId: first.snapshotId, observedCondition: 'good', notes: null })).rejects.toBeInstanceOf(ObservationError)
    await expect(repo.verifyItem({ assetId: 'a1', snapshotId: first.snapshotId, observedCondition: 'good', notes: null })).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' })
  })

  it('also rejects a switched-scope asset that happens to share an id with the previous lease (not just a dropped snapshot id)', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalObservationRepository(db, assetsRepo)
    const first = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    await assetsRepo.replaceAll('lease-2', [sample('a2', 'AST-000002')], '2026-10-12T10:00:00.000Z')

    await expect(repo.verifyItem({ assetId: 'a1', snapshotId: first.snapshotId, observedCondition: 'good', notes: null })).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' })
  })

  it('keeps observation history across a scope switch, but marks it as no longer belonging to the currently active snapshot (item 8)', async () => {
    const { db } = tempDb()
    const assetsRepo = createLocalAssetRepository(db)
    const repo = createLocalObservationRepository(db, assetsRepo)
    const first = await assetsRepo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    const older = await repo.flagMissing({ assetId: 'a1', snapshotId: first.snapshotId, notes: 'Could not find it under lease-1' })
    expect(older.isCurrentSnapshot).toBe(true)

    // The scope moves on to a different work package entirely.
    const second = await assetsRepo.replaceAll('lease-2', [sample('a2', 'AST-000002')], '2026-10-12T10:00:00.000Z')
    const newer = await repo.flagMissing({ assetId: 'a2', snapshotId: second.snapshotId, notes: 'Could not find it under lease-2' })

    const all = await repo.list()
    expect(all).toHaveLength(2)
    const olderAfterSwitch = all.find((o) => o.id === older.id)!
    const newerAfterSwitch = all.find((o) => o.id === newer.id)!
    // Both rows survive (history is preserved, not deleted)...
    expect(olderAfterSwitch.snapshotId).toBe(first.snapshotId)
    // ...but only the one made under the snapshot that is still active reads as "current."
    expect(olderAfterSwitch.isCurrentSnapshot).toBe(false)
    expect(newerAfterSwitch.isCurrentSnapshot).toBe(true)
  })

  it('persists recorded observations across a full close and reopen of the database file (simulated restart)', async () => {
    const { file, db: firstDb } = tempDb()
    const firstAssets = createLocalAssetRepository(firstDb)
    const { snapshotId } = await firstAssets.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    await createLocalObservationRepository(firstDb, firstAssets).flagMissing({ assetId: 'a1', snapshotId, notes: 'Could not locate' })
    firstDb.close()

    const reopenedDb = openAgentDatabase(file)
    dbs.push(reopenedDb)
    const reopenedAssets = createLocalAssetRepository(reopenedDb)
    const observations = await createLocalObservationRepository(reopenedDb, reopenedAssets).list()
    expect(observations).toMatchObject([{ assetId: 'a1', observationType: 'missing', notes: 'Could not locate', syncStatus: 'local_pending' }])
  })
})
