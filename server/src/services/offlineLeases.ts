import type { DeviceStatus, LeaseScopeType, LeaseStatus } from '@shared/offlineLeases'
import {
  approveDeviceSchema,
  deviceListSchema,
  forceReclaimLeaseSchema,
  leaseListSchema,
  leaseRefSchema,
  requestDeviceEnrollmentSchema,
  requestLeaseSchema,
  revokeDeviceSchema,
  type ApproveDeviceInput,
  type DeviceListInput,
  type ForceReclaimLeaseInput,
  type LeaseListInput,
  type LeaseRefInput,
  type RequestDeviceEnrollmentInput,
  type RequestLeaseInput,
  type RevokeDeviceInput
} from '@shared/offlineLeasesSchemas'
import type { AssetListItem } from '@shared/api'
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import { pgErrorCode, type Db, type SqlClient } from '../db/sql'
import { conflict, requireRow } from './common'
import { auditFrom, recordAudit } from './foundation'
import { LIST_COLUMNS, LIST_FROM, reserveAssetCodeRange, withPaths, type ListRow } from './assets'

/**
 * W9.2 server-side foundations for the offline desktop agent (TAS W9 §4/§8, DECISIONS.md D48/D49).
 * Device enrollment uses human administrator attestation (D49/B), not a self-reported client flag.
 * Leases are exclusive reservations enforced by a PostgreSQL partial unique index
 * (`one_active_lease_per_asset`); the online-write block in `assertAssetsNotLeased` below is the
 * other half -- together they guarantee an asset can never be mutated both online and offline at
 * once. No synchronization protocol, local outbox or offline command execution exists yet: a
 * granted lease is a safe reservation that a future desktop agent will consume, not something a
 * client can act on today.
 */

export interface SyncDeviceView {
  id: string
  deviceUuid: string
  deviceName: string
  ownerUserId: string
  ownerName: string | null
  status: DeviceStatus
  requestedAt: string
  requestedByName: string | null
  trustVerifiedAt: string | null
  trustVerifiedByName: string | null
  trustNotes: string | null
  revokedAt: string | null
  revokedByName: string | null
  revokeReason: string | null
}

export interface OfflineLeaseView {
  id: string
  deviceId: string
  deviceName: string
  userId: string
  userName: string | null
  scopeType: LeaseScopeType
  status: LeaseStatus
  fencingEpoch: number
  grantedAt: string
  expiresAt: string
  releasedAt: string | null
  reclaimedAt: string | null
  reclaimedByName: string | null
  reclaimReason: string | null
  assetIds: string[]
  assetCodeRange: { prefix: string; separator: string; padding: number; formatVersion: number; rangeStart: number; rangeEnd: number } | null
}

// ------------------------------------------------------------------ devices

const DEVICE_SELECT = `
  SELECT d.id, d.device_uuid AS "deviceUuid", d.device_name AS "deviceName", d.owner_user_id AS "ownerUserId", ou.display_name AS "ownerName",
         d.status, d.requested_at AS "requestedAt", ru.display_name AS "requestedByName",
         d.trust_verified_at AS "trustVerifiedAt", vu.display_name AS "trustVerifiedByName", d.trust_notes AS "trustNotes",
         d.revoked_at AS "revokedAt", xu.display_name AS "revokedByName", d.revoke_reason AS "revokeReason"
  FROM sync_devices d
  JOIN users ou ON ou.id = d.owner_user_id
  JOIN users ru ON ru.id = d.requested_by
  LEFT JOIN users vu ON vu.id = d.trust_verified_by
  LEFT JOIN users xu ON xu.id = d.revoked_by`

async function getDevice(c: SqlClient, org: string, deviceId: string): Promise<SyncDeviceView> {
  return requireRow(await c.one<SyncDeviceView>(`${DEVICE_SELECT} WHERE d.organization_id = $1 AND d.id = $2`, [org, deviceId]), 'Device')
}

