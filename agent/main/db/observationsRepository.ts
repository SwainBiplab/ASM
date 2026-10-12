import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AssetCondition } from '@shared/assets'
import type { LocalAssetRepository } from './assetsRepository'
import { LocalScopeError, requireScopedAsset } from './scopeGuard'

/**
 * Purely local, unsynced audit observations (W9.5). `verifyItem`/`flagMissing` reuse the cloud
 * audit module's terminology (`src/shared/auditSchemas.ts`), but these rows are never uploaded or
 * treated as a server audit record in this slice -- `syncStatus` is always `'local_pending'`
 * (enforced by the migration's own CHECK constraint, not just this code).
 *
 * History is kept, not wiped, when the active scope/snapshot changes (a technician's field notes
 * shouldn't vanish just because the cache refreshed) -- but `list()` tags every row with
 * `isCurrentSnapshot` so a caller can tell a live observation apart from one made against a scope
 * that has since been replaced, instead of a flat list that looks uniformly "current."
 */
export type ObservationType = 'verified' | 'missing'

export interface LocalObservation {
  id: string
  scopeLeaseId: string
  snapshotId: string
  assetId: string
  assetCode: string
  observationType: ObservationType
  observedCondition: AssetCondition | null
  matchesCachedCondition: boolean | null
  notes: string | null
  observedAt: string
  syncStatus: 'local_pending'
  isCurrentSnapshot: boolean
}

/** Re-exported for existing callers/tests; the check itself is now shared with the maintenance-request repository. */
export { LocalScopeError as ObservationError }

export interface VerifyItemLocalInput {
  assetId: string
  snapshotId: string
  observedCondition: AssetCondition
  notes: string | null
}

export interface FlagMissingLocalInput {
  assetId: string
  snapshotId: string
  notes: string
}

export interface LocalObservationRepository {
  verifyItem(input: VerifyItemLocalInput): Promise<LocalObservation>
  flagMissing(input: FlagMissingLocalInput): Promise<LocalObservation>
  list(): Promise<LocalObservation[]>
}

type Row = {
  id: string
  scope_lease_id: string
  snapshot_id: string
  asset_id: string
  asset_code: string
  observation_type: ObservationType
  observed_condition: AssetCondition | null
  matches_cached_condition: 0 | 1 | null
  notes: string | null
  observed_at: string
  sync_status: 'local_pending'
}

function toObservation(r: Row, currentSnapshotId: string | null): LocalObservation {
  return {
    id: r.id,
    scopeLeaseId: r.scope_lease_id,
    snapshotId: r.snapshot_id,
    assetId: r.asset_id,
    assetCode: r.asset_code,
    observationType: r.observation_type,
    observedCondition: r.observed_condition,
    matchesCachedCondition: r.matches_cached_condition === null ? null : r.matches_cached_condition === 1,
    notes: r.notes,
    observedAt: r.observed_at,
    syncStatus: r.sync_status,
    isCurrentSnapshot: r.snapshot_id === currentSnapshotId
  }
}

export function createLocalObservationRepository(db: Database, assets: LocalAssetRepository): LocalObservationRepository {
  function insert(row: Omit<Row, 'sync_status'>): LocalObservation {
    db.prepare(
      `INSERT INTO local_audit_observations (id, scope_lease_id, snapshot_id, asset_id, asset_code, observation_type, observed_condition, matches_cached_condition, notes, observed_at)
       VALUES (@id, @scope_lease_id, @snapshot_id, @asset_id, @asset_code, @observation_type, @observed_condition, @matches_cached_condition, @notes, @observed_at)`
    ).run(row)
    return toObservation({ ...row, sync_status: 'local_pending' }, assets.currentScope().snapshotId)
  }

  return {
    async verifyItem(input) {
      const { scopeLeaseId, snapshotId, asset } = requireScopedAsset(assets, input.assetId, input.snapshotId)
      const matches = input.observedCondition === asset.condition
      return insert({
        id: randomUUID(),
        scope_lease_id: scopeLeaseId,
        snapshot_id: snapshotId,
        asset_id: asset.id,
        asset_code: asset.assetCode,
        observation_type: 'verified',
        observed_condition: input.observedCondition,
        matches_cached_condition: matches ? 1 : 0,
        notes: input.notes,
        observed_at: new Date().toISOString()
      })
    },
    async flagMissing(input) {
      const { scopeLeaseId, snapshotId, asset } = requireScopedAsset(assets, input.assetId, input.snapshotId)
      return insert({
        id: randomUUID(),
        scope_lease_id: scopeLeaseId,
        snapshot_id: snapshotId,
        asset_id: asset.id,
        asset_code: asset.assetCode,
        observation_type: 'missing',
        observed_condition: null,
        matches_cached_condition: null,
        notes: input.notes,
        observed_at: new Date().toISOString()
      })
    },
    async list() {
      const rows = db.prepare('SELECT * FROM local_audit_observations ORDER BY observed_at DESC').all() as Row[]
      const currentSnapshotId = assets.currentScope().snapshotId
      return rows.map((r) => toObservation(r, currentSnapshotId))
    }
  }
}
