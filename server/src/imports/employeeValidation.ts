import { z } from 'zod'
import type { ImportCounts, ImportIssue, ImportRowStatus, ImportRowView } from '@shared/api'
import { IMPORT_FIELDS, type EmploymentStatus, type ImportDateFormat, type ImportField } from '@shared/organization'
import { isValidIsoDate, type ImportMapping } from '@shared/orgSchemas'
import type { SqlClient } from '../db/sql'
import { normalizeKey } from '../services/common'
import { normalizeEmployeeCode } from '../services/employees'
import { getSettings } from '../services/foundation'
import type { ParsedCsv } from './csv'

/**
 * Employee CSV validation, ported unchanged from the prototype (src/main/import/employeeImport.ts)
 * except that reference data is loaded up front (async, organization-scoped) and passed in.
 */

export interface ImportLookups {
  emailPolicy: 'warn' | 'reject'
  departments: Array<{ id: string; name: string; code: string | null; nm: string; a: boolean }>
  teams: Array<{ id: string; d: string; name: string; code: string | null; nm: string; a: boolean }>
  locations: Array<{ id: string; code: string | null; nm: string; a: boolean }>
  existing: Map<string, { id: string; c: string; s: EmploymentStatus }>
  existingEmails: Set<string>
}

export async function loadImportLookups(c: SqlClient, organizationId: string): Promise<ImportLookups> {
  const o = [organizationId]
  return {
    emailPolicy: (await getSettings(c, organizationId)).employeeDuplicateEmailPolicy,
    departments: await c.many('SELECT id, name, code_normalized AS code, name_normalized AS nm, is_active AS a FROM departments WHERE organization_id = $1', o),
    teams: await c.many('SELECT id, department_id AS d, name, code_normalized AS code, name_normalized AS nm, is_active AS a FROM teams WHERE organization_id = $1', o),
    locations: await c.many('SELECT id, code_normalized AS code, name_normalized AS nm, is_active AS a FROM locations WHERE organization_id = $1', o),
    existing: new Map(
      (await c.many<{ id: string; c: string; s: EmploymentStatus }>('SELECT id, employee_code_normalized AS c, employment_status AS s FROM employees WHERE organization_id = $1', o)).map((e) => [e.c, e])
    ),
    existingEmails: new Set((await c.many<{ e: string }>('SELECT email_normalized AS e FROM employees WHERE organization_id = $1 AND email_normalized IS NOT NULL', o)).map((r) => r.e))
  }
}

export interface ResolvedRow {
  rowNumber: number
  employeeCode: string
  fullName: string
  email: string | null
  phone: string | null
  jobTitle: string | null
  departmentId: string | null
  teamId: string | null
  workLocationId: string | null
  employmentStatus: EmploymentStatus
  joiningDate: string | null
  expectedExitDate: string | null
  managerExistingId: string | null
  managerRowNumber: number | null
}

export interface Validation {
  fileIssues: string[]
  rows: ImportRowView[]
  importable: ResolvedRow[]
  counts: ImportCounts
}

// ------------------------------ Header mapping ------------------------------

const HEADER_ALIASES: Record<ImportField, string[]> = {
  employeeCode: ['employee id', 'employee code', 'emp id', 'emp code', 'employee no', 'employee number', 'emp no', 'staff id', 'id', 'code'],
  fullName: ['full name', 'name', 'employee name', 'emp name'],
  email: ['email', 'email address', 'e mail', 'mail', 'work email', 'official email'],
  phone: ['phone', 'mobile', 'phone number', 'mobile number', 'contact', 'contact number'],
  jobTitle: ['job title', 'title', 'designation', 'role', 'position'],
  department: ['department', 'dept', 'department name', 'department code'],
  team: ['team', 'process', 'team name', 'process name', 'team / process', 'team/process', 'lob'],
  managerCode: ['manager id', 'manager code', 'manager employee id', 'reporting manager id', 'manager emp id', 'reports to', 'supervisor id'],
  workLocation: ['work location', 'location', 'location code', 'site', 'office'],
  employmentStatus: ['employment status', 'status'],
  joiningDate: ['joining date', 'date of joining', 'doj', 'join date', 'start date'],
  expectedExitDate: ['expected exit date', 'exit date', 'last working day', 'lwd', 'end date']
}

const normalizeHeader = (h: string): string =>
  h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 /]/g, '').replace(/\s+/g, ' ').trim()

