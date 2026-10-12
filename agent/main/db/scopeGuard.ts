import type { AssetListItem } from '@shared/api'
import type { LocalAssetRepository } from './assetsRepository'

/**
 * Shared gate for every local write tied to the active lease-scoped snapshot -- audit observations
 * (W9.5) and local maintenance requests (W9.5 cont'd) both need the identical three checks, so this
 * is extracted once rather than duplicated and risking drift between the two repositories.
 */
export class LocalScopeError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_ACTIVE_SCOPE' | 'SNAPSHOT_MISMATCH' | 'ASSET_OUT_OF_SCOPE'
  ) {
    super(message)
  }
}

export interface ScopedAsset {
  scopeLeaseId: string
  snapshotId: string
  asset: AssetListItem
}

/**
 * There must be an active scope at all, the caller's `snapshotId` must match the one currently
 * cached (not a snapshot since replaced by a refresh), and the asset must actually be one of the
 * current scope's cached assets -- `getCachedAsset` returning null covers both "never was in scope"
 * and "scope changed and dropped it."
 */
export function requireScopedAsset(assets: LocalAssetRepository, assetId: string, snapshotId: string): ScopedAsset {
  const scope = assets.currentScope()
  if (!scope.scopeLeaseId || !scope.snapshotId) throw new LocalScopeError('No offline inventory has been downloaded yet.', 'NO_ACTIVE_SCOPE')
  if (scope.snapshotId !== snapshotId) throw new LocalScopeError('The downloaded inventory has changed since this was loaded. Refresh and try again.', 'SNAPSHOT_MISMATCH')
  const asset = assets.getCachedAsset(assetId)
  if (!asset) throw new LocalScopeError('This asset is not part of the currently downloaded work package.', 'ASSET_OUT_OF_SCOPE')
  return { scopeLeaseId: scope.scopeLeaseId, snapshotId: scope.snapshotId, asset }
}
