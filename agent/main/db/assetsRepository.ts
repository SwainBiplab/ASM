import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AssetListItem } from '@shared/api'

/**
 * Read-only local snapshot of a single, specific leased work package (W9.5; was organization-wide
 * in W9.4). `replaceAll` is the only write path, and it is only ever called from a successful
 * scoped cloud download -- there is no local create/edit/delete. It always wipes the table first
 * inside one transaction, which is what actually guarantees switching to a different lease's scope
 * can never leave a previous scope's assets visible, and what guarantees a failed/interrupted
 * refresh (which never reaches this call at all, since the agent downloads everything into memory
 * before calling it) leaves the previous complete snapshot untouched.
 *
 * Every successful download also mints a fresh `snapshotId`, independent of the lease id: this is
 * what lets `observationsRepository.ts` tell a still-current snapshot apart from one that has since
 * been replaced by a later refresh, even if the lease itself is unchanged.
 */
export interface LocalAssetRepository {
  replaceAll(scopeLeaseId: string, items: AssetListItem[], syncedAt: string): Promise<{ snapshotId: string }>
  list(): Promise<{ items: AssetListItem[]; lastSyncedAt: string | null; scopeLeaseId: string | null; snapshotId: string | null }>
  /** Current scope/snapshot identity only, for callers (the observation repository) that don't need the asset rows themselves. */
  currentScope(): { scopeLeaseId: string | null; snapshotId: string | null }
  /** A single cached asset, or null if it isn't part of the active scope -- the scope-membership check. */
  getCachedAsset(assetId: string): AssetListItem | null
}

type Row = {
  id: string
  asset_code: string
  category_name: string
  asset_domain: string
  manufacturer: string | null
  model_name: string | null
  serial_number: string | null
  lifecycle_status: string
  operational_status: string
  condition: string
  location_path: string | null
  warranty_end: string | null
  updated_at: string
}

function toAssetListItem(r: Row): AssetListItem {
  return {
    id: r.id,
    assetCode: r.asset_code,
    categoryName: r.category_name,
    assetDomain: r.asset_domain as AssetListItem['assetDomain'],
    manufacturer: r.manufacturer,
    modelName: r.model_name,
    serialNumber: r.serial_number,
    lifecycleStatus: r.lifecycle_status as AssetListItem['lifecycleStatus'],
    operationalStatus: r.operational_status as AssetListItem['operationalStatus'],
    condition: r.condition as AssetListItem['condition'],
    locationPath: r.location_path,
    warrantyEnd: r.warranty_end,
    updatedAt: r.updated_at
  }
}

type StateRow = { lastSyncedAt: string; scopeLeaseId: string | null; snapshotId: string | null }

export function createLocalAssetRepository(db: Database): LocalAssetRepository {
  const replace = db.transaction((scopeLeaseId: string, items: AssetListItem[], syncedAt: string, snapshotId: string) => {
    // Wiping unconditionally (not just rows from a different scope) is what prevents any leakage
    // when switching work packages, and is itself what makes this step atomic: a constraint failure
    // partway through rolls back the delete too, leaving the prior scope's snapshot exactly as it was.
    db.prepare('DELETE FROM local_assets').run()
    const insert = db.prepare(
      `INSERT INTO local_assets (id, asset_code, category_name, asset_domain, manufacturer, model_name, serial_number, lifecycle_status, operational_status, condition, location_path, warranty_end, updated_at, synced_at, scope_lease_id)
       VALUES (@id, @assetCode, @categoryName, @assetDomain, @manufacturer, @modelName, @serialNumber, @lifecycleStatus, @operationalStatus, @condition, @locationPath, @warrantyEnd, @updatedAt, @syncedAt, @scopeLeaseId)`
    )
    for (const item of items) insert.run({ ...item, syncedAt, scopeLeaseId })
    db.prepare(
      'INSERT INTO local_sync_state (id, last_synced_at, scope_lease_id, snapshot_id) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_synced_at = excluded.last_synced_at, scope_lease_id = excluded.scope_lease_id, snapshot_id = excluded.snapshot_id'
    ).run(syncedAt, scopeLeaseId, snapshotId)
  })

  function readState(): StateRow | undefined {
    return db.prepare('SELECT last_synced_at AS lastSyncedAt, scope_lease_id AS scopeLeaseId, snapshot_id AS snapshotId FROM local_sync_state WHERE id = 1').get() as StateRow | undefined
  }

  return {
    async replaceAll(scopeLeaseId, items, syncedAt) {
      const snapshotId = randomUUID()
      replace(scopeLeaseId, items, syncedAt, snapshotId)
      return { snapshotId }
    },
    async list() {
      // Every query is restricted to the one cached scope by construction: replaceAll never leaves
      // more than one scope's rows present, so there is nothing else here to accidentally select.
      const rows = db.prepare('SELECT * FROM local_assets ORDER BY asset_code').all() as Row[]
      const state = readState()
      return { items: rows.map(toAssetListItem), lastSyncedAt: state?.lastSyncedAt ?? null, scopeLeaseId: state?.scopeLeaseId ?? null, snapshotId: state?.snapshotId ?? null }
    },
    currentScope() {
      const state = readState()
      return { scopeLeaseId: state?.scopeLeaseId ?? null, snapshotId: state?.snapshotId ?? null }
    },
    getCachedAsset(assetId) {
      const row = db.prepare('SELECT * FROM local_assets WHERE id = ?').get(assetId) as Row | undefined
      return row ? toAssetListItem(row) : null
    }
  }
}
