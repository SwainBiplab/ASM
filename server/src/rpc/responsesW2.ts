import { z } from 'zod'
import type {
  AssetCodeConfigView,
  AssetDetail,
  AssetLabel,
  AssetListItem,
  AssetLookupResult,
  CategoryView,
  DepartmentView,
  DocumentLinkView,
  EmployeeDetail,
  EmployeeListItem,
  ImportPreview,
  ImportResult,
  LocationView,
  ModelView,
  PoolView,
  SupplierView,
  TeamView,
  WorkstationView
} from '@shared/api'
import { ASSET_DOMAINS, CONDITIONS, DISPOSAL_METHODS, DOCUMENT_PURPOSES, LIFECYCLE_STATUSES, OPERATIONAL_STATUSES, TRACKING_MODES } from '@shared/assets'
import { EMPLOYMENT_STATUSES, IMPORT_DATE_FORMATS, IMPORT_FIELDS, LOCATION_TYPES, TEAM_KINDS, WORKSTATION_KINDS } from '@shared/organization'
import { auditEventOutput, dateOnly, iso, nullable, uuid } from './responses'

/** W2 output schemas (D34): organization, employees, import, catalogue, assets, documents, labels. */

const int = z.number().int()
const text = z.string()
const optText = nullable(z.string())
const employmentStatus = z.enum(EMPLOYMENT_STATUSES)

export const departmentOutput: z.ZodType<DepartmentView> = z.object({
  id: uuid, code: optText, name: text, managerEmployeeId: nullable(uuid), managerName: optText, notes: optText,
  isActive: z.boolean(), activeTeamCount: int, currentEmployeeCount: int, updatedAt: iso
})
export const teamOutput: z.ZodType<TeamView> = z.object({
  id: uuid, departmentId: uuid, departmentName: text, kind: z.enum(TEAM_KINDS), code: optText, name: text,
  leadEmployeeId: nullable(uuid), leadName: optText, notes: optText, isActive: z.boolean(), currentEmployeeCount: int
})
export const locationOutput: z.ZodType<LocationView> = z.object({
  id: uuid, parentLocationId: nullable(uuid), locationType: z.enum(LOCATION_TYPES), code: optText, name: text, path: text,
  notes: optText, isActive: z.boolean(), activeChildCount: int, activeWorkstationCount: int
})
export const workstationOutput: z.ZodType<WorkstationView> = z.object({
  id: uuid, locationId: uuid, locationPath: text, kind: z.enum(WORKSTATION_KINDS), code: text, label: optText, notes: optText, isActive: z.boolean()
})
export const poolOutput: z.ZodType<PoolView> = z.object({
  id: uuid, code: optText, name: text, purpose: optText, responsibleDepartmentId: nullable(uuid), responsibleDepartmentName: optText,
  responsibleTeamId: nullable(uuid), responsibleTeamName: optText, defaultLocationId: nullable(uuid), defaultLocationPath: optText, isActive: z.boolean()
})
export const employeeListItemOutput: z.ZodType<EmployeeListItem> = z.object({
  id: uuid, employeeCode: text, fullName: text, email: optText, jobTitle: optText, departmentName: optText, teamName: optText, managerName: optText, employmentStatus
})
export const employeeDetailOutput: z.ZodType<EmployeeDetail> = z.object({
  id: uuid, employeeCode: text, fullName: text, email: optText, phone: optText, jobTitle: optText,
  departmentId: nullable(uuid), departmentName: optText, teamId: nullable(uuid), teamName: optText,
  managerEmployeeId: nullable(uuid), managerName: optText, managerStatus: nullable(employmentStatus),
  workLocationId: nullable(uuid), workLocationPath: optText, employmentStatus, joiningDate: nullable(dateOnly), expectedExitDate: nullable(dateOnly),
  actualExitDate: nullable(dateOnly), notes: optText, createdAt: iso, updatedAt: iso,
  directReports: z.array(z.object({ id: uuid, employeeCode: text, fullName: text, employmentStatus }))
})

