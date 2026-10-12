import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { FaultCategory, MaintenancePriority } from '@shared/maintenance'
import type { LocalAssetRepository } from './assetsRepository'
import { requireScopedAsset } from './scopeGuard'

/**
 * Purely local, unsynced maintenance requests against the frozen lease-scoped snapshot (W9.5
 * continued). Reuses the cloud maintenance module's terminology and the exact same scope/snapshot
 * guard `observationsRepository.ts` uses (`requireScopedAsset`) -- a request can no more reference
 * an out-of-scope asset or a stale snapshot than an observation can. Never a server-confirmed
 * ticket: `syncStatus` is always `'local_pending'`.
 */
export interface LocalMaintenanceRequest {
  id: string
  scopeLeaseId: string
  snapshotId: string
  assetId: string
  assetCode: string
  faultCategory: FaultCategory
  priority: MaintenancePriority
  description: string
  requestedAt: string
  syncStatus: 'local_pending'
  isCurrentSnapshot: boolean
}

export interface CreateMaintenanceRequestInput {
  assetId: string
  snapshotId: string
  faultCategory: FaultCategory
  priority: MaintenancePriority
  description: string
}

export interface LocalMaintenanceRequestRepository {
  create(input: CreateMaintenanceRequestInput): Promise<LocalMaintenanceRequest>
  list(): Promise<LocalMaintenanceRequest[]>
}

type Row = {
  id: string
  scope_lease_id: string
  snapshot_id: string
  asset_id: string
  asset_code: string
  fault_category: FaultCategory
  priority: MaintenancePriority
  description: string
  requested_at: string
  sync_status: 'local_pending'
}

function toRequest(r: Row, currentSnapshotId: string | null): LocalMaintenanceRequest {
  return {
    id: r.id,
    scopeLeaseId: r.scope_lease_id,
    snapshotId: r.snapshot_id,
    assetId: r.asset_id,
    assetCode: r.asset_code,
    faultCategory: r.fault_category,
    priority: r.priority,
    description: r.description,
    requestedAt: r.requested_at,
    syncStatus: r.sync_status,
    isCurrentSnapshot: r.snapshot_id === currentSnapshotId
  }
}

export function createLocalMaintenanceRequestRepository(db: Database, assets: LocalAssetRepository): LocalMaintenanceRequestRepository {
  return {
    async create(input) {
      const { scopeLeaseId, snapshotId, asset } = requireScopedAsset(assets, input.assetId, input.snapshotId)
      const row: Row = {
        id: randomUUID(),
        scope_lease_id: scopeLeaseId,
        snapshot_id: snapshotId,
        asset_id: asset.id,
        asset_code: asset.assetCode,
        fault_category: input.faultCategory,
        priority: input.priority,
        description: input.description,
        requested_at: new Date().toISOString(),
        sync_status: 'local_pending'
      }
      db.prepare(
        `INSERT INTO local_maintenance_requests (id, scope_lease_id, snapshot_id, asset_id, asset_code, fault_category, priority, description, requested_at)
         VALUES (@id, @scope_lease_id, @snapshot_id, @asset_id, @asset_code, @fault_category, @priority, @description, @requested_at)`
      ).run(row)
      return toRequest(row, assets.currentScope().snapshotId)
    },
    async list() {
      const rows = db.prepare('SELECT * FROM local_maintenance_requests ORDER BY requested_at DESC').all() as Row[]
      const currentSnapshotId = assets.currentScope().snapshotId
      return rows.map((r) => toRequest(r, currentSnapshotId))
    }
  }
}
