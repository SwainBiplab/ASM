import { z } from 'zod'
import { FAULT_CATEGORIES, MAINTENANCE_PRIORITIES } from './maintenance'
import { RETURN_OUTCOMES } from './allocations'
import { isoDateSchema } from './orgSchemas'
import { uuidSchema } from './schemas'

/** Input schemas for W5 maintenance-ticket commands (strict objects). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))
const moneyText = z
  .string()
  .trim()
  .max(20)
  .nullable()
  .transform((v) => (v === '' || v === null ? null : v))
const minutes = z.number().int().min(0).max(1_000_000).nullable()
const paging = { page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(1).max(200).default(50) }

export const createTicketSchema = z.strictObject({
  assetId: uuidSchema,
  category: z.enum(FAULT_CATEGORIES),
  priority: z.enum(MAINTENANCE_PRIORITIES),
  description: required(2000),
  targetResolutionDate: isoDateSchema.nullable(),
  assignedTechnicianId: uuidSchema.nullable(),
  vendorName: optionalText(160),
  vendorReference: optionalText(80),
  /** Opens a second concurrent ticket for an asset that already has one open; needs a stated reason. */
  forceAdditional: z.boolean().default(false),
  justification: optionalText(500)
})
export type CreateTicketInput = z.input<typeof createTicketSchema>

export const assignTicketSchema = z.strictObject({ ticketId: uuidSchema, assignedTechnicianId: uuidSchema, notes: optionalText(500) })
export type AssignTicketInput = z.infer<typeof assignTicketSchema>

/** Full replace, like `assets.update`: the browser resends every field, not a sparse patch. */
export const updateTicketSchema = z.strictObject({
  ticketId: uuidSchema,
  priority: z.enum(MAINTENANCE_PRIORITIES),
  description: required(2000),
  diagnosis: optionalText(2000),
  workPerformed: optionalText(2000),
  vendorName: optionalText(160),
  vendorReference: optionalText(80),
  partsCost: moneyText,
  laborCost: moneyText,
  downtimeMinutes: minutes,
  targetResolutionDate: isoDateSchema.nullable(),
  notes: optionalText(500)
})
export type UpdateTicketInput = z.input<typeof updateTicketSchema>

export const resolveTicketSchema = z.strictObject({
  ticketId: uuidSchema,
  diagnosis: required(2000),
  workPerformed: required(2000),
  downtimeMinutes: minutes,
  notes: optionalText(500)
})
export type ResolveTicketInput = z.input<typeof resolveTicketSchema>

export const closeTicketSchema = z.strictObject({
  ticketId: uuidSchema,
  resultOutcome: z.enum(RETURN_OUTCOMES),
  closingNotes: required(1000)
})
export type CloseTicketInput = z.infer<typeof closeTicketSchema>

export const cancelTicketSchema = z.strictObject({ ticketId: uuidSchema, reason: required(500) })
export type CancelTicketInput = z.infer<typeof cancelTicketSchema>

export const ticketRefSchema = z.strictObject({ ticketId: uuidSchema })

export const ticketListSchema = z.strictObject({
  assetId: uuidSchema.optional(),
  status: z.enum(['open', 'in_progress', 'resolved', 'closed', 'cancelled', 'all']).default('all'),
  priority: z.enum(MAINTENANCE_PRIORITIES).optional(),
  assignedTechnicianId: uuidSchema.optional(),
  openOnly: z.boolean().default(false),
  overdueOnly: z.boolean().default(false),
  query: z.string().trim().max(100).optional(),
  ...paging
})
export type TicketListInput = z.input<typeof ticketListSchema>
