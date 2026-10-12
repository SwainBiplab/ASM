import { z } from 'zod'
import {
  ASSET_DOMAINS,
  ASSET_SORTS,
  CONDITIONS,
  DISPOSAL_METHODS,
  DOCUMENT_OWNER_TYPES,
  DOCUMENT_PURPOSES,
  LIFECYCLE_STATUSES,
  MANUAL_OPERATIONAL_STATUSES,
  OPERATIONAL_STATUSES,
  TRACKING_MODES,
  WARRANTY_FILTERS
} from './assets'
import { isoDateSchema } from './orgSchemas'
import { uuidSchema } from './schemas'

/** Input schemas for M3 asset-register commands (strict objects; unknown keys rejected). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))
const CODE_RE = /^[A-Za-z0-9._/-]+$/
const CODE_MSG = 'Use letters, digits, dot, slash, underscore or hyphen'
const optionalDate = isoDateSchema.nullable()
const optionalId = uuidSchema.nullable()
/** Money arrives as a decimal string and is converted to integer minor units by the service. */
const moneyText = z
  .string()
  .trim()
  .max(20)
  .nullable()
  .transform((v) => (v === '' || v === null ? null : v))

export const catalogListSchema = z
  .strictObject({ includeInactive: z.boolean().default(false), search: z.string().trim().max(100).optional(), categoryId: uuidSchema.optional() })
  .default({ includeInactive: false })
export type CatalogListInput = z.input<typeof catalogListSchema>

const categoryFields = {
  code: required(20).regex(CODE_RE, CODE_MSG),
  name: required(120),
  description: optionalText(500),
  assetDomain: z.enum(ASSET_DOMAINS),
  trackingMode: z.enum(TRACKING_MODES),
  serialRequired: z.boolean(),
  serialUnique: z.boolean()
}
export const createCategorySchema = z.strictObject(categoryFields)
export const updateCategorySchema = z.strictObject({ id: uuidSchema, ...categoryFields })
export type CreateCategoryInput = z.input<typeof createCategorySchema>
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>

const modelFields = {
  categoryId: uuidSchema,
  manufacturer: required(120),
  modelName: required(120),
  modelNumber: optionalText(80),
  specifications: optionalText(2000)
}
export const createModelSchema = z.strictObject(modelFields)
export const updateModelSchema = z.strictObject({ id: uuidSchema, ...modelFields })
export type CreateModelInput = z.input<typeof createModelSchema>
export type UpdateModelInput = z.input<typeof updateModelSchema>

const supplierFields = {
  code: optionalText(30).refine((v) => v === null || CODE_RE.test(v), CODE_MSG),
  name: required(160),
  contactName: optionalText(120),
  email: optionalText(254).refine((v) => v === null || z.email().safeParse(v).success, 'Enter a valid email address'),
  phone: optionalText(30).refine((v) => v === null || /^[0-9+()\-\s.]{3,30}$/.test(v), 'Use digits, spaces and + ( ) - only'),
  address: optionalText(500),
  taxReference: optionalText(50),
  notes: optionalText(1000)
}
export const createSupplierSchema = z.strictObject(supplierFields)
export const updateSupplierSchema = z.strictObject({ id: uuidSchema, ...supplierFields })
export type CreateSupplierInput = z.input<typeof createSupplierSchema>
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>

export const catalogSetActiveSchema = z.strictObject({ id: uuidSchema, isActive: z.boolean(), reason: required(500) })

export const assetCodeConfigSchema = z.strictObject({
  prefix: z.string().trim().regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Use 1–10 capital letters or digits, starting with a letter'),
  separator: z.enum(['-', '/', '']),
  padding: z.number().int().min(3).max(10),
  nextNumber: z.number().int().min(1).max(9_999_999_999),
  reason: required(500)
})
export type AssetCodeConfigInput = z.infer<typeof assetCodeConfigSchema>

const assetFields = {
  categoryId: uuidSchema,
  modelId: optionalId,
  manufacturer: optionalText(120),
  modelName: optionalText(120),
  serialNumber: optionalText(100),
  specifications: optionalText(2000),
  condition: z.enum(CONDITIONS),
  operationalStatus: z.enum(MANUAL_OPERATIONAL_STATUSES),
  locationId: optionalId,
  supplierId: optionalId,
  purchaseDate: optionalDate,
  /** Ignored unless the caller may view costs; then validated and converted to minor units. */
  acquisitionCost: moneyText,
  invoiceReference: optionalText(80),
  purchaseReference: optionalText(80),
  warrantyStart: optionalDate,
  warrantyEnd: optionalDate,
  notes: optionalText(2000)
}
export const createAssetSchema = z.strictObject(assetFields)
export const updateAssetSchema = z.strictObject({ id: uuidSchema, ...assetFields, reason: optionalText(500) })
export type CreateAssetInput = z.input<typeof createAssetSchema>
export type UpdateAssetInput = z.input<typeof updateAssetSchema>

export const changeLifecycleSchema = z.strictObject({
  id: uuidSchema,
  toStatus: z.enum(LIFECYCLE_STATUSES),
  reason: required(500),
  effectiveDate: isoDateSchema,
  disposalMethod: z.enum(DISPOSAL_METHODS).nullable(),
  disposalProceeds: moneyText
})
export type ChangeLifecycleInput = z.input<typeof changeLifecycleSchema>

export const assetSearchSchema = z.strictObject({
  query: z.string().trim().max(200).optional(),
  categoryId: uuidSchema.optional(),
  lifecycle: z.enum([...LIFECYCLE_STATUSES, 'all']).default('active'),
  operational: z.enum(OPERATIONAL_STATUSES).optional(),
  condition: z.enum(CONDITIONS).optional(),
  locationId: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  warranty: z.enum(WARRANTY_FILTERS).default('any'),
  sort: z.enum(ASSET_SORTS).default('code'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
})
export type AssetSearchInput = z.input<typeof assetSearchSchema>

export const assetLookupSchema = z.strictObject({ query: z.string().trim().min(1, 'Enter or scan an asset ID').max(200) })
export type AssetLookupInput = z.infer<typeof assetLookupSchema>

export const labelRequestSchema = z.strictObject({ assetIds: z.array(uuidSchema).min(1).max(200) })
export type LabelRequestInput = z.infer<typeof labelRequestSchema>

export const attachDocumentSchema = z.strictObject({
  entityType: z.enum(DOCUMENT_OWNER_TYPES),
  entityId: uuidSchema,
  purpose: z.enum(DOCUMENT_PURPOSES)
})
export type AttachDocumentInput = z.infer<typeof attachDocumentSchema>

export const removeDocumentLinkSchema = z.strictObject({ linkId: uuidSchema, reason: required(500) })
export type RemoveDocumentLinkInput = z.infer<typeof removeDocumentLinkSchema>

export const documentRefSchema = z.strictObject({ documentId: uuidSchema })
