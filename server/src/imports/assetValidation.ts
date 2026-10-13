import { ASSET_IMPORT_FIELDS, CONDITIONS, type AssetCondition, type AssetImportField } from '@shared/assets'
import type { AssetImportIssue, AssetImportRowView, ImportCounts, ImportRowStatus } from '@shared/api'
import type { AssetImportMapping } from '@shared/assetSchemas'
import type { ImportDateFormat } from '@shared/organization'
import { normalizeSerial, serialUniqueKey } from '../services/catalog'
import { normalizeKey } from '../services/common'
import type { SqlClient } from '../db/sql'
import type { ParsedCsv } from './csv'
import { parseImportDate } from './employeeValidation'

/**
 * Asset CSV/Excel validation, modeled on `employeeValidation.ts`'s pure-function shape: reference
 * data is loaded once (organization-scoped) and passed in, so preview and commit re-validate
 * identically against current data without re-querying per row.
 */

export interface AssetImportLookups {
  canViewCost: boolean
  categories: Array<{ id: string; code: string | null; nm: string; a: boolean; individual: boolean; serialRequired: boolean; serialUnique: boolean }>
  locations: Array<{ id: string; code: string | null; nm: string; a: boolean }>
  suppliers: Array<{ id: string; code: string | null; nm: string; a: boolean }>
  existingSerialKeys: Set<string>
  baseCurrency: string
}

export async function loadAssetImportLookups(c: SqlClient, organizationId: string, canViewCost: boolean, baseCurrency: string): Promise<AssetImportLookups> {
  const o = [organizationId]
  return {
    canViewCost,
    baseCurrency,
    categories: await c.many(
      "SELECT id, code_normalized AS code, name_normalized AS nm, is_active AS a, (tracking_mode = 'individual') AS individual, serial_required AS \"serialRequired\", serial_unique AS \"serialUnique\" FROM asset_categories WHERE organization_id = $1",
      o
    ),
    locations: await c.many('SELECT id, code_normalized AS code, name_normalized AS nm, is_active AS a FROM locations WHERE organization_id = $1', o),
    suppliers: await c.many('SELECT id, code_normalized AS code, name_normalized AS nm, is_active AS a FROM suppliers WHERE organization_id = $1', o),
    existingSerialKeys: new Set((await c.many<{ k: string }>('SELECT serial_unique_key AS k FROM assets WHERE organization_id = $1 AND serial_unique_key IS NOT NULL', o)).map((r) => r.k))
  }
}

export interface ResolvedAssetRow {
  rowNumber: number
  categoryId: string
  manufacturer: string | null
  modelName: string | null
  serialNumber: string | null
  serialNormalized: string | null
  serialUniqueKey: string | null
  condition: AssetCondition
  locationId: string | null
  supplierId: string | null
  purchaseDate: string | null
  acquisitionCost: string | null
  invoiceReference: string | null
  purchaseReference: string | null
  warrantyStart: string | null
  warrantyEnd: string | null
  notes: string | null
}

export interface AssetValidation {
  fileIssues: string[]
  rows: AssetImportRowView[]
  importable: ResolvedAssetRow[]
  counts: ImportCounts
}

// ------------------------------ Header mapping ------------------------------

const HEADER_ALIASES: Record<AssetImportField, string[]> = {
  category: ['category', 'category name', 'category code', 'asset category', 'type'],
  manufacturer: ['manufacturer', 'make', 'brand', 'vendor'],
  modelName: ['model', 'model name', 'model no', 'model number'],
  serialNumber: ['serial number', 'serial no', 'serial', 'sn', 's/n', 'asset tag', 'service tag'],
  condition: ['condition', 'asset condition'],
  location: ['location', 'location code', 'site', 'room', 'floor'],
  supplier: ['supplier', 'vendor name', 'supplier name', 'supplier code'],
  purchaseDate: ['purchase date', 'date of purchase', 'invoice date'],
  acquisitionCost: ['cost', 'acquisition cost', 'price', 'purchase price', 'amount'],
  invoiceReference: ['invoice reference', 'invoice number', 'invoice no', 'invoice'],
  purchaseReference: ['purchase reference', 'po number', 'po no', 'purchase order'],
  warrantyStart: ['warranty start', 'warranty start date'],
  warrantyEnd: ['warranty end', 'warranty end date', 'warranty expiry'],
  notes: ['notes', 'remarks', 'comments']
}

const normalizeHeader = (h: string): string =>
  h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 /]/g, '').replace(/\s+/g, ' ').trim()

/** Suggests a column for each field from common header names; the user can change it. */
export function autoMapAssetHeaders(headers: readonly string[]): AssetImportMapping {
  const normalized = headers.map(normalizeHeader)
  const used = new Set<number>()
  const mapping = Object.fromEntries(ASSET_IMPORT_FIELDS.map((f) => [f, null])) as AssetImportMapping
  for (const field of ASSET_IMPORT_FIELDS) {
    for (const alias of HEADER_ALIASES[field]) {
      const idx = normalized.findIndex((h, i) => h === alias && !used.has(i))
      if (idx !== -1) {
        mapping[field] = idx
        used.add(idx)
        break
      }
    }
  }
  return mapping
}