const importField = z.enum(IMPORT_FIELDS)
const importCounts = z.object({ totalRows: int, blankRowsSkipped: int, accepted: int, withWarnings: int, rejected: int, duplicates: int })
const mappingOutput = z.object(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, z.number().int().nullable()]))) as unknown as z.ZodType<ImportPreview['mapping']>
export const importPreviewOutput: z.ZodType<ImportPreview> = z.object({
  importId: z.string().regex(/^[0-9a-f]{32}$/),
  fileName: text,
  fileBytes: int,
  headers: z.array(text),
  mapping: mappingOutput,
  dateFormat: z.enum(IMPORT_DATE_FORMATS),
  fileIssues: z.array(text),
  rows: z.array(
    z.object({
      rowNumber: int,
      status: z.enum(['accepted', 'warning', 'rejected', 'duplicate']),
      values: z.partialRecord(importField, text),
      issues: z.array(z.object({ field: nullable(importField), severity: z.enum(['error', 'warning']), message: text }))
    })
  ),
  counts: importCounts,
  duplicateEmailPolicy: z.enum(['warn', 'reject'])
})
export const importResultOutput: z.ZodType<ImportResult> = z.object({ imported: int, skipped: int, counts: importCounts })

export const categoryOutput: z.ZodType<CategoryView> = z.object({
  id: uuid, code: text, name: text, description: optText, assetDomain: z.enum(ASSET_DOMAINS), trackingMode: z.enum(TRACKING_MODES),
  serialRequired: z.boolean(), serialUnique: z.boolean(), isActive: z.boolean(), activeModelCount: int, assetCount: int
})
export const modelOutput: z.ZodType<ModelView> = z.object({
  id: uuid, categoryId: uuid, categoryName: text, manufacturer: text, modelName: text, modelNumber: optText, specifications: optText, isActive: z.boolean(), assetCount: int
})
export const supplierOutput: z.ZodType<SupplierView> = z.object({
  id: uuid, code: optText, name: text, contactName: optText, email: optText, phone: optText, address: optText, taxReference: optText, notes: optText, isActive: z.boolean(), assetCount: int
})
export const assetCodeConfigOutput: z.ZodType<AssetCodeConfigView> = z.object({
  prefix: text, separator: z.enum(['-', '/', '']), padding: int, nextNumber: int, nextCodePreview: text, issuedCount: int
})
export const assetListItemOutput: z.ZodType<AssetListItem> = z.object({
  id: uuid, assetCode: text, categoryName: text, assetDomain: z.enum(ASSET_DOMAINS), manufacturer: optText, modelName: optText, serialNumber: optText,
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES), operationalStatus: z.enum(OPERATIONAL_STATUSES), condition: z.enum(CONDITIONS),
  locationPath: optText, warrantyEnd: nullable(dateOnly), updatedAt: iso
})
export const documentLinkOutput: z.ZodType<DocumentLinkView> = z.object({
  linkId: uuid, documentId: uuid, purpose: z.enum(DOCUMENT_PURPOSES), originalName: text, mimeType: text, byteSize: int,
  uploadedAt: iso, uploadedByName: optText, openable: z.boolean(), fileMissing: z.boolean(),
  scanStatus: z.enum(['not_scanned', 'pending', 'clean', 'rejected', 'quarantined']).optional()
})
export const assetDetailOutput: z.ZodType<AssetDetail> = z.object({
  id: uuid, assetCode: text, qrPayload: text, categoryId: uuid, categoryName: text, assetDomain: z.enum(ASSET_DOMAINS), serialRequired: z.boolean(),
  modelId: nullable(uuid), manufacturer: optText, modelName: optText, serialNumber: optText, specifications: optText,
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES), operationalStatus: z.enum(OPERATIONAL_STATUSES), condition: z.enum(CONDITIONS),
  locationId: nullable(uuid), locationPath: optText, supplierId: nullable(uuid), supplierName: optText, purchaseDate: nullable(dateOnly),
  costVisible: z.boolean(), acquisitionCostMinor: nullable(int), disposalProceedsMinor: nullable(int), currency: text,
  invoiceReference: optText, purchaseReference: optText, warrantyStart: nullable(dateOnly), warrantyEnd: nullable(dateOnly),
  warrantyState: z.enum(['none', 'active', 'expiring', 'expired']), disposalDate: nullable(dateOnly), disposalMethod: nullable(z.enum(DISPOSAL_METHODS)),
  notes: optText, createdAt: iso, updatedAt: iso, documents: z.array(documentLinkOutput), history: z.array(auditEventOutput)
})
export const assetLookupOutput: z.ZodType<AssetLookupResult> = z.object({
  matchType: z.enum(['asset_code', 'qr', 'serial', 'none']), matches: z.array(assetListItemOutput), message: text
})
export const assetLabelOutput: z.ZodType<AssetLabel> = z.object({
  assetId: uuid, assetCode: text, organizationName: text,
  qrDataUrl: z.string().startsWith('data:image/svg+xml;base64,'), barcodeDataUrl: z.string().startsWith('data:image/svg+xml;base64,')
})
