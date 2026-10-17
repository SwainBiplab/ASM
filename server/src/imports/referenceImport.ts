import { createHash, randomBytes } from 'node:crypto'
import type { ImportCounts, ImportResult, ReferenceImportIssue, ReferenceImportPreview, ReferenceImportRowView } from '@shared/api'
import { ASSET_DOMAINS, TRACKING_MODES, type AssetDomain, type TrackingMode } from '@shared/assets'
import { LOCATION_TYPES, TEAM_KINDS, WORKSTATION_KINDS, type LocationType, type TeamKind, type WorkstationKind } from '@shared/organization'
import { REFERENCE_IMPORT_FIELDS, REFERENCE_IMPORT_PERMISSION, type ReferenceImportKind } from '@shared/referenceImport'
import {
  referenceImportCommitInputSchema,
  referenceImportPreviewInputSchema,
  type ReferenceImportCommitInput,
  type ReferenceImportMapping,
  type ReferenceImportPreviewInput
} from '@shared/referenceImportSchemas'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { normalizeKey, normalizeOptional } from '../services/common'
import { auditFrom, recordAudit } from '../services/foundation'
import { decodeCsv, parseCsv, type ParsedCsv } from './csv'
import { isExcelFile, readExcelWorkbook } from './excel'

const SESSION_TTL_MINUTES = 30
const CODE_RE = /^[A-Za-z0-9._/-]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+()\-\s.]{3,30}$/

function assertKindPermission(ctx: OpContext, kind: ReferenceImportKind): void {
  assertPermission(ctx.actor.permissions, REFERENCE_IMPORT_PERMISSION[kind])
}

// ------------------------------ enum/bool parsing helpers ------------------------------

function parseEnumValue<T extends string>(raw: string, values: readonly T[], aliases: Record<string, T>): { value: T | null; recognized: boolean } {
  const key = raw.trim().toLowerCase()
  if (!key) return { value: null, recognized: true }
  const direct = values.find((v) => v.toLowerCase() === key)
  if (direct) return { value: direct, recognized: true }
  const alias = aliases[key]
  if (alias) return { value: alias, recognized: true }
  return { value: null, recognized: false }
}

function parseBoolValue(raw: string): { value: boolean; recognized: boolean } {
  const key = raw.trim().toLowerCase()
  if (!key) return { value: false, recognized: true }
  if (['yes', 'y', 'true', '1'].includes(key)) return { value: true, recognized: true }
  if (['no', 'n', 'false', '0'].includes(key)) return { value: false, recognized: true }
  return { value: false, recognized: false }
}

// ------------------------------ lookups (loaded once per preview/commit) ------------------------------

interface RefRow {
  id: string
  code: string | null
  name: string
  active: boolean
}

export interface ReferenceImportLookups {
  categories: RefRow[]
  departments: RefRow[]
  locations: Array<RefRow & { parentId: string | null }>
  existingModelKeys: Set<string>
  existingSupplierNames: Set<string>
  existingSupplierCodes: Set<string>
  existingTeamCodes: Set<string>
  existingTeamNamesByDept: Set<string>
  existingWorkstationCodes: Set<string>
}

