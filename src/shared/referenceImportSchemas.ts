import { z } from 'zod'
import { REFERENCE_IMPORT_KINDS } from './referenceImport'

export const referenceImportIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Invalid import identifier')
export const referenceImportKindSchema = z.enum(REFERENCE_IMPORT_KINDS)

/** Column index per field key; unlike the employee/asset importer's fixed field union, field keys
 * vary by kind, so the mapping is a plain string-keyed record validated against the kind's own
 * field list at resolve time, not by the schema itself. */
export const referenceImportMappingSchema = z.record(z.string(), z.number().int().min(0).max(199).nullable())
export type ReferenceImportMapping = z.infer<typeof referenceImportMappingSchema>

export const referenceImportPreviewInputSchema = z.strictObject({
  importId: referenceImportIdSchema,
  mapping: referenceImportMappingSchema
})
export type ReferenceImportPreviewInput = z.infer<typeof referenceImportPreviewInputSchema>

export const referenceImportCommitInputSchema = z.strictObject({
  importId: referenceImportIdSchema,
  mapping: referenceImportMappingSchema,
  /** When false (default), any rejected or duplicate row blocks the whole import. */
  skipInvalidRows: z.boolean()
})
export type ReferenceImportCommitInput = z.infer<typeof referenceImportCommitInputSchema>

export const referenceImportRefSchema = z.strictObject({ importId: referenceImportIdSchema })
export type ReferenceImportRefInput = z.infer<typeof referenceImportRefSchema>
