import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AssetListItem } from '@shared/api'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAssetRepository } from '../../agent/main/db/assetsRepository'
import { openAgentDatabase } from '../../agent/main/db/connection'

const dirs: string[] = []
const dbs: Database[] = []
function tempDb(): { file: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'bpoam-agent-assets-'))
  dirs.push(dir)
  const file = join(dir, 'agent.sqlite')
  const db = openAgentDatabase(file)
  dbs.push(db)
  return { file, db }
}
afterEach(() => {
  // Closed here (not just at the end of each test body) so an assertion failure never leaves a
  // locked file handle behind -- Windows refuses to remove a directory while better-sqlite3 still
  // holds it open, which otherwise turns one failing assertion into a second, unrelated EPERM error.
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

describe('local asset snapshot (W9.4/W9.5: scoped to one work-package lease at a time)', () => {
  it('is empty with no last-synced time, scope, or snapshot before any download', async () => {
    const { db } = tempDb()
    const repo = createLocalAssetRepository(db)
    expect(await repo.list()).toEqual({ items: [], lastSyncedAt: null, scopeLeaseId: null, snapshotId: null })
  })

  it('stores a full snapshot tagged with its lease and a fresh snapshot id, and replaces it wholesale on the next download, never merging stale rows', async () => {
    const { db } = tempDb()
    const repo = createLocalAssetRepository(db)
    const first = await repo.replaceAll('lease-1', [sample('a1', 'AST-000001'), sample('a2', 'AST-000002')], '2026-10-12T09:00:00.000Z')
    expect((await repo.list()).items.map((i) => i.assetCode)).toEqual(['AST-000001', 'AST-000002'])

    // A second, smaller download must not leave the first download's now-stale row behind.
    const second = await repo.replaceAll('lease-1', [sample('a2', 'AST-000002')], '2026-10-12T10:00:00.000Z')
    const after = await repo.list()
    expect(after.items.map((i) => i.assetCode)).toEqual(['AST-000002'])
    expect(after.lastSyncedAt).toBe('2026-10-12T10:00:00.000Z')
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect(after.snapshotId).toBe(second.snapshotId)
  })

  it('switches scopes without leaking the previous work package\'s assets into the new one', async () => {
    const { db } = tempDb()
    const repo = createLocalAssetRepository(db)
    await repo.replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    await repo.replaceAll('lease-2', [sample('a2', 'AST-000002')], '2026-10-12T10:00:00.000Z')
    const after = await repo.list()
    expect(after.items.map((i) => i.assetCode)).toEqual(['AST-000002'])
    expect(after.scopeLeaseId).toBe('lease-2')
  })

  it('persists the downloaded snapshot, its scope, and its snapshot id across a full close and reopen of the database file (simulated restart)', async () => {
    const { file, db: first } = tempDb()
    const { snapshotId } = await createLocalAssetRepository(first).replaceAll('lease-1', [sample('a1', 'AST-000001')], '2026-10-12T09:00:00.000Z')
    first.close()

    const reopened = openAgentDatabase(file)
    dbs.push(reopened)
    const after = await createLocalAssetRepository(reopened).list()
    expect(after).toEqual({ items: [sample('a1', 'AST-000001')], lastSyncedAt: '2026-10-12T09:00:00.000Z', scopeLeaseId: 'lease-1', snapshotId })
  })
})