export async function loadReferenceImportLookups(c: SqlClient, org: string): Promise<ReferenceImportLookups> {
  const o = [org]
  const categories = await c.many<RefRow>('SELECT id, code_normalized AS code, name_normalized AS name, is_active AS active FROM asset_categories WHERE organization_id = $1', o)
  const departments = await c.many<RefRow>('SELECT id, code_normalized AS code, name_normalized AS name, is_active AS active FROM departments WHERE organization_id = $1', o)
  const locations = await c.many<RefRow & { parentId: string | null }>(
    'SELECT id, parent_location_id AS "parentId", code_normalized AS code, name_normalized AS name, is_active AS active FROM locations WHERE organization_id = $1',
    o
  )
  const models = await c.many<{ categoryId: string; manufacturer: string; modelName: string }>(
    'SELECT category_id AS "categoryId", manufacturer_normalized AS manufacturer, model_name_normalized AS "modelName" FROM asset_models WHERE organization_id = $1',
    o
  )
  const suppliers = await c.many<{ name: string; code: string | null }>('SELECT name_normalized AS name, code_normalized AS code FROM suppliers WHERE organization_id = $1', o)
  const teams = await c.many<{ departmentId: string; name: string; code: string | null }>(
    'SELECT department_id AS "departmentId", name_normalized AS name, code_normalized AS code FROM teams WHERE organization_id = $1',
    o
  )
  const workstations = await c.many<{ code: string }>('SELECT code_normalized AS code FROM workstations WHERE organization_id = $1', o)
  return {
    categories,
    departments,
    locations,
    existingModelKeys: new Set(models.map((m) => `${m.categoryId}|${m.manufacturer}|${m.modelName}`)),
    existingSupplierNames: new Set(suppliers.map((s) => s.name)),
    existingSupplierCodes: new Set(suppliers.filter((s) => s.code).map((s) => s.code!)),
    existingTeamCodes: new Set(teams.filter((t) => t.code).map((t) => t.code!)),
    existingTeamNamesByDept: new Set(teams.map((t) => `${t.departmentId}|${t.name}`)),
    existingWorkstationCodes: new Set(workstations.map((w) => w.code))
  }
}

function findRef(rows: RefRow[], raw: string): RefRow | undefined {
  const key = normalizeKey(raw)
  return rows.find((r) => r.code === key) ?? rows.find((r) => r.name === key)
}

// ------------------------------ row resolution ------------------------------

type ResolvedRow =
  | { kind: 'categories'; code: string; name: string; assetDomain: AssetDomain; trackingMode: TrackingMode; serialRequired: boolean; serialUnique: boolean; description: string | null }
  | { kind: 'models'; categoryId: string; manufacturer: string; modelName: string; modelNumber: string | null; specifications: string | null }
  | { kind: 'suppliers'; name: string; code: string | null; contactName: string | null; email: string | null; phone: string | null; address: string | null; taxReference: string | null }
  | { kind: 'departments'; name: string; code: string | null }
  | { kind: 'teams'; departmentId: string; name: string; code: string | null; teamKind: TeamKind }
  | { kind: 'locations'; name: string; locationType: LocationType; parentLocationId: string | null; code: string | null }
  | { kind: 'workstations'; locationId: string; code: string; workstationKind: WorkstationKind; label: string | null }

interface RowResult {
  resolved: ResolvedRow | null
  issues: ReferenceImportIssue[]
  /** One normalized key per uniqueness dimension this kind enforces (e.g. a category checks both
   * code and name independently); used for both the in-file duplicate pre-scan and the message. */
  dupKeys: Array<{ dimension: string; key: string | null }>
}