export async function requestDeviceEnrollment(db: Db, raw: RequestDeviceEnrollmentInput, ctx: OpContext): Promise<SyncDeviceView> {
  assertPermission(ctx.actor.permissions, 'leases.manage')
  const input = requestDeviceEnrollmentSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    try {
      await t.exec(
        'INSERT INTO sync_devices (id, organization_id, device_uuid, device_name, owner_user_id, requested_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, org, input.deviceUuid, input.deviceName, ctx.actor.userId, ctx.actor.userId]
      )
    } catch (err) {
      if (pgErrorCode(err) === '23505') conflict('This device is already enrolled.')
      throw err
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'device.enrollment_requested', entityType: 'sync_device', entityId: id, summary: { deviceName: input.deviceName } })
    return getDevice(t, org, id)
  })
}

export async function approveDevice(db: Db, raw: ApproveDeviceInput, ctx: OpContext): Promise<SyncDeviceView> {
  assertPermission(ctx.actor.permissions, 'devices.manage')
  const input = approveDeviceSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const d = requireRow(await t.one<{ status: DeviceStatus }>('SELECT status FROM sync_devices WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.deviceId, org]), 'Device')
    if (d.status !== 'pending') conflict(d.status === 'active' ? 'This device is already approved.' : 'A revoked device cannot be re-approved; enroll it again.')
    await t.exec('UPDATE sync_devices SET status = \'active\', trust_verified_at = now(), trust_verified_by = $2, trust_notes = $3, updated_at = now() WHERE id = $1', [
      input.deviceId, ctx.actor.userId, input.trustNotes
    ])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'device.approved', entityType: 'sync_device', entityId: input.deviceId, summary: { trustNotes: input.trustNotes } })
    return getDevice(t, org, input.deviceId)
  })
}

export async function revokeDevice(db: Db, raw: RevokeDeviceInput, ctx: OpContext): Promise<SyncDeviceView> {
  assertPermission(ctx.actor.permissions, 'devices.manage')
  const input = revokeDeviceSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const d = requireRow(await t.one<{ status: DeviceStatus }>('SELECT status FROM sync_devices WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.deviceId, org]), 'Device')
    if (d.status === 'revoked') conflict('This device is already revoked.')
    await t.exec("UPDATE sync_devices SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3, updated_at = now() WHERE id = $1", [
      input.deviceId, ctx.actor.userId, input.reason
    ])
    // A revoked device can no longer be trusted to hold a lease: there is no live connection to push
    // a revoke signal to, so any lease it still holds is force-reclaimed here instead (D49).
    const leases = await t.many<{ id: string }>("SELECT id FROM offline_leases WHERE organization_id = $1 AND device_id = $2 AND status IN ('active', 'expired') FOR UPDATE", [org, input.deviceId])
    for (const lease of leases) {
      await t.exec("UPDATE offline_leases SET status = 'reclaimed', reclaimed_at = now(), reclaimed_by = $2, reclaim_reason = $3, updated_at = now() WHERE id = $1", [
        lease.id, ctx.actor.userId, `Device revoked: ${input.reason}`
      ])
      await t.exec('UPDATE offline_lease_scopes SET is_active = false WHERE lease_id = $1', [lease.id])
    }
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'device.revoked', entityType: 'sync_device', entityId: input.deviceId, reason: input.reason,
      summary: { leasesReclaimed: leases.length }
    })
    return getDevice(t, org, input.deviceId)
  })
}

export async function listDevices(db: Db, raw: DeviceListInput, ctx: OpContext): Promise<SyncDeviceView[]> {
  assertAnyPermission(ctx, ['leases.manage', 'devices.manage'])
  const input = deviceListSchema.parse(raw)
  const org = ctx.actor.organizationId
  const canSeeAll = ctx.actor.permissions.has('devices.manage')
  const mine = input.mine || !canSeeAll
  const where = mine ? `${DEVICE_SELECT} WHERE d.organization_id = $1 AND d.owner_user_id = $2` : `${DEVICE_SELECT} WHERE d.organization_id = $1`
  const params = mine ? [org, ctx.actor.userId] : [org]
  return db.many<SyncDeviceView>(`${where} ORDER BY d.requested_at DESC`, params)
}

// ------------------------------------------------------------------ leases

