import type { LocalDeviceStore } from '@shared/clientApi'
import { cloudLogin, fetchLeaseScopedAssets, listMyLeases } from './cloudClient'
import type { LocalAssetRepository } from './db/assetsRepository'
import type { LocalMaintenanceRequestRepository } from './db/maintenanceRepository'
import type { LocalObservationRepository } from './db/observationsRepository'
import { LocalScopeError } from './db/scopeGuard'
import type { AgentCommandName } from '../ipcContract'
import { cloudCredentialsSchema, createMaintenanceRequestLocalSchema, downloadLeaseAssetsSchema, flagMissingLocalSchema, verifyItemLocalSchema } from '../validation'

/**
 * The agent's own command dispatcher (W9.3-W9.5) -- deliberately tiny, mirroring the shape of the
 * cloud dispatcher (allow-list → validate → handler) without any of its concerns that don't apply
 * yet (no idempotency, no multi-user sessions). Grows alongside `AGENT_COMMAND_NAMES`. Every input
 * is parsed through a zod schema before use (W9.5): a cast alone gives no protection against a
 * malformed or compromised renderer payload, which is the one real trust boundary this process has.
 */
export function createAgentDispatcher(store: LocalDeviceStore, assets: LocalAssetRepository, observations: LocalObservationRepository, maintenance: LocalMaintenanceRequestRepository) {
  return async function dispatch(command: AgentCommandName, payload: unknown): Promise<unknown> {
    switch (command) {
      case 'device.getLocalDevice':
        return store.getLocalDevice()
      case 'assets.listLocal':
        return assets.list()
      case 'cloud.listLeases': {
        const input = cloudCredentialsSchema.parse(payload)
        const cookie = await cloudLogin(input.baseUrl, input.username, input.password)
        return listMyLeases(input.baseUrl, cookie)
      }
      case 'cloud.downloadLeaseAssets': {
        const input = downloadLeaseAssetsSchema.parse(payload)
        const cookie = await cloudLogin(input.baseUrl, input.username, input.password)
        // Fetched into memory in full before any local write: a login/network/server failure here
        // never touches the database, so the previous complete snapshot is always left intact.
        const items = await fetchLeaseScopedAssets(input.baseUrl, cookie, input.leaseId)
        const syncedAt = new Date().toISOString()
        const { snapshotId } = await assets.replaceAll(input.leaseId, items, syncedAt)
        return { downloaded: items.length, syncedAt, leaseId: input.leaseId, snapshotId }
      }
      case 'observations.verifyItem':
        return toIpcResult(observations.verifyItem(verifyItemLocalSchema.parse(payload)))
      case 'observations.flagMissing':
        return toIpcResult(observations.flagMissing(flagMissingLocalSchema.parse(payload)))
      case 'observations.listLocal':
        return observations.list()
      case 'maintenance.createLocalRequest':
        return toIpcResult(maintenance.create(createMaintenanceRequestLocalSchema.parse(payload)))
      case 'maintenance.listLocal':
        return maintenance.list()
      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown agent command: ${String(_exhaustive)}`)
      }
    }
  }
}

/** Maps a typed `LocalScopeError` (no active scope / stale snapshot / out-of-scope asset) to a plain message; IPC errors cross the bridge as strings only. */
async function toIpcResult<T>(op: Promise<T>): Promise<T> {
  try {
    return await op
  } catch (err) {
    if (err instanceof LocalScopeError) throw new Error(err.message)
    throw err
  }
}
