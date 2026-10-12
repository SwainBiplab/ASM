import { z } from 'zod'
import { CONDITIONS } from '@shared/assets'
import { FAULT_CATEGORIES, MAINTENANCE_PRIORITIES } from '@shared/maintenance'

/**
 * Runtime validation for the agent's own IPC inputs (W9.5 adds this; earlier commands only had a
 * compile-time cast, which gives no protection against a malformed or malicious renderer payload --
 * worth fixing for every new command, since the preload bridge is the one trust boundary here).
 */

const uuidish = z.string().trim().min(1).max(200)
const required = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))

export const cloudCredentialsSchema = z.strictObject({
  baseUrl: z.string().trim().min(1).max(500),
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200)
})

export const downloadLeaseAssetsSchema = cloudCredentialsSchema.extend({ leaseId: uuidish })

export const verifyItemLocalSchema = z.strictObject({
  assetId: uuidish,
  snapshotId: uuidish,
  observedCondition: z.enum(CONDITIONS),
  notes: required(500)
})

export const flagMissingLocalSchema = z.strictObject({
  assetId: uuidish,
  snapshotId: uuidish,
  notes: z.string().trim().min(1, 'Required').max(500)
})

export const createMaintenanceRequestLocalSchema = z.strictObject({
  assetId: uuidish,
  snapshotId: uuidish,
  faultCategory: z.enum(FAULT_CATEGORIES),
  priority: z.enum(MAINTENANCE_PRIORITIES),
  description: z.string().trim().min(1, 'Required').max(2000)
})