function resolveRow(kind: ReferenceImportKind, v: Record<string, string>, lk: ReferenceImportLookups): RowResult {
  const issues: ReferenceImportIssue[] = []
  const err = (field: string | null, message: string) => issues.push({ field, severity: 'error', message })
  const get = (key: string) => (v[key] ?? '').trim()

  switch (kind) {
    case 'categories': {
      const code = get('code')
      const name = get('name')
      if (!code) err('code', 'Code is required.')
      else if (code.length > 20 || !CODE_RE.test(code)) err('code', 'Code may contain only letters, digits, dot, slash, underscore or hyphen (max 20).')
      if (!name) err('name', 'Name is required.')
      else if (name.length > 120) err('name', 'Name is longer than 120 characters.')
      const domainRaw = get('assetDomain')
      const domain = parseEnumValue(domainRaw, ASSET_DOMAINS, { it: 'it', facilities: 'facilities' })
      if (!domainRaw) err('assetDomain', 'Domain is required (IT or Facilities).')
      else if (!domain.recognized) err('assetDomain', `Unknown domain "${domainRaw}". Use IT or Facilities.`)
      const tracking = parseEnumValue(get('trackingMode'), TRACKING_MODES, { individually_tracked: 'individual', bulk_tracked: 'bulk' })
      if (!tracking.recognized) err('trackingMode', `Unknown tracking mode "${get('trackingMode')}". Use Individual or Bulk.`)
      const serialRequired = parseBoolValue(get('serialRequired'))
      if (!serialRequired.recognized) err('serialRequired', `"${get('serialRequired')}" is not Yes/No.`)
      const serialUnique = parseBoolValue(get('serialUnique'))
      if (!serialUnique.recognized) err('serialUnique', `"${get('serialUnique')}" is not Yes/No.`)
      if (serialUnique.value && !serialRequired.value) err('serialUnique', 'Unique serial numbers require serial numbers to be mandatory.')
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'code', key: code ? normalizeKey(code) : null }, { dimension: 'name', key: name ? normalizeKey(name) : null }] }
      return {
        resolved: {
          kind, code, name, assetDomain: domain.value!, trackingMode: tracking.value ?? 'individual',
          serialRequired: serialRequired.value, serialUnique: serialUnique.value, description: get('description') || null
        },
        issues,
        dupKeys: [{ dimension: 'code', key: normalizeKey(code) }, { dimension: 'name', key: normalizeKey(name) }]
      }
    }
    case 'models': {
      const categoryRaw = get('category')
      const manufacturer = get('manufacturer')
      const modelName = get('modelName')
      let categoryId: string | null = null
      if (!categoryRaw) err('category', 'Category is required.')
      else {
        const cat = findRef(lk.categories, categoryRaw)
        if (!cat) err('category', `Category "${categoryRaw}" does not exist. Create it first or correct the value.`)
        else if (!cat.active) err('category', `Category "${categoryRaw}" is deactivated.`)
        else categoryId = cat.id
      }
      if (!manufacturer) err('manufacturer', 'Manufacturer is required.')
      else if (manufacturer.length > 120) err('manufacturer', 'Manufacturer is longer than 120 characters.')
      if (!modelName) err('modelName', 'Model name is required.')
      else if (modelName.length > 120) err('modelName', 'Model name is longer than 120 characters.')
      const dupKey = categoryId && manufacturer && modelName ? `${categoryId}|${normalizeKey(manufacturer)}|${normalizeKey(modelName)}` : null
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'model', key: dupKey }] }
      return {
        resolved: { kind, categoryId: categoryId!, manufacturer, modelName, modelNumber: get('modelNumber') || null, specifications: get('specifications') || null },
        issues,
        dupKeys: [{ dimension: 'model', key: dupKey }]
      }
    }
    case 'suppliers': {
      const name = get('name')
      const code = get('code') || null
      if (!name) err('name', 'Name is required.')
      else if (name.length > 160) err('name', 'Name is longer than 160 characters.')
      if (code && (code.length > 30 || !CODE_RE.test(code))) err('code', 'Code may contain only letters, digits, dot, slash, underscore or hyphen (max 30).')
      const email = get('email') || null
      if (email && (email.length > 254 || !EMAIL_RE.test(email))) err('email', 'Email address is not valid.')
      const phone = get('phone') || null
      if (phone && !PHONE_RE.test(phone)) err('phone', 'Phone may contain only digits, spaces and + ( ) - (3-30 characters).')
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'name', key: name ? normalizeKey(name) : null }, { dimension: 'code', key: code ? normalizeKey(code) : null }] }
      return {
        resolved: { kind, name, code, contactName: get('contactName') || null, email, phone, address: get('address') || null, taxReference: get('taxReference') || null },
        issues,
        dupKeys: [{ dimension: 'name', key: normalizeKey(name) }, { dimension: 'code', key: code ? normalizeKey(code) : null }]
      }
    }
    case 'departments': {
      const name = get('name')
      const code = get('code') || null
      if (!name) err('name', 'Name is required.')
      else if (name.length > 120) err('name', 'Name is longer than 120 characters.')
      if (code && (code.length > 30 || !CODE_RE.test(code))) err('code', 'Code may contain only letters, digits, dot, slash, underscore or hyphen (max 30).')
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'name', key: name ? normalizeKey(name) : null }, { dimension: 'code', key: code ? normalizeKey(code) : null }] }
      return { resolved: { kind, name, code }, issues, dupKeys: [{ dimension: 'name', key: normalizeKey(name) }, { dimension: 'code', key: code ? normalizeKey(code) : null }] }
    }
    case 'teams': {
      const deptRaw = get('department')
      const name = get('name')
      const code = get('code') || null
      let departmentId: string | null = null
      if (!deptRaw) err('department', 'Department is required.')
      else {
        const dept = findRef(lk.departments, deptRaw)
        if (!dept) err('department', `Department "${deptRaw}" does not exist. Create it first or correct the value.`)
        else if (!dept.active) err('department', `Department "${deptRaw}" is deactivated.`)
        else departmentId = dept.id
      }
      if (!name) err('name', 'Name is required.')
      else if (name.length > 120) err('name', 'Name is longer than 120 characters.')
      if (code && (code.length > 30 || !CODE_RE.test(code))) err('code', 'Code may contain only letters, digits, dot, slash, underscore or hyphen (max 30).')
      const teamKind = parseEnumValue(get('kind'), TEAM_KINDS, { team: 'team', process: 'process' })
      if (!teamKind.recognized) err('kind', `Unknown kind "${get('kind')}". Use Team or Process.`)
      const nameKey = departmentId && name ? `${departmentId}|${normalizeKey(name)}` : null
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'name', key: nameKey }, { dimension: 'code', key: code ? normalizeKey(code) : null }] }
      return {
        resolved: { kind, departmentId: departmentId!, name, code, teamKind: teamKind.value ?? 'team' },
        issues,
        dupKeys: [{ dimension: 'name', key: nameKey }, { dimension: 'code', key: code ? normalizeKey(code) : null }]
      }
    }
    case 'locations': {
      const name = get('name')
      const code = get('code') || null
      const typeRaw = get('locationType')
      const type = parseEnumValue(typeRaw, LOCATION_TYPES, {})
      if (!name) err('name', 'Name is required.')
      else if (name.length > 120) err('name', 'Name is longer than 120 characters.')
      if (!typeRaw) err('locationType', 'Type is required.')
      else if (!type.recognized) err('locationType', `Unknown type "${typeRaw}". Use Site, Building, Floor, Room, Bay, Storage or Other.`)
      if (code && (code.length > 30 || !CODE_RE.test(code))) err('code', 'Code may contain only letters, digits, dot, slash, underscore or hyphen (max 30).')
      let parentLocationId: string | null = null
      const parentRaw = get('parentLocation')
      if (parentRaw) {
        const parent = findRef(lk.locations, parentRaw)
        if (!parent) err('parentLocation', `Parent location "${parentRaw}" does not exist. It must already exist (create or import it first).`)
        else if (!parent.active) err('parentLocation', `Parent location "${parentRaw}" is deactivated.`)
        else parentLocationId = parent.id
      }
      const nameKey = name ? `${parentLocationId ?? ''}|${normalizeKey(name)}` : null
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'name', key: nameKey }, { dimension: 'code', key: code ? normalizeKey(code) : null }] }
      return {
        resolved: { kind, name, locationType: type.value!, parentLocationId, code },
        issues,
        dupKeys: [{ dimension: 'name', key: nameKey }, { dimension: 'code', key: code ? normalizeKey(code) : null }]
      }
    }
    case 'workstations': {
      const locRaw = get('location')
      const code = get('code')
      let locationId: string | null = null
      if (!locRaw) err('location', 'Location is required.')
      else {
        const loc = findRef(lk.locations, locRaw)
        if (!loc) err('location', `Location "${locRaw}" does not exist. Create it first or correct the value.`)
        else if (!loc.active) err('location', `Location "${locRaw}" is deactivated.`)
        else locationId = loc.id
      }
      if (!code) err('code', 'Code is required.')
      else if (code.length > 30 || !CODE_RE.test(code)) err('code', 'Code may contain only letters, digits, dot, slash, underscore or hyphen (max 30).')
      const wsKind = parseEnumValue(get('kind'), WORKSTATION_KINDS, { workstation: 'workstation', seat: 'seat' })
      if (!wsKind.recognized) err('kind', `Unknown kind "${get('kind')}". Use Workstation or Seat.`)
      if (issues.length) return { resolved: null, issues, dupKeys: [{ dimension: 'code', key: code ? normalizeKey(code) : null }] }
      return {
        resolved: { kind, locationId: locationId!, code, workstationKind: wsKind.value ?? 'workstation', label: get('label') || null },
        issues,
        dupKeys: [{ dimension: 'code', key: normalizeKey(code) }]
      }
    }
  }
}