/** Suggests a column for each field from common header names; the user can change it. */
export function autoMapHeaders(headers: readonly string[]): ImportMapping {
  const normalized = headers.map(normalizeHeader)
  const used = new Set<number>()
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ImportMapping
  for (const field of IMPORT_FIELDS) {
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

// ------------------------------ Value parsing ------------------------------

const DATE_PATTERN = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/

/** Parses a date in the format chosen for this import; never guesses between DMY and MDY. */
export function parseImportDate(value: string, format: ImportDateFormat): string | null {
  const m = DATE_PATTERN.exec(value.trim())
  if (!m) return null
  const [a, b, c] = [m[1]!, m[2]!, m[3]!]
  const [y, mo, d] = format === 'YYYY-MM-DD' ? [a, b, c] : format === 'DD-MM-YYYY' ? [c, b, a] : [c, a, b]
  if (y.length !== 4) return null
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  return isValidIsoDate(iso) ? iso : null
}

const STATUS_ALIASES: Record<string, EmploymentStatus> = {
  active: 'active',
  'on leave': 'on_leave',
  on_leave: 'on_leave',
  leave: 'on_leave',
  'notice period': 'notice_period',
  notice_period: 'notice_period',
  notice: 'notice_period',
  'serving notice': 'notice_period'
}
const EXITED_WORDS = new Set(['exited', 'inactive', 'resigned', 'terminated', 'left', 'separated'])

const CODE_RE = /^[A-Za-z0-9._/-]+$/
const PHONE_RE = /^[0-9+()\-\s.]{3,30}$/
const emailSchema = z.email()


/** Pure validation over pre-loaded, organization-scoped lookups (same rules as the prototype). */
export function validateEmployeeImport(parsed: ParsedCsv, mapping: ImportMapping, dateFormat: ImportDateFormat, lk: ImportLookups): Validation {
    const counts: ImportCounts = { totalRows: parsed.rows.length, blankRowsSkipped: parsed.blankRows, accepted: 0, withWarnings: 0, rejected: 0, duplicates: 0 }
    const fileIssues: string[] = []
    const columnOwners = new Map<number, ImportField[]>()
    for (const f of IMPORT_FIELDS) {
      const idx = mapping[f]
      if (idx === null) continue
      if (idx >= parsed.headers.length) fileIssues.push(`Column ${idx + 1} mapped to "${f}" does not exist in the file.`)
      columnOwners.set(idx, [...(columnOwners.get(idx) ?? []), f])
    }
    for (const [idx, fields] of columnOwners) {
      if (fields.length > 1) fileIssues.push(`Column "${parsed.headers[idx] ?? idx + 1}" is mapped to more than one field (${fields.join(', ')}).`)
    }
    if (mapping.employeeCode === null) fileIssues.push('Choose the column that holds the Employee ID.')
    if (mapping.fullName === null) fileIssues.push('Choose the column that holds the full name.')
    if (fileIssues.length) return { fileIssues, rows: [], importable: [], counts }

    const { emailPolicy, departments, teams, locations, existing, existingEmails } = lk

    const cell = (cells: string[], f: ImportField): string => {
      const idx = mapping[f]
      return idx === null ? '' : (cells[idx] ?? '').trim()
    }

    // Pre-scan for in-file duplicates of Employee ID and email.
    const codeRows = new Map<string, number[]>()
    const emailRows = new Map<string, number[]>()
    for (const r of parsed.rows) {
      const code = cell(r.cells, 'employeeCode')
      if (code) codeRows.set(normalizeEmployeeCode(code), [...(codeRows.get(normalizeEmployeeCode(code)) ?? []), r.rowNumber])
      const email = cell(r.cells, 'email')
      if (email) emailRows.set(normalizeKey(email), [...(emailRows.get(normalizeKey(email)) ?? []), r.rowNumber])
    }

    interface Work {
      view: ImportRowView
      resolved: ResolvedRow
      duplicate: boolean
      managerCodeRaw: string
    }
    const work: Work[] = []

    for (const r of parsed.rows) {
      const issues: ImportIssue[] = []
      const err = (field: ImportField | null, message: string) => issues.push({ field, severity: 'error', message })
      const warn = (field: ImportField | null, message: string) => issues.push({ field, severity: 'warning', message })
      const values: Partial<Record<ImportField, string>> = {}
      for (const f of IMPORT_FIELDS) if (mapping[f] !== null) values[f] = cell(r.cells, f)
      let duplicate = false

      if (r.cells.length !== parsed.headers.length) {
        err(null, `This row has ${r.cells.length} columns but the header has ${parsed.headers.length}. Check for an unquoted comma or a missing value.`)
      }
      for (const [f, v] of Object.entries(values)) {
        if (v && /^[=@]/.test(v)) warn(f as ImportField, 'Value looks like a spreadsheet formula; it will be stored as plain text.')
      }

      const code = values.employeeCode ?? ''
      if (!code) err('employeeCode', 'Employee ID is required.')
      else if (code.length > 50 || !CODE_RE.test(code)) err('employeeCode', 'Employee ID may contain only letters, digits, dot, slash, underscore or hyphen (max 50).')
      else {
        const norm = normalizeEmployeeCode(code)
        if (existing.has(norm)) {
          duplicate = true
          err('employeeCode', `Employee ID ${code} already exists. Import never overwrites existing employees.`)
        }
        const same = codeRows.get(norm) ?? []
        if (same.length > 1) {
          duplicate = true
          err('employeeCode', `Employee ID ${code} appears more than once in this file (rows ${same.join(', ')}).`)
        }
      }

      const fullName = values.fullName ?? ''
      if (!fullName) err('fullName', 'Full name is required.')
      else if (fullName.length > 150) err('fullName', 'Full name is longer than 150 characters.')

      const email = values.email || null
      if (email) {
        if (email.length > 254 || !emailSchema.safeParse(email).success) err('email', 'Email address is not valid.')
        else {
          const norm = normalizeKey(email)
          const inFile = (emailRows.get(norm) ?? []).length > 1
          if (existingEmails.has(norm) || inFile) {
            const msg = existingEmails.has(norm) ? 'Another employee already uses this email address.' : `This email address appears more than once in this file (rows ${emailRows.get(norm)!.join(', ')}).`
            if (emailPolicy === 'reject') err('email', msg)
            else warn('email', msg)
          }
        }
      }
      const phone = values.phone || null
      if (phone && !PHONE_RE.test(phone)) err('phone', 'Phone may contain only digits, spaces and + ( ) - (3–30 characters).')
      const jobTitle = values.jobTitle || null
      if (jobTitle && jobTitle.length > 100) err('jobTitle', 'Job title is longer than 100 characters.')

      let departmentId: string | null = null
      if (values.department) {
        const key = normalizeKey(values.department)
        const d = departments.find((x) => x.code === key) ?? departments.find((x) => x.nm === key)
        if (!d) err('department', `Department "${values.department}" does not exist. Create it first or correct the value.`)
        else if (!d.a) err('department', `Department "${d.name}" is deactivated.`)
        else departmentId = d.id
      }

      let teamId: string | null = null
      if (values.team) {
        const key = normalizeKey(values.team)
        const byCode = teams.filter((t) => t.code === key)
        const byName = teams.filter((t) => t.nm === key && (!departmentId || t.d === departmentId))
        const candidates = byCode.length ? byCode : byName
        if (candidates.length === 0) err('team', `Team / process "${values.team}" does not exist${departmentId ? ' in this department' : ''}.`)
        else if (candidates.length > 1) err('team', `"${values.team}" matches teams in several departments. Add the department column or use the team code.`)
        else {
          const t = candidates[0]!
          if (!t.a) err('team', `Team / process "${t.name}" is deactivated.`)
          else if (departmentId && t.d !== departmentId) err('team', `Team / process "${t.name}" belongs to a different department.`)
          else if (!values.department || departmentId) {
            teamId = t.id
            departmentId = t.d
          }
        }
      }

      let workLocationId: string | null = null
      if (values.workLocation) {
        const key = normalizeKey(values.workLocation)
        const byCode = locations.filter((l) => l.code === key)
        const candidates = byCode.length ? byCode : locations.filter((l) => l.nm === key)
        if (candidates.length === 0) err('workLocation', `Location "${values.workLocation}" does not exist.`)
        else if (candidates.length > 1) err('workLocation', `Several locations are named "${values.workLocation}". Use the location code.`)
        else if (!candidates[0]!.a) err('workLocation', `Location "${values.workLocation}" is deactivated.`)
        else workLocationId = candidates[0]!.id
      }

      let employmentStatus: EmploymentStatus = 'active'
      if (values.employmentStatus) {
        const key = normalizeKey(values.employmentStatus)
        if (STATUS_ALIASES[key]) employmentStatus = STATUS_ALIASES[key]!
        else if (EXITED_WORDS.has(key)) err('employmentStatus', 'Exited employees cannot be imported. Import current employees only, or add them and record the exit with its date.')
        else err('employmentStatus', `Unknown status "${values.employmentStatus}". Use Active, On leave or Notice period.`)
      }

      const parseDateField = (f: 'joiningDate' | 'expectedExitDate'): string | null => {
        const v = values[f]
        if (!v) return null
        const iso = parseImportDate(v, dateFormat)
        if (!iso) {
          err(f, /^\d{5}$/.test(v) ? `"${v}" looks like an Excel date number. Format the column as a date and save again.` : `"${v}" is not a valid ${dateFormat} date.`)
        }
        return iso
      }
      const joiningDate = parseDateField('joiningDate')
      const expectedExitDate = parseDateField('expectedExitDate')
      if (joiningDate && expectedExitDate && expectedExitDate < joiningDate) err('expectedExitDate', 'Expected exit date is before the joining date.')

      work.push({
        view: { rowNumber: r.rowNumber, status: 'accepted', values, issues },
        resolved: {
          rowNumber: r.rowNumber, employeeCode: code, fullName, email, phone, jobTitle, departmentId, teamId, workLocationId,
          employmentStatus, joiningDate, expectedExitDate, managerExistingId: null, managerRowNumber: null
        },
        duplicate,
        managerCodeRaw: values.managerCode ?? ''
      })
    }

    // Manager references: an existing current employee, or another importable row in this file.
    const byRow = new Map(work.map((w) => [w.resolved.rowNumber, w]))
    for (const w of work) {
      const raw = w.managerCodeRaw
      if (!raw) continue
      const norm = normalizeEmployeeCode(raw)
      const err = (message: string) => w.view.issues.push({ field: 'managerCode', severity: 'error', message })
      if (w.resolved.employeeCode && norm === normalizeEmployeeCode(w.resolved.employeeCode)) {
        err('An employee cannot be their own manager.')
        continue
      }
      const ex = existing.get(norm)
      if (ex) {
        if (ex.s === 'exited') err(`Manager ${raw} has exited.`)
        else w.resolved.managerExistingId = ex.id
        continue
      }
      const rows = codeRows.get(norm) ?? []
      if (rows.length === 1) w.resolved.managerRowNumber = rows[0]!
      else if (rows.length > 1) err(`Manager ID ${raw} appears more than once in this file.`)
      else err(`Manager ID ${raw} was not found among existing employees or in this file.`)
    }

    const hasError = (w: Work) => w.view.issues.some((i) => i.severity === 'error')
    // Propagate: a row whose in-file manager will not be imported cannot be imported either.
    for (let changed = true; changed; ) {
      changed = false
      for (const w of work) {
        const mgrRow = w.resolved.managerRowNumber
        if (mgrRow === null || hasError(w)) continue
        const mgr = byRow.get(mgrRow)!
        if (hasError(mgr)) {
          w.view.issues.push({ field: 'managerCode', severity: 'error', message: `The manager's row (${mgrRow}) has errors and will not be imported.` })
          changed = true
        }
      }
    }
    // Reporting loops among new rows.
    for (const w of work) {
      if (hasError(w) || w.resolved.managerRowNumber === null) continue
      const seen = new Set<number>([w.resolved.rowNumber])
      let cur: number | null = w.resolved.managerRowNumber
      while (cur !== null) {
        if (seen.has(cur)) {
          w.view.issues.push({ field: 'managerCode', severity: 'error', message: 'Managers in this file form a reporting loop.' })
          break
        }
        seen.add(cur)
        cur = byRow.get(cur)?.resolved.managerRowNumber ?? null
      }
    }

    const importable: ResolvedRow[] = []
    const rows: ImportRowView[] = []
    for (const w of work) {
      const status: ImportRowStatus = w.duplicate ? 'duplicate' : hasError(w) ? 'rejected' : w.view.issues.length ? 'warning' : 'accepted'
      w.view.status = status
      rows.push(w.view)
      if (status === 'duplicate') counts.duplicates++
      else if (status === 'rejected') counts.rejected++
      else {
        counts.accepted++
        if (status === 'warning') counts.withWarnings++
        importable.push(w.resolved)
      }
    }
    return { fileIssues, rows, importable, counts }
  }
