import type { Database as DB } from 'better-sqlite3'
import type { EmployeeDetail, EmployeeListItem, Page } from '@shared/api'
import type { EmploymentStatus } from '@shared/organization'
import {
  createEmployeeSchema,
  deactivateEmployeeSchema,
  employeeSearchSchema,
  reactivateEmployeeSchema,
  updateEmployeeSchema,
  type CreateEmployeeInput,
  type DeactivateEmployeeInput,
  type EmployeeSearchInput,
  type ReactivateEmployeeInput,
  type UpdateEmployeeInput
} from '@shared/orgSchemas'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { assertPermission } from '../auth/permissions'
import { recordAudit } from './audit'
import { assertAnyPermission, likePattern, normalizeKey, normalizeOptional, requireRow } from './common'
import type { OpContext } from './context'
import { loadLocationPaths } from './organization'
import { getSettings } from './settings'
import { getOrganizationId } from './setup'

const VIEW = ['employees.view', 'employees.manage'] as const

/** Fields whose values are personal data: audit records only that they changed. */
const PERSONAL_FIELDS = ['fullName', 'email', 'phone', 'notes'] as const

export function normalizeEmployeeCode(code: string): string {
  return code.trim().toUpperCase()
}

// ------------------------------ Queries ------------------------------

export function searchEmployees(db: DB, raw: EmployeeSearchInput, ctx: OpContext): Page<EmployeeListItem> {
  assertAnyPermission(ctx, VIEW)
  const input = employeeSearchSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (input.query) {
    const p = likePattern(input.query)
    where.push("(e.employee_code LIKE ? ESCAPE '\\' OR e.full_name LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\')")
    params.push(p, p, p)
  }
  if (input.departmentId) {
    where.push('e.department_id = ?')
    params.push(input.departmentId)
  }
  if (input.teamId) {
    where.push('e.team_id = ?')
    params.push(input.teamId)
  }
  if (input.status === 'current') where.push("e.employment_status <> 'exited'")
  else if (input.status !== 'all') {
    where.push('e.employment_status = ?')
    params.push(input.status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT count(*) AS n FROM employees e ${whereSql}`).get(...params) as { n: number }).n
  const items = db
    .prepare(
      `SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.email, e.job_title AS jobTitle,
              d.name AS departmentName, t.name AS teamName, m.full_name AS managerName, e.employment_status AS employmentStatus
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN teams t ON t.id = e.team_id
       LEFT JOIN employees m ON m.id = e.manager_employee_id
       ${whereSql}
       ORDER BY e.full_name COLLATE NOCASE, e.employee_code
       LIMIT ? OFFSET ?`
    )
    .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as EmployeeListItem[]
  return { items, total, page: input.page, pageSize: input.pageSize }
}

export function getEmployee(db: DB, id: string, ctx?: OpContext): EmployeeDetail {
  if (ctx) assertAnyPermission(ctx, VIEW)
  const row = requireRow(
    db
      .prepare(
        `SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.email, e.phone, e.job_title AS jobTitle,
                e.department_id AS departmentId, d.name AS departmentName, e.team_id AS teamId, t.name AS teamName,
                e.manager_employee_id AS managerEmployeeId, m.full_name AS managerName, m.employment_status AS managerStatus,
                e.work_location_id AS workLocationId, e.employment_status AS employmentStatus, e.joining_date AS joiningDate,
                e.expected_exit_date AS expectedExitDate, e.actual_exit_date AS actualExitDate, e.notes,
                e.created_at AS createdAt, e.updated_at AS updatedAt
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN teams t ON t.id = e.team_id
         LEFT JOIN employees m ON m.id = e.manager_employee_id
         WHERE e.id = ?`
      )
      .get(id) as Omit<EmployeeDetail, 'workLocationPath' | 'directReports'> | undefined,
    'Employee'
  )
  const directReports = db
    .prepare(
      `SELECT id, employee_code AS employeeCode, full_name AS fullName, employment_status AS employmentStatus
       FROM employees WHERE manager_employee_id = ? ORDER BY full_name COLLATE NOCASE`
    )
    .all(id) as EmployeeDetail['directReports']
  const workLocationPath = row.workLocationId ? (loadLocationPaths(db).get(row.workLocationId)?.path ?? null) : null
  return { ...row, workLocationPath, directReports }
}

// ------------------------------ Validation ------------------------------

interface ResolvedRefs {
  departmentId: string | null
  teamId: string | null
}

function invalid(field: string, message: string): never {
  throw new AppError('VALIDATION_ERROR', message, { [field]: message })
}

/** Validates references; a team without a department implies the team's department. */
function resolveRefs(
  db: DB,
  input: { departmentId: string | null; teamId: string | null; managerEmployeeId: string | null; workLocationId: string | null },
  selfId: string | null
): ResolvedRefs {
  let departmentId = input.departmentId
  if (departmentId) {
    const d = db.prepare('SELECT is_active AS a FROM departments WHERE id = ?').get(departmentId) as { a: number } | undefined
    if (!d) invalid('departmentId', 'Department not found')
    if (!d.a) invalid('departmentId', 'Department is deactivated')
  }
  if (input.teamId) {
    const t = db.prepare('SELECT is_active AS a, department_id AS d FROM teams WHERE id = ?').get(input.teamId) as { a: number; d: string } | undefined
    if (!t) invalid('teamId', 'Team not found')
    if (!t.a) invalid('teamId', 'Team is deactivated')
    if (departmentId && t.d !== departmentId) invalid('teamId', 'The team belongs to a different department')
    departmentId = t.d
  }
  if (input.workLocationId) {
    const l = db.prepare('SELECT is_active AS a FROM locations WHERE id = ?').get(input.workLocationId) as { a: number } | undefined
    if (!l) invalid('workLocationId', 'Location not found')
    if (!l.a) invalid('workLocationId', 'Location is deactivated')
  }
  if (input.managerEmployeeId) {
    if (input.managerEmployeeId === selfId) invalid('managerEmployeeId', 'An employee cannot be their own manager')
    const m = db.prepare('SELECT employment_status AS s FROM employees WHERE id = ?').get(input.managerEmployeeId) as { s: EmploymentStatus } | undefined
    if (!m) invalid('managerEmployeeId', 'Manager not found')
    if (m.s === 'exited') invalid('managerEmployeeId', 'The selected manager has exited')
    if (selfId) assertNoManagerCycle(db, selfId, input.managerEmployeeId)
  }
  return { departmentId, teamId: input.teamId }
}

/** Walks up from the proposed manager; reaching the employee would create a reporting loop. */
function assertNoManagerCycle(db: DB, employeeId: string, managerId: string): void {
  const stmt = db.prepare('SELECT manager_employee_id AS m FROM employees WHERE id = ?')
  let cur: string | null = managerId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    if (cur === employeeId) invalid('managerEmployeeId', 'This manager reports (directly or indirectly) to the employee; that would create a reporting loop')
    seen.add(cur)
    cur = (stmt.get(cur) as { m: string | null } | undefined)?.m ?? null
  }
}

function checkUniqueness(db: DB, orgId: string, code: string, email: string | null, excludeId: string): void {
  const dupCode = db
    .prepare('SELECT employee_code AS c FROM employees WHERE organization_id = ? AND employee_code_normalized = ? AND id <> ?')
    .get(orgId, normalizeEmployeeCode(code), excludeId) as { c: string } | undefined
  if (dupCode) {
    throw new AppError('DUPLICATE_RECORD', `Employee ID ${dupCode.c} is already in use.`, { employeeCode: 'Already in use by another employee' })
  }
  if (email && getSettings(db).employeeDuplicateEmailPolicy === 'reject') {
    const dupEmail = db.prepare('SELECT 1 FROM employees WHERE email_normalized = ? AND id <> ?').get(normalizeKey(email), excludeId)
    if (dupEmail) throw new AppError('DUPLICATE_RECORD', 'Another employee already uses this email address.', { email: 'Already used by another employee' })
  }
}

function checkDates(joining: string | null, expectedExit: string | null): void {
  if (joining && expectedExit && expectedExit < joining) invalid('expectedExitDate', 'Expected exit date is before the joining date')
}

// ------------------------------ Mutations ------------------------------

export function createEmployee(db: DB, raw: CreateEmployeeInput, ctx: OpContext): EmployeeDetail {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = createEmployeeSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    checkUniqueness(db, orgId, input.employeeCode, input.email, id)
    checkDates(input.joiningDate, input.expectedExitDate)
    const refs = resolveRefs(db, input, null)
    const now = nowIso()
    db.prepare(
      `INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, email, email_normalized, phone, job_title,
                              department_id, team_id, manager_employee_id, work_location_id, employment_status, joining_date,
                              expected_exit_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, input.employeeCode, normalizeEmployeeCode(input.employeeCode), input.fullName, input.email, normalizeOptional(input.email),
      input.phone, input.jobTitle, refs.departmentId, refs.teamId, input.managerEmployeeId, input.workLocationId, input.employmentStatus,
      input.joiningDate, input.expectedExitDate, input.notes, now, now
    )
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'employee.created',
      entityType: 'employee',
      entityId: id,
      correlationId: ctx.correlationId,
      summary: { employeeCode: input.employeeCode, departmentId: refs.departmentId, teamId: refs.teamId, employmentStatus: input.employmentStatus }
    })
  })()
  return getEmployee(db, id)
}