const LEASE_SELECT = `
  SELECT l.id, l.device_id AS "deviceId", d.device_name AS "deviceName", l.user_id AS "userId", u.display_name AS "userName",
         l.scope_type AS "scopeType", l.status, l.fencing_epoch AS "fencingEpoch", l.granted_at AS "grantedAt", l.expires_at AS "expiresAt",
         l.released_at AS "releasedAt", l.reclaimed_at AS "reclaimedAt", ru.display_name AS "reclaimedByName", l.reclaim_reason AS "reclaimReason"
  FROM offline_leases l
  JOIN sync_devices d ON d.id = l.device_id
  JOIN users u ON u.id = l.user_id
  LEFT JOIN users ru ON ru.id = l.reclaimed_by`

type LeaseRow = Omit<OfflineLeaseView, 'assetIds' | 'assetCodeRange'>

async function hydrateLease(c: SqlClient, row: LeaseRow): Promise<OfflineLeaseView> {
  const assetIds = (await c.many<{ assetId: string }>('SELECT asset_id AS "assetId" FROM offline_lease_scopes WHERE lease_id = $1 AND asset_id IS NOT NULL', [row.id])).map((r) => r.assetId)
  const range = await c.one<{ prefix: string; separator: string; padding: number; formatVersion: number; rangeStart: number; rangeEnd: number }>(
    'SELECT prefix, separator, padding, format_version AS "formatVersion", range_start AS "rangeStart", range_end AS "rangeEnd" FROM asset_code_reservations WHERE lease_id = $1',
    [row.id]
  )
  return { ...row, assetIds, assetCodeRange: range ?? null }
}

async function getLease(c: SqlClient, org: string, leaseId: string): Promise<OfflineLeaseView> {
  const row = requireRow(await c.one<LeaseRow>(`${LEASE_SELECT} WHERE l.organization_id = $1 AND l.id = $2`, [org, leaseId]), 'Lease')
  return hydrateLease(c, row)
}

/** Lazily transitions timed-out active leases to `expired`. Expiry never clears `is_active` on the
 * leased scopes (D49: "expiry does not automatically release the reservation") -- only an explicit
 * release or reclaim does that. */
export async function materializeExpiry(t: SqlClient, org: string): Promise<void> {
  await t.exec("UPDATE offline_leases SET status = 'expired', updated_at = now() WHERE organization_id = $1 AND status = 'active' AND expires_at < now()", [org])
}

/**
 * The C1 enforcement choke point: called from every online mutation entry point that touches an
 * asset (allocations' lockAssets, assets.changeLifecycle, maintenance's createTicket/closeTicket,
 * audits.correctLocation). Blocks unconditionally, including for the lease's own holder acting
 * through the browser -- otherwise the holder could race their own not-yet-synced offline work.
 *
 * `allowLeaseId` (W9.7) is the one deliberate exception: a synced record (`offlineSync.ts`) IS an
 * action already authorized by that specific lease, so it must not be blocked by the very lease
 * that authorized it. No other caller passes this -- every other call site still blocks every
 * active lease unconditionally, so this never weakens the guard for an ordinary online actor.
 */
export async function assertAssetsNotLeased(t: SqlClient, org: string, assetIds: string[], allowLeaseId?: string): Promise<void> {
  if (!assetIds.length) return
  const row = await t.one<{ code: string }>(
    `SELECT a.asset_code AS code FROM offline_lease_scopes s JOIN assets a ON a.id = s.asset_id
     WHERE s.organization_id = $1 AND s.is_active AND s.asset_id = ANY($2::uuid[]) AND s.lease_id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid) LIMIT 1`,
    [org, assetIds, allowLeaseId ?? null]
  )
  if (row) conflict(`${row.code} is held by an active offline lease and cannot be changed online until the lease is released or reclaimed.`)
}

/**
 * W9.5: the only way a desktop agent may download a work-package inventory. Deliberately takes a
 * `leaseId`, never a client-supplied asset list -- the actual authorized set is always derived
 * here, from the real lease and its `offline_lease_scopes` rows, never trusted from the caller.
 * A lease belonging to a different user is rejected the same way `releaseLease`/`forceReclaimLease`
 * already guard ownership, so one device can never obtain another device's leased inventory by
 * changing `leaseId` in the request -- it would simply fail the ownership check below.
 */