function existingHit(kind: ReferenceImportKind, lk: ReferenceImportLookups, dimension: string, key: string): boolean {
  switch (kind) {
    case 'categories':
      return dimension === 'code' ? lk.categories.some((c) => c.code === key) : lk.categories.some((c) => c.name === key)
    case 'models':
      return lk.existingModelKeys.has(key)
    case 'suppliers':
      return dimension === 'name' ? lk.existingSupplierNames.has(key) : lk.existingSupplierCodes.has(key)
    case 'departments':
      return dimension === 'code' ? lk.departments.some((d) => d.code === key) : lk.departments.some((d) => d.name === key)
    case 'teams':
      return dimension === 'code' ? lk.existingTeamCodes.has(key) : lk.existingTeamNamesByDept.has(key)
    case 'locations':
      return dimension === 'code' ? lk.locations.some((l) => l.code === key) : lk.locations.some((l) => `${l.parentId ?? ''}|${l.name}` === key)
    case 'workstations':
      return lk.existingWorkstationCodes.has(key)
  }
}

export interface ReferenceValidation {
  fileIssues: string[]
  rows: ReferenceImportRowView[]
  importable: ResolvedRow[]
  counts: ImportCounts
}

/** Suggests a column for each field whose header text matches the field's own label, case-insensitively. */
export function autoMapReferenceHeaders(kind: ReferenceImportKind, headers: readonly string[]): ReferenceImportMapping {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '))
  const used = new Set<number>()
  const mapping: ReferenceImportMapping = {}
  for (const f of REFERENCE_IMPORT_FIELDS[kind]) {
    const label = f.label.toLowerCase().split(' (')[0] ?? f.label.toLowerCase()
    const idx = normalized.findIndex((h, i) => !used.has(i) && (h === f.key.toLowerCase() || h === label))
    if (idx !== -1) used.add(idx)
    mapping[f.key] = idx === -1 ? null : idx
  }
  return mapping
}

