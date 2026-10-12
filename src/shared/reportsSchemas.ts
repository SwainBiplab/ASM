import { z } from 'zod'
import { LIFECYCLE_STATUSES } from './assets'
import { isoDateSchema } from './orgSchemas'
import { uuidSchema } from './schemas'
import { WARRANTY_REPORT_FILTERS } from './reports'

/** Input schemas for W7 reporting commands (strict objects). Export queries reuse the same shape, minus paging. */

const paging = { page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(1).max(200).default(50) }
const optionalDate = isoDateSchema.nullable().optional()

export const assetValuationReportSchema = z.strictObject({
  categoryId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  lifecycle: z.enum([...LIFECYCLE_STATUSES, 'all']).default('all'),
  fromDate: optionalDate,
  toDate: optionalDate,
  onlyMissingFinancialMetadata: z.boolean().default(false),
  ...paging
})
export type AssetValuationReportInput = z.input<typeof assetValuationReportSchema>

export const maintenanceCostReportSchema = z.strictObject({
  assetId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  vendorQuery: z.string().trim().max(160).optional(),
  fromDate: optionalDate,
  toDate: optionalDate,
  ...paging
})
export type MaintenanceCostReportInput = z.input<typeof maintenanceCostReportSchema>

export const procurementSummaryReportSchema = z.strictObject({
  fromDate: optionalDate,
  toDate: optionalDate,
  ...paging
})
export type ProcurementSummaryReportInput = z.input<typeof procurementSummaryReportSchema>

export const warrantyReportSchema = z.strictObject({
  filter: z.enum(WARRANTY_REPORT_FILTERS).default('expiring'),
  windowDays: z.number().int().min(1).max(730).optional(),
  ...paging
})
export type WarrantyReportInput = z.input<typeof warrantyReportSchema>

export const disposalReportSchema = z.strictObject({
  fromDate: optionalDate,
  toDate: optionalDate,
  ...paging
})
export type DisposalReportInput = z.input<typeof disposalReportSchema>