export async function getLeaseScopedAssets(db: Db, raw: LeaseRefInput, ctx: OpContext): Promise<AssetListItem[]> {
  assertPermission(ctx.actor.permissions, 'leases.manage')
  const input = leaseRefSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    await materializeExpiry(t, org)
    const lease = requireRow(
      await t.one<{ userId: string; status: LeaseStatus; scopeType: LeaseScopeType }>(
        'SELECT user_id AS "userId", status, scope_type AS "scopeType" FROM offline_leases WHERE id = $1 AND organization_id = $2',
        [input.leaseId, org]
      ),
      'Lease'
    )
    if (lease.userId !== ctx.actor.userId) throw new AppError('PERMISSION_DENIED', 'This lease belongs to a different user.')
    if (lease.scopeType !== 'asset') conflict('This lease does not have an asset scope.')
    if (lease.status !== 'active' && lease.status !== 'expired') conflict(`This lease is ${lease.status}; its asset scope is no longer available for download.`)
    const assetIds = (
      await t.many<{ assetId: string }>('SELECT asset_id AS "assetId" FROM offline_lease_scopes WHERE organization_id = $1 AND lease_id = $2 AND is_active AND asset_id IS NOT NULL', [
        org,
        input.leaseId
      ])
    ).map((r) => r.assetId)
    if (!assetIds.length) return []
    const rows = await t.many<ListRow>(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE a.organization_id = $1 AND a.id = ANY($2::uuid[]) ORDER BY a.asset_code`, [org, assetIds])
    return withPaths(t, ctx, rows)
  })
}

async function lockDeviceForLease(t: SqlClient, org: string, deviceId: string, userId: string): Promise<void> {
  const d = requireRow(
    await t.one<{ status: DeviceStatus; ownerUserId: string }>('SELECT status, owner_user_id AS "ownerUserId" FROM sync_devices WHERE id = $1 AND organization_id = $2 FOR UPDATE', [deviceId, org]),
    'Device'
  )
  if (d.ownerUserId !== userId) conflict('This device is enrolled to a different user.')
  if (d.status !== 'active') conflict(d.status === 'pending' ? 'This device has not been approved for offline use yet.' : 'This device has been revoked and cannot hold a lease.')
}

export async function requestLease(db: Db, raw: RequestLeaseInput, ctx: OpContext): Promise<OfflineLeaseView> {
  assertPermission(ctx.actor.permissions, 'leases.manage')
  const input = requestLeaseSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    await materializeExpiry(t, org)
    await lockDeviceForLease(t, org, input.deviceId, ctx.actor.userId)
    const id = newId()
    const epoch = (await t.one<{ n: number }>("SELECT nextval('fencing_epoch_seq') AS n"))!.n
    const expiresAt = new Date(Date.now() + input.durationHours * 3_600_000).toISOString()
    await t.exec(
      'INSERT INTO offline_leases (id, organization_id, device_id, user_id, scope_type, fencing_epoch, granted_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, org, input.deviceId, ctx.actor.userId, input.scope.kind, epoch, ctx.actor.userId, expiresAt]
    )
    if (input.scope.kind === 'asset') {
      const assets = await t.many<{ id: string; code: string }>(
        'SELECT id, asset_code AS code FROM assets WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [org, input.scope.assetIds]
      )
      if (assets.length !== input.scope.assetIds.length) throw new AppError('NOT_FOUND', 'One or more assets were not found.')
      for (const a of assets) {
        try {
          await t.exec('INSERT INTO offline_lease_scopes (id, organization_id, lease_id, asset_id) VALUES ($1, $2, $3, $4)', [newId(), org, id, a.id])
        } catch (err) {
          if (pgErrorCode(err) === '23505') conflict(`${a.code} is already held by another active offline lease.`)
          throw err
        }
      }
    } else {
      // asset_code_range: locks the same asset_code_config row normal issuance and format changes
      // lock (D49/D), so a range reservation can never race them.
      const reservation = await reserveAssetCodeRange(t, org, input.scope.count)
      await t.exec('INSERT INTO offline_lease_scopes (id, organization_id, lease_id, asset_id) VALUES ($1, $2, $3, NULL)', [newId(), org, id])
      await t.exec(
        'INSERT INTO asset_code_reservations (id, organization_id, lease_id, format_version, prefix, separator, padding, range_start, range_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [newId(), org, id, reservation.formatVersion, reservation.format.prefix, reservation.format.separator, reservation.format.padding, reservation.rangeStart, reservation.rangeEnd]
      )
    }
    await recordAudit(t, {
      ...auditFrom(ctx), eventType: 'lease.granted', entityType: 'offline_lease', entityId: id,
      summary: { deviceId: input.deviceId, scopeType: input.scope.kind, durationHours: input.durationHours, fencingEpoch: epoch }
    })
    return getLease(t, org, id)
  })
}

async function lockLease(t: SqlClient, org: string, leaseId: string): Promise<{ userId: string; status: LeaseStatus }> {
  return requireRow(
    await t.one<{ userId: string; status: LeaseStatus }>('SELECT user_id AS "userId", status FROM offline_leases WHERE id = $1 AND organization_id = $2 FOR UPDATE', [leaseId, org]),
    'Lease'
  )
}

async function deactivateScopes(t: SqlClient, leaseId: string): Promise<void> {
  await t.exec('UPDATE offline_lease_scopes SET is_active = false WHERE lease_id = $1', [leaseId])
}

export async function releaseLease(db: Db, raw: LeaseRefInput, ctx: OpContext): Promise<OfflineLeaseView> {
  assertPermission(ctx.actor.permissions, 'leases.manage')
  const input = leaseRefSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    await materializeExpiry(t, org)
    const lease = await lockLease(t, org, input.leaseId)
    if (lease.userId !== ctx.actor.userId && !ctx.actor.permissions.has('devices.manage')) throw new AppError('PERMISSION_DENIED', 'You can only release your own offline lease.')
    if (lease.status !== 'active' && lease.status !== 'expired') conflict(`This lease is already ${lease.status}.`)
    await t.exec('UPDATE offline_leases SET status = \'released\', released_at = now(), released_by = $2, updated_at = now() WHERE id = $1', [input.leaseId, ctx.actor.userId])
    await deactivateScopes(t, input.leaseId)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'lease.released', entityType: 'offline_lease', entityId: input.leaseId, summary: {} })
    return getLease(t, org, input.leaseId)
  })
}

export async function forceReclaimLease(db: Db, raw: ForceReclaimLeaseInput, ctx: OpContext): Promise<OfflineLeaseView> {
  assertPermission(ctx.actor.permissions, 'leases.force_reclaim')
  const input = forceReclaimLeaseSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    await materializeExpiry(t, org)
    const lease = await lockLease(t, org, input.leaseId)
    // D49/E: the device's own user can never be the recovery authority for their own lease.
    if (lease.userId === ctx.actor.userId) throw new AppError('PERMISSION_DENIED', 'You cannot force-reclaim your own offline lease. Release it instead, or ask another recovery authority.')
    if (lease.status !== 'active' && lease.status !== 'expired') conflict(`This lease is already ${lease.status}.`)
    await t.exec('UPDATE offline_leases SET status = \'reclaimed\', reclaimed_at = now(), reclaimed_by = $2, reclaim_reason = $3, updated_at = now() WHERE id = $1', [
      input.leaseId, ctx.actor.userId, input.reason
    ])
    await deactivateScopes(t, input.leaseId)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'lease.force_reclaimed', entityType: 'offline_lease', entityId: input.leaseId, reason: input.reason, summary: {} })
    return getLease(t, org, input.leaseId)
  })
}

export async function listLeases(db: Db, raw: LeaseListInput, ctx: OpContext): Promise<OfflineLeaseView[]> {
  assertAnyPermission(ctx, ['leases.manage', 'leases.force_reclaim', 'devices.manage'])
  const input = leaseListSchema.parse(raw)
  const org = ctx.actor.organizationId
  const canSeeAll = ctx.actor.permissions.has('leases.force_reclaim') || ctx.actor.permissions.has('devices.manage')
  const mine = input.mine || !canSeeAll
  return db.tx(async (t) => {
    await materializeExpiry(t, org)
    const where = mine ? `${LEASE_SELECT} WHERE l.organization_id = $1 AND l.user_id = $2` : `${LEASE_SELECT} WHERE l.organization_id = $1`
    const params = mine ? [org, ctx.actor.userId] : [org]
    const rows = await t.many<LeaseRow>(`${where} ORDER BY l.granted_at DESC`, params)
    return Promise.all(rows.map((r) => hydrateLease(t, r)))
  })
}