export function validateReferenceImport(kind: ReferenceImportKind, parsed: ParsedCsv, mapping: ReferenceImportMapping, lk: ReferenceImportLookups): ReferenceValidation {
  const fields = REFERENCE_IMPORT_FIELDS[kind]
  const counts: ImportCounts = { totalRows: parsed.rows.length, blankRowsSkipped: parsed.blankRows, accepted: 0, withWarnings: 0, rejected: 0, duplicates: 0 }
  const fileIssues: string[] = []
  const columnOwners = new Map<number, string[]>()
  for (const f of fields) {
    const idx = mapping[f.key]
    if (idx === null || idx === undefined) continue
    if (idx >= parsed.headers.length) fileIssues.push(`Column ${idx + 1} mapped to "${f.label}" does not exist in the file.`)
    columnOwners.set(idx, [...(columnOwners.get(idx) ?? []), f.key])
  }
  for (const [idx, keys] of columnOwners) {
    if (keys.length > 1) fileIssues.push(`Column "${parsed.headers[idx] ?? idx + 1}" is mapped to more than one field (${keys.join(', ')}).`)
  }
  for (const f of fields.filter((x) => x.required)) {
    if (mapping[f.key] === null || mapping[f.key] === undefined) fileIssues.push(`Choose the column that holds ${f.label}.`)
  }
  if (fileIssues.length) return { fileIssues, rows: [], importable: [], counts }

  const cell = (cells: string[], key: string): string => {
    const idx = mapping[key]
    return idx === null || idx === undefined ? '' : (cells[idx] ?? '').trim()
  }

  interface Work {
    view: ReferenceImportRowView
    result: RowResult
  }
  const work: Work[] = []
  for (const r of parsed.rows) {
    const values: Record<string, string> = {}
    for (const f of fields) values[f.key] = cell(r.cells, f.key)
    const result = resolveRow(kind, values, lk)
    if (r.cells.length !== parsed.headers.length) {
      result.issues.push({ field: null, severity: 'error', message: `This row has ${r.cells.length} columns but the header has ${parsed.headers.length}. Check for an unquoted comma or a missing value.` })
    }
    work.push({ view: { rowNumber: r.rowNumber, status: 'accepted', values, issues: result.issues }, result })
  }

  // In-file duplicate pre-scan, per uniqueness dimension this kind enforces.
  const seenInFile = new Map<string, Map<string, number[]>>()
  for (const w of work) {
    for (const { dimension, key } of w.result.dupKeys) {
      if (!key) continue
      const byDim = seenInFile.get(dimension) ?? new Map<string, number[]>()
      byDim.set(key, [...(byDim.get(key) ?? []), w.view.rowNumber])
      seenInFile.set(dimension, byDim)
    }
  }

  for (const w of work) {
    let duplicate = false
    for (const { dimension, key } of w.result.dupKeys) {
      if (!key) continue
      if (existingHit(kind, lk, dimension, key)) {
        duplicate = true
        w.view.issues.push({ field: null, severity: 'error', message: `A record with this ${dimension} already exists. Import never overwrites existing records.` })
      }
      const rows = seenInFile.get(dimension)?.get(key) ?? []
      if (rows.length > 1) {
        duplicate = true
        w.view.issues.push({ field: null, severity: 'error', message: `This ${dimension} appears more than once in this file (rows ${rows.join(', ')}).` })
      }
    }
    const hasError = w.view.issues.some((i) => i.severity === 'error')
    const status: ReferenceImportRowView['status'] = duplicate ? 'duplicate' : hasError ? 'rejected' : w.view.issues.length ? 'warning' : 'accepted'
    w.view.status = status
    if (status === 'duplicate') counts.duplicates++
    else if (status === 'rejected') counts.rejected++
    else {
      counts.accepted++
      if (status === 'warning') counts.withWarnings++
    }
  }

  return {
    fileIssues,
    rows: work.map((w) => w.view),
    importable: work.filter((w) => w.view.status === 'accepted' || w.view.status === 'warning').map((w) => w.result.resolved!),
    counts
  }
}

