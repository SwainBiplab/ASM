import type { LeaseScopeType, LeaseStatus } from '@shared/offlineLeases'
import {
  uploadOfflineMaintenanceRequestSchema,
  uploadOfflineObservationSchema,
  type UploadOfflineMaintenanceRequestInput,
  type UploadOfflineObservationInput
} from '@shared/offlineSyncSchemas'
import type { ServerConfig } from '../config'
import { assertPermission, newId, type OpContext } from '../core'
import { pgErrorCode, type Db, type SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { conflict, requireRow } from './common'
import { auditFrom, recordAudit } from './foundation'
import { createTicket, getTicket } from './maintenance'
import { materializeExpiry } from './offlineLeases'

/**
 * W9.7: the first path by which a disconnected desktop agent's locally-pending records become
 * real, server-accepted records. Two independent duplicate-prevention layers (D36's idempotency-key
 * machinery, 24h TTL, plus this module's own permanent `offline_sync_uploads` UNIQUE constraint --
 * a disconnected agent may reconnect long after 24h) and a feature gate that defaults OFF, since
 * neither of this phase's two safety prerequisites is actually resolved yet:
 *  - W-44: the fencing-epoch sequence is not restore-safe.
 *  - W-45: device trust is attestation-only; no business owner has accepted that as sufficient.
 * Enabling `SYNC_UPLOADS_ENABLED` is a deliberate, informed operational decision, not a default.
 */

export interface UploadResult {
  serverEntityId: string
  duplicate: boolean
}

export interface MaintenanceUploadResult extends UploadResult {
  ticketNumber: string
}

function assertSyncEnabled(config: ServerConfig): void {
  if (!config.SYNC_UPLOADS_ENABLED) {
    conflict('Offline sync uploads are not enabled on this server. The restore-safe fencing (W-44) and device-trust (W-45) safety gates have not been resolved/accepted.')
  }
}

interface UploadAuthority {
  clientRecordId: string
  leaseId: string
  deviceId: string
  fencingEpoch: number
  assetId: string
}

/**
 * The actual authorization check (Phase A.4 / B.2-B.3): every value in `input` is client-supplied
 * and none of it is trusted alone. The lease is loaded fresh from the database by `leaseId`, and
 * every other claim (device, epoch, scope membership, user ownership) is cross-checked against that
 * real row -- a mismatch anywhere is rejected, exactly as `getLeaseScopedAssets`/`releaseLease`
 * already do for the same lease-ownership/status checks.
 */
async function assertUploadAuthorized(t: SqlClient, ctx: OpContext, input: UploadAuthority): Promise<void> {
  const org = ctx.actor.organizationId
  await materializeExpiry(t, org)
  const lease = requireRow(
    await t.one<{ userId: string; deviceId: string; status: LeaseStatus; scopeType: LeaseScopeType; fencingEpoch: number }>(
      'SELECT user_id AS "userId", device_id AS "deviceId", status, scope_type AS "scopeType", fencing_epoch AS "fencingEpoch" FROM offline_leases WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.leaseId, org]
    ),
    'Lease'
  )
  // Ownership: a client cannot upload against a lease that isn't its own user's, regardless of what else it supplies.
  if (lease.userId !== ctx.actor.userId) conflict('This lease does not belong to the authenticated user.')
  // Device match: the lease's real device must be the one the client claims uploaded this record.
  if (lease.deviceId !== input.deviceId) conflict('This lease was not granted to the supplied device.')
  if (lease.scopeType !== 'asset') conflict('This lease does not have an asset scope.')
  // Revoked/released/reclaimed leases can never accept an upload -- this is the actual enforcement
  // point for "a revoked or force-reclaimed device cannot upload" (device revocation already forces
  // every held lease to 'reclaimed', so this one check covers that case too, not a separate one).
  if (lease.status !== 'active' && lease.status !== 'expired') conflict(`This lease is ${lease.status}; it can no longer accept uploads.`)
  // Fencing: the client's epoch must match the lease's current one. This rejects a record created
  // under a lease that has since been reclaimed and re-granted (a new lease row gets a new epoch) --
  // it does NOT by itself close the W-44 restore-replay gap (a restored sequence could in principle
  // reissue a stale epoch value); that is exactly why uploads stay behind `SYNC_UPLOADS_ENABLED`.
  if (lease.fencingEpoch !== input.fencingEpoch) conflict('This lease has been reissued since this record was created (fencing epoch mismatch); it can no longer be uploaded.')
  const inScope = await t.one(
    'SELECT 1 FROM offline_lease_scopes WHERE organization_id = $1 AND lease_id = $2 AND asset_id = $3 AND is_active',
    [org, input.leaseId, input.assetId]
  )
  if (!inScope) conflict("This asset is not part of the lease's authorized scope.")
}

async function findExistingUpload(t: SqlClient, org: string, clientRecordId: string): Promise<{ id: string } | undefined> {
  return t.one<{ id: string }>('SELECT server_entity_id AS id FROM offline_sync_uploads WHERE organization_id = $1 AND client_record_id = $2', [org, clientRecordId])
}

/** Records the permanent client-record -> server-entity mapping; a concurrent duplicate insert (the
 *  UNIQUE constraint firing) means another request already recorded it first -- that is a success,
 *  not an error, for the caller to resolve by re-reading the existing mapping. */
async function recordUpload(t: SqlClient, org: string, input: UploadAuthority, recordType: 'observation' | 'maintenance_request', serverEntityType: string, serverEntityId: string, ctx: OpContext): Promise<'inserted' | 'already_recorded'> {
  try {
    await t.exec(
      `INSERT INTO offline_sync_uploads (id, organization_id, client_record_id, record_type, lease_id, device_id, user_id, server_entity_type, server_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId(), org, input.clientRecordId, recordType, input.leaseId, input.deviceId, ctx.actor.userId, serverEntityType, serverEntityId]
    )
    return 'inserted'
  } catch (err) {
    if (pgErrorCode(err) === '23505') return 'already_recorded'
    throw err
  }
}

export async function uploadOfflineObservation(db: Db, raw: UploadOfflineObservationInput, ctx: OpContext, config: ServerConfig): Promise<UploadResult> {
  assertSyncEnabled(config)
  assertPermission(ctx.actor.permissions, 'audits.verify')
  const input = uploadOfflineObservationSchema.parse(raw)
  const org = ctx.actor.organizationId

  const existing = await findExistingUpload(db, org, input.clientRecordId)
  if (existing) return { serverEntityId: existing.id, duplicate: true }

  await assertUploadAuthorized(db, ctx, input)
  const asset = requireRow(await db.one<{ condition: string }>('SELECT condition FROM assets WHERE id = $1 AND organization_id = $2', [input.assetId, org]), 'Asset')
  const matches = input.observationType === 'verified' && input.observedCondition !== null ? input.observedCondition === asset.condition : null

  const recordId = newId()
  await db.exec(
    `INSERT INTO offline_observation_records (id, organization_id, lease_id, device_id, user_id, asset_id, observation_type, observed_condition, matches_expected_condition, notes, client_observed_at, fencing_epoch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [recordId, org, input.leaseId, input.deviceId, ctx.actor.userId, input.assetId, input.observationType, input.observedCondition, matches, input.notes, input.clientObservedAt, input.fencingEpoch]
  )
  const outcome = await recordUpload(db, org, input, 'observation', 'offline_observation_record', recordId, ctx)
  if (outcome === 'already_recorded') {
    const row = requireRow(await findExistingUpload(db, org, input.clientRecordId), 'Upload')
    return { serverEntityId: row.id, duplicate: true }
  }
  await recordAudit(db, {
    ...auditFrom(ctx), eventType: 'offline.observation_synced', entityType: 'offline_observation_record', entityId: recordId,
    summary: { leaseId: input.leaseId, deviceId: input.deviceId, assetId: input.assetId, observationType: input.observationType }
  })
  return { serverEntityId: recordId, duplicate: false }
}

export async function uploadOfflineMaintenanceRequest(db: Db, storage: DocumentStorage, raw: UploadOfflineMaintenanceRequestInput, ctx: OpContext, config: ServerConfig): Promise<MaintenanceUploadResult> {
  assertSyncEnabled(config)
  const input = uploadOfflineMaintenanceRequestSchema.parse(raw)
  const org = ctx.actor.organizationId

  const existing = await findExistingUpload(db, org, input.clientRecordId)
  if (existing) {
    const ticket = await getTicket(db, storage, existing.id, ctx, true)
    return { serverEntityId: existing.id, ticketNumber: ticket.ticketNumber, duplicate: true }
  }

  await assertUploadAuthorized(db, ctx, input)
  // Reuses the real, authoritative service (item 1): the same permission check (`maintenance.create`),
  // the same duplicate-open-ticket guard, the same audit trail as an online fault report -- nothing
  // about ticket creation itself is reimplemented for the offline path.
  const ticket = await createTicket(
    db,
    storage,
    {
      assetId: input.assetId, category: input.faultCategory, priority: input.priority, description: input.description,
      targetResolutionDate: null, assignedTechnicianId: null, vendorName: null, vendorReference: null, forceAdditional: false, justification: null
    },
    ctx,
    input.leaseId
  )
  const outcome = await recordUpload(db, org, input, 'maintenance_request', 'maintenance_ticket', ticket.id, ctx)
  if (outcome === 'already_recorded') {
    const row = requireRow(await findExistingUpload(db, org, input.clientRecordId), 'Upload')
    const existingTicket = await getTicket(db, storage, row.id, ctx, true)
    return { serverEntityId: row.id, ticketNumber: existingTicket.ticketNumber, duplicate: true }
  }
  return { serverEntityId: ticket.id, ticketNumber: ticket.ticketNumber, duplicate: false }
}
