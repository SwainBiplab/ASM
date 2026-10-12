import { z } from 'zod'
import type { OfflineLeaseView, SyncDeviceView } from '@shared/api'
import { DEVICE_STATUSES, LEASE_SCOPE_TYPES, LEASE_STATUSES } from '@shared/offlineLeases'
import type { MaintenanceUploadResult, UploadResult } from '../services/offlineSync'
import { iso, nullable, uuid } from './responses'

/** W9.2 output schemas (D34): checked against the shared DTOs; undeclared fields are stripped. */

export const syncDeviceOutput: z.ZodType<SyncDeviceView> = z.object({
  id: uuid, deviceUuid: z.string(), deviceName: z.string(), ownerUserId: uuid, ownerName: nullable(z.string()),
  status: z.enum(DEVICE_STATUSES), requestedAt: iso, requestedByName: nullable(z.string()),
  trustVerifiedAt: nullable(iso), trustVerifiedByName: nullable(z.string()), trustNotes: nullable(z.string()),
  revokedAt: nullable(iso), revokedByName: nullable(z.string()), revokeReason: nullable(z.string())
})

export const offlineLeaseOutput: z.ZodType<OfflineLeaseView> = z.object({
  id: uuid, deviceId: uuid, deviceName: z.string(), userId: uuid, userName: nullable(z.string()),
  scopeType: z.enum(LEASE_SCOPE_TYPES), status: z.enum(LEASE_STATUSES), fencingEpoch: z.number().int(),
  grantedAt: iso, expiresAt: iso, releasedAt: nullable(iso), reclaimedAt: nullable(iso),
  reclaimedByName: nullable(z.string()), reclaimReason: nullable(z.string()),
  assetIds: z.array(uuid),
  assetCodeRange: nullable(z.object({ prefix: z.string(), separator: z.string(), padding: z.number().int(), formatVersion: z.number().int(), rangeStart: z.number().int(), rangeEnd: z.number().int() }))
})

export const uploadResultOutput: z.ZodType<UploadResult> = z.object({ serverEntityId: uuid, duplicate: z.boolean() })
export const maintenanceUploadResultOutput: z.ZodType<MaintenanceUploadResult> = z.object({ serverEntityId: uuid, duplicate: z.boolean(), ticketNumber: z.string() })
