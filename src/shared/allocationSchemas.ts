import { z } from 'zod'
import { ASSIGNMENT_STATUSES, ASSIGNMENT_TARGET_TYPES, INSPECTION_OUTCOMES, RETURN_OUTCOMES } from './allocations'
import { CONDITIONS } from './assets'
import { isoDateSchema } from './orgSchemas'
import { uuidSchema } from './schemas'

/** Input schemas for W4 allocation and exit-clearance commands (strict objects). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))
const paging = {
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
}

export const targetSchema = z.strictObject({ type: z.enum(ASSIGNMENT_TARGET_TYPES), id: uuidSchema })
export type AssignmentTarget = z.infer<typeof targetSchema>

/** On-screen confirmation at handover: who confirmed (recipient or responsible person). */
export const inAppAcknowledgmentSchema = z.strictObject({ acknowledgedByName: required(150) }).nullable()

const handoverLine = z.strictObject({
  assetId: uuidSchema,
  condition: z.enum(CONDITIONS),
  accessories: optionalText(300)
})
const uniqueAssets = <T extends { assetId: string }>(lines: T[]) => new Set(lines.map((l) => l.assetId)).size === lines.length
const handoverLines = z.array(handoverLine).min(1, 'Add at least one asset').max(50, 'At most 50 assets per handover').refine(uniqueAssets, 'The same asset is listed twice')

export const issueInputSchema = z.strictObject({
  target: targetSchema,
  lines: handoverLines,
  /** Physical location after the handover; null keeps each asset's current location. */
  locationId: uuidSchema.nullable(),
  expectedReturnDate: isoDateSchema.nullable(),
  notes: optionalText(1000),
  acknowledgment: inAppAcknowledgmentSchema
})
export type IssueInput = z.input<typeof issueInputSchema>

export const transferInputSchema = z.strictObject({
  target: targetSchema,
  lines: handoverLines,
  locationId: uuidSchema.nullable(),
  expectedReturnDate: isoDateSchema.nullable(),
  reason: required(500),
  acknowledgment: inAppAcknowledgmentSchema
})
export type TransferInput = z.input<typeof transferInputSchema>

export const returnInputSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        assetId: uuidSchema,
        condition: z.enum(CONDITIONS),
        outcome: z.enum(RETURN_OUTCOMES),
        accessoriesReturned: optionalText(300),
        notes: optionalText(300)
      })
    )
    .min(1, 'Add at least one asset')
    .max(50, 'At most 50 assets per return')
    .refine(uniqueAssets, 'The same asset is listed twice'),
  returnLocationId: uuidSchema.nullable(),
  notes: optionalText(1000)
})
export type ReturnInput = z.input<typeof returnInputSchema>

export const inspectInputSchema = z.strictObject({
  assetId: uuidSchema,
  outcome: z.enum(INSPECTION_OUTCOMES),
  condition: z.enum(CONDITIONS),
  notes: required(500)
})
export type InspectInput = z.infer<typeof inspectInputSchema>

/** Explicit loss report for an assigned asset: ends the assignment as lost, visibly and audited. */
export const reportLostInputSchema = z.strictObject({
  assetId: uuidSchema,
  effectiveDate: isoDateSchema,
  reason: required(500)
})
export type ReportLostInput = z.infer<typeof reportLostInputSchema>

export const acknowledgeInputSchema = z.strictObject({ handoverId: uuidSchema, acknowledgedByName: required(150) })
export type AcknowledgeInput = z.infer<typeof acknowledgeInputSchema>

export const handoverRefSchema = z.strictObject({ handoverId: uuidSchema })
export const assetRefSchema = z.strictObject({ assetId: uuidSchema })

export const assignmentListSchema = z.strictObject({
  status: z.enum([...ASSIGNMENT_STATUSES, 'all']).default('active'),
  assetId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  targetType: z.enum(ASSIGNMENT_TARGET_TYPES).optional(),
  overdueOnly: z.boolean().default(false),
  pendingAcknowledgmentOnly: z.boolean().default(false),
  query: z.string().trim().max(100).optional(),
  ...paging
})
export type AssignmentListInput = z.input<typeof assignmentListSchema>

// ---------- Exit clearance ----------

export const openClearanceSchema = z.strictObject({
  employeeId: uuidSchema,
  exitDate: isoDateSchema,
  /** Responsible owner; defaults to the user opening the clearance. */
  ownerUserId: uuidSchema.nullable(),
  notes: optionalText(1000)
})
export type OpenClearanceInput = z.input<typeof openClearanceSchema>

export const clearanceListSchema = z.strictObject({
  status: z.enum(['open', 'closed', 'cancelled', 'all']).default('open'),
  query: z.string().trim().max(100).optional(),
  ...paging
})
export type ClearanceListInput = z.input<typeof clearanceListSchema>

export const clearanceRefSchema = z.strictObject({ clearanceId: uuidSchema })

export const recordClearanceReturnSchema = z.strictObject({
  itemId: uuidSchema,
  condition: z.enum(CONDITIONS),
  outcome: z.enum(RETURN_OUTCOMES),
  returnLocationId: uuidSchema.nullable(),
  notes: optionalText(300)
})
export type RecordClearanceReturnInput = z.input<typeof recordClearanceReturnSchema>

export const flagClearanceItemSchema = z.strictObject({
  itemId: uuidSchema,
  resolution: z.enum(['missing', 'disputed']),
  reason: required(500)
})
export type FlagClearanceItemInput = z.infer<typeof flagClearanceItemSchema>

export const approveExceptionSchema = z.strictObject({ itemId: uuidSchema, decisionNotes: required(1000) })
export type ApproveExceptionInput = z.infer<typeof approveExceptionSchema>

export const closeClearanceSchema = z.strictObject({ clearanceId: uuidSchema, closingNotes: optionalText(1000) })
export type CloseClearanceInput = z.input<typeof closeClearanceSchema>

export const cancelClearanceSchema = z.strictObject({ clearanceId: uuidSchema, reason: required(500) })
export type CancelClearanceInput = z.infer<typeof cancelClearanceSchema>
