import { z } from 'zod'
import { CONDITIONS } from './assets'
import { uuidSchema } from './schemas'

/** Input schemas for W5 physical-audit commands (strict objects). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))
const paging = { page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(1).max(200).default(50) }

/** At least one scoping filter, or an explicit asset list, is required. */
export const auditScopeSchema = z
  .strictObject({
    locationId: uuidSchema.nullable(),
    categoryId: uuidSchema.nullable(),
    custodianEmployeeId: uuidSchema.nullable(),
    assetIds: z.array(uuidSchema).max(2000).nullable()
  })
  .refine((s) => s.locationId !== null || s.categoryId !== null || s.custodianEmployeeId !== null || (s.assetIds !== null && s.assetIds.length > 0), {
    message: 'Choose a location, category, custodian or specific assets',
    path: ['locationId']
  })
export type AuditScope = z.infer<typeof auditScopeSchema>

export const createAuditSchema = z.strictObject({
  title: required(160),
  scope: auditScopeSchema,
  responsibleUserId: uuidSchema.nullable(),
  notes: optionalText(1000)
})
export type CreateAuditInput = z.input<typeof createAuditSchema>

export const auditRefSchema = z.strictObject({ auditId: uuidSchema })

export const auditListSchema = z.strictObject({
  status: z.enum(['open', 'closed', 'cancelled', 'all']).default('open'),
  query: z.string().trim().max(100).optional(),
  ...paging
})
/** Named to avoid clashing with the audit-log `AuditListInput` (admin trail, singular `audit.list`). */
export type PhysicalAuditListInput = z.input<typeof auditListSchema>

export const auditItemListSchema = z.strictObject({
  auditId: uuidSchema,
  status: z.enum(['pending', 'verified', 'discrepancy_open', 'investigating', 'resolved', 'accepted', 'all']).default('all'),
  query: z.string().trim().max(100).optional(),
  ...paging
})
export type AuditItemListInput = z.input<typeof auditItemListSchema>

/** The core scan/lookup action: a scan confirms an observation, never a direct edit (TAS §13). */
export const verifyItemSchema = z.strictObject({
  auditId: uuidSchema,
  assetId: uuidSchema,
  observedLocationId: uuidSchema.nullable(),
  observedCondition: z.enum(CONDITIONS),
  identificationMismatch: z.boolean().default(false),
  notes: optionalText(500)
})
export type VerifyItemInput = z.infer<typeof verifyItemSchema>

export const flagMissingSchema = z.strictObject({ itemId: uuidSchema, notes: required(500) })
export type FlagMissingInput = z.infer<typeof flagMissingSchema>

export const assignDiscrepancySchema = z.strictObject({ itemId: uuidSchema, assignedToUserId: uuidSchema, notes: optionalText(500) })
export type AssignDiscrepancyInput = z.infer<typeof assignDiscrepancySchema>

export const resolveDiscrepancySchema = z.strictObject({ itemId: uuidSchema, resolutionNotes: required(1000) })
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>

export const correctLocationSchema = z.strictObject({ itemId: uuidSchema, newLocationId: uuidSchema, reason: required(500) })
export type CorrectLocationInput = z.infer<typeof correctLocationSchema>

export const acceptExceptionSchema = z.strictObject({ itemId: uuidSchema, decisionNotes: required(1000) })
export type AcceptExceptionInput = z.infer<typeof acceptExceptionSchema>

export const closeAuditSchema = z.strictObject({ auditId: uuidSchema, closingNotes: optionalText(1000) })
export type CloseAuditInput = z.input<typeof closeAuditSchema>

export const cancelAuditSchema = z.strictObject({ auditId: uuidSchema, reason: required(500) })
export type CancelAuditInput = z.infer<typeof cancelAuditSchema>