async function insertReferenceRow(t: SqlClient, org: string, row: ResolvedRow): Promise<void> {
  const id = newId()
  switch (row.kind) {
    case 'categories':
      await t.exec(
        `INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, description, asset_domain, tracking_mode, serial_required, serial_unique)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, org, row.code, normalizeKey(row.code), row.name, normalizeKey(row.name), row.description, row.assetDomain, row.trackingMode, row.serialRequired, row.serialUnique]
      )
      return
    case 'models':
      await t.exec(
        `INSERT INTO asset_models (id, organization_id, category_id, manufacturer, manufacturer_normalized, model_name, model_name_normalized, model_number, specifications)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, org, row.categoryId, row.manufacturer, normalizeKey(row.manufacturer), row.modelName, normalizeKey(row.modelName), row.modelNumber, row.specifications]
      )
      return
    case 'suppliers':
      await t.exec(
        `INSERT INTO suppliers (id, organization_id, code, code_normalized, name, name_normalized, contact_name, email, phone, address, tax_reference, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)`,
        [id, org, row.code, normalizeOptional(row.code), row.name, normalizeKey(row.name), row.contactName, row.email, row.phone, row.address, row.taxReference]
      )
      return
    case 'departments':
      await t.exec(
        `INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, manager_employee_id, notes) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
        [id, org, row.code, normalizeOptional(row.code), row.name, normalizeKey(row.name)]
      )
      return
    case 'teams':
      await t.exec(
        `INSERT INTO teams (id, organization_id, department_id, kind, code, code_normalized, name, name_normalized, lead_employee_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)`,
        [id, org, row.departmentId, row.teamKind, row.code, normalizeOptional(row.code), row.name, normalizeKey(row.name)]
      )
      return
    case 'locations':
      await t.exec(
        `INSERT INTO locations (id, organization_id, parent_location_id, location_type, code, code_normalized, name, name_normalized, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
        [id, org, row.parentLocationId, row.locationType, row.code, normalizeOptional(row.code), row.name, normalizeKey(row.name)]
      )
      return
    case 'workstations':
      await t.exec(
        `INSERT INTO workstations (id, organization_id, location_id, kind, code, code_normalized, label, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
        [id, org, row.locationId, row.workstationKind, row.code, normalizeKey(row.code), row.label]
      )
      return
  }
}

// ------------------------------ session orchestration ------------------------------

interface SessionRow {
  id: string
  kind: ReferenceImportKind
  fileName: string
  fileBytes: number
  fileSha256: string
  parsed: ParsedCsv
}

async function buildPreview(c: SqlClient, s: SessionRow, mapping: ReferenceImportMapping, org: string): Promise<ReferenceImportPreview> {
  const v = validateReferenceImport(s.kind, s.parsed, mapping, await loadReferenceImportLookups(c, org))
  return { importId: s.id, kind: s.kind, fileName: s.fileName, fileBytes: s.fileBytes, headers: s.parsed.headers, mapping, fileIssues: v.fileIssues, rows: v.rows, counts: v.counts }
}

async function readTable(data: Uint8Array): Promise<ParsedCsv> {
  if (isExcelFile(data)) {
    const result = await readExcelWorkbook(Buffer.from(data), null)
    if (result.kind === 'choose') throw new AppError('VALIDATION_ERROR', 'This workbook has more than one sheet. Reference-data import only reads the first sheet; remove the others and try again.')
    return result.table
  }
  return parseCsv(decodeCsv(data))
}

/** Stores an uploaded CSV/Excel file as an import session (owner-bound, expiring). Never writes
 * records until commit. */
export async function startReferenceImport(db: Db, kind: ReferenceImportKind, file: { fileName: string; data: Uint8Array }, ctx: OpContext): Promise<ReferenceImportPreview> {
  assertKindPermission(ctx, kind)
  const parsed = await readTable(file.data)
  const session: SessionRow = {
    id: randomBytes(16).toString('hex'),
    kind,
    fileName: file.fileName.replace(/[\u0000-\u001f]/g, '').slice(-255) || 'import.csv',
    fileBytes: file.data.byteLength,
    fileSha256: createHash('sha256').update(file.data).digest('hex'),
    parsed
  }
  await db.exec('DELETE FROM import_sessions WHERE expires_at < now()')
  await db.exec(
    `INSERT INTO import_sessions (id, organization_id, user_id, kind, file_name, file_bytes, file_sha256, parsed, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9))`,
    [session.id, ctx.actor.organizationId, ctx.actor.userId, kind, session.fileName, session.fileBytes, session.fileSha256, JSON.stringify(parsed), SESSION_TTL_MINUTES]
  )
  return buildPreview(db, session, autoMapReferenceHeaders(kind, parsed.headers), ctx.actor.organizationId)
}

async function loadSession(c: SqlClient, ctx: OpContext, importId: string, forUpdate: boolean): Promise<SessionRow> {
  const s = await c.one<SessionRow>(
    `SELECT id, kind, file_name AS "fileName", file_bytes AS "fileBytes", file_sha256 AS "fileSha256", parsed
     FROM import_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3
       AND kind IN ('categories','models','suppliers','departments','teams','locations','workstations')
       AND consumed_at IS NULL AND expires_at > now()${forUpdate ? ' FOR UPDATE' : ''}`,
    [importId, ctx.actor.organizationId, ctx.actor.userId]
  )
  if (!s) throw new AppError('NOT_FOUND', 'This import is no longer available (it expired, was cancelled or already imported). Upload the file again.')
  return s
}

export async function previewReferenceImport(db: Db, raw: ReferenceImportPreviewInput, ctx: OpContext): Promise<ReferenceImportPreview> {
  const input = referenceImportPreviewInputSchema.parse(raw)
  const session = await loadSession(db, ctx, input.importId, false)
  assertKindPermission(ctx, session.kind)
  return buildPreview(db, session, input.mapping, ctx.actor.organizationId)
}

/** Re-validates against current data inside one transaction (session row locked) and inserts all
 * importable rows; any error rolls back every row and leaves the session reusable. */
export async function commitReferenceImport(db: Db, raw: ReferenceImportCommitInput, ctx: OpContext): Promise<ImportResult> {
  const input = referenceImportCommitInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const session = await loadSession(t, ctx, input.importId, true)
    assertKindPermission(ctx, session.kind)
    const v = validateReferenceImport(session.kind, session.parsed, input.mapping, await loadReferenceImportLookups(t, org))
    const counts: ImportCounts = v.counts
    if (v.fileIssues.length) throw new AppError('VALIDATION_ERROR', v.fileIssues.join(' '))
    const blocked = counts.rejected + counts.duplicates
    if (blocked > 0 && !input.skipInvalidRows) {
      throw new AppError('VALIDATION_ERROR', `${blocked} row(s) are rejected or duplicates. Correct the file and upload it again, or choose to skip those rows.`)
    }
    if (v.importable.length === 0) throw new AppError('VALIDATION_ERROR', 'There are no valid rows to import.')

    for (const row of v.importable) await insertReferenceRow(t, org, row)
    await t.exec('UPDATE import_sessions SET consumed_at = now() WHERE id = $1', [session.id])
    await recordAudit(t, {
      ...auditFrom(ctx),
      eventType: `${session.kind}.imported`,
      entityType: 'reference_import',
      entityId: session.id,
      summary: { kind: session.kind, fileName: session.fileName, fileSha256: session.fileSha256, fileBytes: session.fileBytes, ...counts, imported: v.importable.length, skipInvalidRows: input.skipInvalidRows }
    })
    return { imported: v.importable.length, skipped: blocked, counts }
  })
}

export async function cancelReferenceImport(db: Db, importId: string, ctx: OpContext): Promise<void> {
  const session = await db.one<{ kind: ReferenceImportKind }>(
    `SELECT kind FROM import_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND consumed_at IS NULL`,
    [importId, ctx.actor.organizationId, ctx.actor.userId]
  )
  if (session) assertKindPermission(ctx, session.kind)
  await db.exec('UPDATE import_sessions SET consumed_at = now() WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND consumed_at IS NULL', [
    importId, ctx.actor.organizationId, ctx.actor.userId
  ])
}