const CONDITION_ALIASES: Record<string, AssetCondition> = Object.fromEntries(CONDITIONS.map((c) => [c, c]))

/** Pure validation over pre-loaded, organization-scoped lookups. Never writes, never queries. */
export function validateAssetImport(parsed: ParsedCsv, mapping: AssetImportMapping, dateFormat: ImportDateFormat, lk: AssetImportLookups): AssetValidation {
  const counts: ImportCounts = { totalRows: parsed.rows.length, blankRowsSkipped: parsed.blankRows, accepted: 0, withWarnings: 0, rejected: 0, duplicates: 0 }
  const fileIssues: string[] = []
  const columnOwners = new Map<number, AssetImportField[]>()
  for (const f of ASSET_IMPORT_FIELDS) {
    const idx = mapping[f]
    if (idx === null) continue
    if (idx >= parsed.headers.length) fileIssues.push(`Column ${idx + 1} mapped to "${f}" does not exist in the file.`)
    columnOwners.set(idx, [...(columnOwners.get(idx) ?? []), f])
  }
  for (const [idx, fields] of columnOwners) {
    if (fields.length > 1) fileIssues.push(`Column "${parsed.headers[idx] ?? idx + 1}" is mapped to more than one field (${fields.join(', ')}).`)
  }
  if (mapping.category === null) fileIssues.push('Choose the column that holds the Category.')
  if (mapping.acquisitionCost !== null && !lk.canViewCost) {
    fileIssues.push('You do not have permission to import acquisition cost. Unmap that column, or ask someone with finance view permission to run this import.')
  }
  if (fileIssues.length) return { fileIssues, rows: [], importable: [], counts }

  const { categories, locations, suppliers, existingSerialKeys } = lk

  const cell = (cells: string[], f: AssetImportField): string => {
    const idx = mapping[f]
    return idx === null ? '' : (cells[idx] ?? '').trim()
  }

  // Pre-scan for in-file serial duplicates, scoped the same way the service enforces uniqueness
  // (category + manufacturer + normalized serial) -- a plain serial-number pre-scan would over-reject
  // the same serial legitimately reused in a category that doesn't require uniqueness.
  const pendingKeys = new Map<string, number[]>()

  interface Work {
    view: AssetImportRowView
    resolved: ResolvedAssetRow | null
  }
  const work: Work[] = []

  for (const r of parsed.rows) {
    const issues: AssetImportIssue[] = []
    const err = (field: AssetImportField | null, message: string) => issues.push({ field, severity: 'error', message })
    const warn = (field: AssetImportField | null, message: string) => issues.push({ field, severity: 'warning', message })
    const values: Partial<Record<AssetImportField, string>> = {}
    for (const f of ASSET_IMPORT_FIELDS) if (mapping[f] !== null) values[f] = cell(r.cells, f)

    if (r.cells.length !== parsed.headers.length) {
      err(null, `This row has ${r.cells.length} columns but the header has ${parsed.headers.length}. Check for an unquoted comma or a missing value.`)
    }
    for (const [f, v] of Object.entries(values)) {
      if (v && /^[=@]/.test(v)) warn(f as AssetImportField, 'Value looks like a spreadsheet formula; it will be stored as plain text.')
    }

    let categoryId: string | null = null
    let category: AssetImportLookups['categories'][number] | null = null
    const categoryText = values.category ?? ''
    if (!categoryText) err('category', 'Category is required.')
    else {
      const key = normalizeKey(categoryText)
      const byCode = categories.filter((c) => c.code === key)
      const candidates = byCode.length ? byCode : categories.filter((c) => c.nm === key)
      if (candidates.length === 0) err('category', `Category "${categoryText}" does not exist. Create it first or correct the value.`)
      else if (candidates.length > 1) err('category', `Several categories are named "${categoryText}". Use the category code.`)
      else {
        category = candidates[0]!
        if (!category.a) err('category', `Category "${categoryText}" is deactivated.`)
        else if (!category.individual) {
          err('category', `Category "${categoryText}" is quantity-tracked (bulk stock). Bulk stock is recorded through procurement receipts, not through import.`)
        } else categoryId = category.id
      }
    }

    const manufacturer = values.manufacturer || null
    if (manufacturer && manufacturer.length > 120) err('manufacturer', 'Manufacturer is longer than 120 characters.')
    const modelName = values.modelName || null
    if (modelName && modelName.length > 120) err('modelName', 'Model name is longer than 120 characters.')

    const serialRaw = values.serialNumber || null
    if (serialRaw && serialRaw.length > 100) err('serialNumber', 'Serial number is longer than 100 characters.')
    const serialNormalized = serialRaw ? normalizeSerial(serialRaw) : null
    if (category?.serialRequired && !serialNormalized) err('serialNumber', `Category "${categoryText}" requires a serial number.`)
    let uniqueKey: string | null = null
    if (category?.serialUnique && serialNormalized && categoryId) {
      uniqueKey = serialUniqueKey(categoryId, manufacturer, serialNormalized)
      if (existingSerialKeys.has(uniqueKey)) err('serialNumber', `Serial number already registered on an existing asset.`)
      else pendingKeys.set(uniqueKey, [...(pendingKeys.get(uniqueKey) ?? []), r.rowNumber])
    }

    let condition: AssetCondition = 'new'
    if (values.condition) {
      const key = values.condition.trim().toLowerCase()
      if (CONDITION_ALIASES[key]) condition = CONDITION_ALIASES[key]!
      else err('condition', `Unknown condition "${values.condition}". Use ${CONDITIONS.join(', ')}.`)
    }

    let locationId: string | null = null
    if (values.location) {
      const key = normalizeKey(values.location)
      const byCode = locations.filter((l) => l.code === key)
      const candidates = byCode.length ? byCode : locations.filter((l) => l.nm === key)
      if (candidates.length === 0) err('location', `Location "${values.location}" does not exist.`)
      else if (candidates.length > 1) err('location', `Several locations are named "${values.location}". Use the location code.`)
      else if (!candidates[0]!.a) err('location', `Location "${values.location}" is deactivated.`)
      else locationId = candidates[0]!.id
    }

    let supplierId: string | null = null
    if (values.supplier) {
      const key = normalizeKey(values.supplier)
      const byCode = suppliers.filter((s) => s.code === key)
      const candidates = byCode.length ? byCode : suppliers.filter((s) => s.nm === key)
      if (candidates.length === 0) err('supplier', `Supplier "${values.supplier}" does not exist.`)
      else if (candidates.length > 1) err('supplier', `Several suppliers are named "${values.supplier}". Use the supplier code.`)
      else if (!candidates[0]!.a) err('supplier', `Supplier "${values.supplier}" is deactivated.`)
      else supplierId = candidates[0]!.id
    }

    const parseDateField = (f: 'purchaseDate' | 'warrantyStart' | 'warrantyEnd'): string | null => {
      const v = values[f]
      if (!v) return null
      const iso = parseImportDate(v, dateFormat)
      if (!iso) err(f, /^\d{5}$/.test(v) ? `"${v}" looks like a date serial number. Format the column as a date and save again.` : `"${v}" is not a valid ${dateFormat} date.`)
      return iso
    }
    const purchaseDate = parseDateField('purchaseDate')
    const warrantyStart = parseDateField('warrantyStart')
    const warrantyEnd = parseDateField('warrantyEnd')
    if (warrantyStart && warrantyEnd && warrantyEnd < warrantyStart) err('warrantyEnd', 'Warranty end is before warranty start.')

    const acquisitionCost = values.acquisitionCost || null
    const invoiceReference = values.invoiceReference || null
    if (invoiceReference && invoiceReference.length > 80) err('invoiceReference', 'Invoice reference is longer than 80 characters.')
    const purchaseReference = values.purchaseReference || null
    if (purchaseReference && purchaseReference.length > 80) err('purchaseReference', 'Purchase reference is longer than 80 characters.')
    const notes = values.notes || null
    if (notes && notes.length > 2000) err('notes', 'Notes are longer than 2000 characters.')

    work.push({
      view: { rowNumber: r.rowNumber, status: 'accepted', values, issues },
      resolved:
        categoryId === null
          ? null
          : {
              rowNumber: r.rowNumber, categoryId, manufacturer, modelName, serialNumber: serialRaw, serialNormalized, serialUniqueKey: uniqueKey, condition,
              locationId, supplierId, purchaseDate, acquisitionCost, invoiceReference, purchaseReference, warrantyStart, warrantyEnd, notes
            }
    })
  }

  // In-file serial clashes (same category/manufacturer/serial): every row sharing the key is rejected.
  for (const [key, rowNumbers] of pendingKeys) {
    if (rowNumbers.length <= 1) continue
    for (const w of work) {
      if (rowNumbers.includes(w.resolved?.rowNumber ?? -1) && w.resolved?.serialUniqueKey === key) {
        w.view.issues.push({ field: 'serialNumber', severity: 'error', message: `This serial number appears more than once in this file (rows ${rowNumbers.join(', ')}).` })
      }
    }
  }

  const importable: ResolvedAssetRow[] = []
  const rows: AssetImportRowView[] = []
  for (const w of work) {
    const hasError = w.view.issues.some((i) => i.severity === 'error')
    const status: ImportRowStatus = hasError ? 'rejected' : w.view.issues.length ? 'warning' : 'accepted'
    w.view.status = status
    rows.push(w.view)
    if (status === 'rejected') counts.rejected++
    else {
      counts.accepted++
      if (status === 'warning') counts.withWarnings++
      if (w.resolved) importable.push(w.resolved)
    }
  }
  return { fileIssues, rows, importable, counts }
}
