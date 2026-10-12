import { z } from 'zod'
import { MAX_LEASE_HOURS } from './offlineLeases'
import { uuidSchema } from './schemas'

/** Input schemas for W9.2 device enrollment and offline lease commands (strict objects). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)

export const requestDeviceEnrollmentSchema = z.strictObject({
  deviceUuid: z.uuid('Invalid device identifier'),
  deviceName: required(160)
})
export type RequestDeviceEnrollmentInput = z.infer<typeof requestDeviceEnrollmentSchema>

export const approveDeviceSchema = z.strictObject({ deviceId: uuidSchema, trustNotes: required(1000) })
export type ApproveDeviceInput = z.infer<typeof approveDeviceSchema>

export const revokeDeviceSchema = z.strictObject({ deviceId: uuidSchema, reason: required(500) })
export type RevokeDeviceInput = z.infer<typeof revokeDeviceSchema>

export const deviceListSchema = z.strictObject({ mine: z.boolean().default(false) })
export type DeviceListInput = z.infer<typeof deviceListSchema>

const leaseScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('asset'), assetIds: z.array(uuidSchema).min(1).max(200) }),
  z.strictObject({ kind: z.literal('asset_code_range'), count: z.number().int().min(1).max(10000) })
])

export const requestLeaseSchema = z.strictObject({
  deviceId: uuidSchema,
  scope: leaseScopeSchema,
  durationHours: z.number().int().min(1).max(MAX_LEASE_HOURS).default(MAX_LEASE_HOURS)
})
export type RequestLeaseInput = z.infer<typeof requestLeaseSchema>

export const leaseRefSchema = z.strictObject({ leaseId: uuidSchema })
export type LeaseRefInput = z.infer<typeof leaseRefSchema>

export const forceReclaimLeaseSchema = z.strictObject({ leaseId: uuidSchema, reason: required(500) })
export type ForceReclaimLeaseInput = z.infer<typeof forceReclaimLeaseSchema>

export const leaseListSchema = z.strictObject({ mine: z.boolean().default(false) })
export type LeaseListInput = z.infer<typeof leaseListSchema>
