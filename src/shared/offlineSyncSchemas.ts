import { z } from 'zod'
import { CONDITIONS } from './assets'
import { FAULT_CATEGORIES, MAINTENANCE_PRIORITIES } from './maintenance'
import { uuidSchema } from './schemas'

/**
 * Input schemas for W9.7 offline-sync ingestion commands (strict objects). `clientRecordId` is the
 * local agent's own stable id for the record (minted once, at local creation time) -- it is both
 * the server-side permanent dedup key (`offline_sync_uploads`) and, by convention, the value the
 * agent sends as the HTTP `Idempotency-Key` header, so a retried upload (within or beyond the 24h
 * idempotency-key TTL) can never produce two server entities for the same local record.
 */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))

/** Shared by both upload commands: proves which lease/device/epoch the client believes authorizes
 *  this upload. The server never trusts these values alone -- they are cross-checked against the
 *  real `offline_leases`/`offline_lease_scopes` rows before anything is accepted. */
const uploadAuthoritySchema = {
  clientRecordId: uuidSchema,
  leaseId: uuidSchema,
  deviceId: uuidSchema,
  fencingEpoch: z.number().int().min(1),
  assetId: uuidSchema
}

export const uploadOfflineObservationSchema = z.strictObject({
  ...uploadAuthoritySchema,
  observationType: z.enum(['verified', 'missing']),
  observedCondition: z.enum(CONDITIONS).nullable(),
  notes: optionalText(500),
  clientObservedAt: required(40)
})
export type UploadOfflineObservationInput = z.infer<typeof uploadOfflineObservationSchema>

export const uploadOfflineMaintenanceRequestSchema = z.strictObject({
  ...uploadAuthoritySchema,
  faultCategory: z.enum(FAULT_CATEGORIES),
  priority: z.enum(MAINTENANCE_PRIORITIES),
  description: required(2000),
  clientRequestedAt: required(40)
})
export type UploadOfflineMaintenanceRequestInput = z.infer<typeof uploadOfflineMaintenanceRequestSchema>