export function updateEmployee(db: DB, raw: UpdateEmployeeInput, ctx: OpContext): EmployeeDetail {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = updateEmployeeSchema.parse(raw)
  db.transaction(() => {
    const before = getEmployee(db, input.id)
    if (before.employmentStatus === 'exited') {
      throw new AppError('STATE_CONFLICT', 'This employee has exited. Reactivate the record before editing it.')
    }
    checkUniqueness(db, getOrganizationId(db), input.employeeCode, input.email, input.id)
    checkDates(input.joiningDate, input.expectedExitDate)
    const refs = resolveRefs(db, input, input.id)
    db.prepare(
      `UPDATE employees SET employee_code = ?, employee_code_normalized = ?, full_name = ?, email = ?, email_normalized = ?, phone = ?, job_title = ?,
              department_id = ?, team_id = ?, manager_employee_id = ?, work_location_id = ?, employment_status = ?, joining_date = ?,
              expected_exit_date = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.employeeCode, normalizeEmployeeCode(input.employeeCode), input.fullName, input.email, normalizeOptional(input.email), input.phone,
      input.jobTitle, refs.departmentId, refs.teamId, input.managerEmployeeId, input.workLocationId, input.employmentStatus,
      input.joiningDate, input.expectedExitDate, input.notes, nowIso(), input.id
    )
    const after: Record<string, unknown> = { ...input, ...refs }
    const changed: Record<string, unknown> = {}
    const personalChanged: string[] = []
    for (const [key, value] of Object.entries(after)) {
      if (key === 'id') continue
      const prev = (before as unknown as Record<string, unknown>)[key]
      if (prev === value) continue
      if ((PERSONAL_FIELDS as readonly string[]).includes(key)) personalChanged.push(key)
      else changed[key] = { from: prev, to: value }
    }
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'employee.updated',
      entityType: 'employee',
      entityId: input.id,
      correlationId: ctx.correlationId,
      summary: { changed, personalFieldsChanged: personalChanged }
    })
  })()
  return getEmployee(db, input.id)
}

/**
 * Marks an employee as exited. The record, its references (manager, department, future
 * asset assignments) and audit history are kept. Deactivation never returns assets.
 */
export function deactivateEmployee(db: DB, raw: DeactivateEmployeeInput, ctx: OpContext): EmployeeDetail {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = deactivateEmployeeSchema.parse(raw)
  db.transaction(() => {
    const e = getEmployee(db, input.id)
    if (e.employmentStatus === 'exited') throw new AppError('STATE_CONFLICT', 'This employee is already marked as exited.')
    if (e.joiningDate && input.actualExitDate < e.joiningDate) invalid('actualExitDate', 'Exit date is before the joining date')
    db.prepare("UPDATE employees SET employment_status = 'exited', actual_exit_date = ?, updated_at = ? WHERE id = ?").run(input.actualExitDate, nowIso(), input.id)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'employee.deactivated',
      entityType: 'employee',
      entityId: input.id,
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: { employeeCode: e.employeeCode, previousStatus: e.employmentStatus, actualExitDate: input.actualExitDate, directReports: e.directReports.length }
    })
  })()
  return getEmployee(db, input.id)
}

export function reactivateEmployee(db: DB, raw: ReactivateEmployeeInput, ctx: OpContext): EmployeeDetail {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = reactivateEmployeeSchema.parse(raw)
  db.transaction(() => {
    const e = getEmployee(db, input.id)
    if (e.employmentStatus !== 'exited') throw new AppError('STATE_CONFLICT', 'This employee is not marked as exited.')
    db.prepare("UPDATE employees SET employment_status = 'active', actual_exit_date = NULL, updated_at = ? WHERE id = ?").run(nowIso(), input.id)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'employee.reactivated',
      entityType: 'employee',
      entityId: input.id,
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: { employeeCode: e.employeeCode, previousExitDate: e.actualExitDate }
    })
  })()
  return getEmployee(db, input.id)
}
