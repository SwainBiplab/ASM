import type { AssetListItem, OfflineLeaseView } from '@shared/api'
import type { AssetCondition } from '@shared/assets'
import type { FaultCategory, MaintenancePriority } from '@shared/maintenance'

/**
 * The agent's own, deliberately tiny IPC allow-list (W9.3-W9.5). Not `@shared/api`'s
 * `COMMAND_NAMES` -- that is the full cloud RPC surface, and the agent implements none of it
 * locally yet (no business mutations, no sync). This list grows one command at a time as each
 * local capability is actually built, never speculatively. No offline create/edit/delete exists.
 * The `observations.*` and `maintenance.*` commands are purely local and unsynced -- neither is
 * ever a server-confirmed record, and every result is tagged `syncStatus: 'local_pending'`.
 */
export const AGENT_COMMAND_NAMES = [
  'device.getLocalDevice',
  'assets.listLocal',
  'cloud.listLeases',
  'cloud.downloadLeaseAssets',
  'observations.verifyItem',
  'observations.flagMissing',
  'observations.listLocal',
  'maintenance.createLocalRequest',
  'maintenance.listLocal'
] as const
export type AgentCommandName = (typeof AGENT_COMMAND_NAMES)[number]

export interface CloudCredentialsInput {
  baseUrl: string
  username: string
  password: string
}

export interface DownloadLeaseAssetsInput extends CloudCredentialsInput {
  leaseId: string
}

export interface DownloadAssetsResult {
  downloaded: number
  syncedAt: string
  leaseId: string
  snapshotId: string
}

export interface LocalAssetListResult {
  items: AssetListItem[]
  lastSyncedAt: string | null
  scopeLeaseId: string | null
  snapshotId: string | null
}

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

/** Never a server-confirmed audit record (item 7) -- `syncStatus` is always `'local_pending'` in this slice.
 *  `isCurrentSnapshot` is false once the active scope/snapshot has moved on since this was recorded (item 8):
 *  the row is kept, not deleted, but must never be presented as belonging to what's cached right now. */
export interface LocalObservationResult {
  id: string
  scopeLeaseId: string
  snapshotId: string
  assetId: string
  assetCode: string
  observationType: 'verified' | 'missing'
  observedCondition: AssetCondition | null
  matchesCachedCondition: boolean | null
  notes: string | null
  observedAt: string
  syncStatus: 'local_pending'
  isCurrentSnapshot: boolean
}

export interface CreateMaintenanceRequestLocalInput {
  assetId: string
  snapshotId: string
  faultCategory: FaultCategory
  priority: MaintenancePriority
  description: string
}

/** Never a server-confirmed maintenance ticket (item 7) -- distinct from `MaintenanceTicketSummary`/`MaintenanceTicketDetail`
 *  in `@shared/api`, which only exist once a real `maintenance.create` RPC call has run online. */
export interface LocalMaintenanceRequestResult {
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

export const AGENT_CHANNEL_PREFIX = 'bpoam-agent:'
export function agentChannelFor(command: AgentCommandName): string {
  return `${AGENT_CHANNEL_PREFIX}${command}`
}

export interface LocalDeviceRecord {
  id: string
  createdAt: string
}

/** Shape exposed on `window.agent` by the preload script. */
export interface AgentApi {
  device: {
    getLocalDevice(): Promise<LocalDeviceRecord>
  }
  assets: {
    listLocal(): Promise<LocalAssetListResult>
  }
  cloud: {
    listLeases(input: CloudCredentialsInput): Promise<OfflineLeaseView[]>
    downloadLeaseAssets(input: DownloadLeaseAssetsInput): Promise<DownloadAssetsResult>
  }
  observations: {
    verifyItem(input: VerifyItemLocalInput): Promise<LocalObservationResult>
    flagMissing(input: FlagMissingLocalInput): Promise<LocalObservationResult>
    listLocal(): Promise<LocalObservationResult[]>
  }
  maintenance: {
    createLocalRequest(input: CreateMaintenanceRequestLocalInput): Promise<LocalMaintenanceRequestResult>
    listLocal(): Promise<LocalMaintenanceRequestResult[]>
  }
}
