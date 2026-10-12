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
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { auditFrom, getSettings, recordAudit } from './foundation'
import { invalid, likePattern, normalizeKey, normalizeOptional, Params, requireRow } from './common'
import { loadLocationPaths } from './organization'

const VIEW = ['employees.view', 'employees.manage'] as const
/** Personal fields are audited as "changed" without their values. */
const PERSONAL_FIELDS = ['fullName', 'email', 'phone', 'notes'] as const

export const normalizeEmployeeCode = (code: string): string => code.trim().toUpperCase()

export async function searchEmployees(db: Db, raw: EmployeeSearchInput, ctx: OpContext): Promise<Page<EmployeeListItem>> {
  assertAnyPermission(ctx, VIEW)
  const input = employeeSearchSchema.parse(raw)
  const p = new Params()
  const where = [`e.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (input.query) {
    const q = p.add(likePattern(input.query))
    where.push(`(e.employee_code ILIKE ${q} ESCAPE '\\' OR e.full_name ILIKE ${q} ESCAPE '\\' OR e.email ILIKE ${q} ESCAPE '\\')`)
  }
  if (input.departmentId) where.push(`e.department_id = ${p.add(input.departmentId)}`)
  if (input.teamId) where.push(`e.team_id = ${p.add(input.teamId)}`)
  if (input.status === 'current') where.push("e.employment_status <> 'exited'")
  else if (input.status !== 'all') where.push(`e.employment_status = ${p.add(input.status)}`)
  const whereSql = where.join(' AND ')
  const total = (await db.one<{ n: number }>(`SELECT count(*) AS n FROM employees e WHERE ${whereSql}`, p.values))!.n
  const items = await db.many<EmployeeListItem>(
    `SELECT e.id, e.employee_code AS "employeeCode", e.full_name AS "fullName", e.email, e.job_title AS "jobTitle",
            d.name AS "departmentName", t.name AS "teamName", m.full_name AS "managerName", e.employment_status AS "employmentStatus"
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN employees m ON m.id = e.manager_employee_id
     WHERE ${whereSql} ORDER BY lower(e.full_name), e.employee_code LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  return { items, total, page: input.page, pageSize: input.pageSize }
}

export async function getEmployee(c: SqlClient, id: string, ctx: OpContext, checkPermission = true): Promise<EmployeeDetail> {
  if (checkPermission) assertAnyPermission(ctx, VIEW)
  const row = requireRow(
    await c.one<Omit<EmployeeDetail, 'workLocationPath' | 'directReports'>>(
      `SELECT e.id, e.employee_code AS "employeeCode", e.full_name AS "fullName", e.email, e.phone, e.job_title AS "jobTitle",
              e.department_id AS "departmentId", d.name AS "departmentName", e.team_id AS "teamId", t.name AS "teamName",
              e.manager_employee_id AS "managerEmployeeId", m.full_name AS "managerName", m.employment_status AS "managerStatus",
              e.work_location_id AS "workLocationId", e.employment_status AS "employmentStatus", e.joining_date AS "joiningDate",
              e.expected_exit_date AS "expectedExitDate", e.actual_exit_date AS "actualExitDate", e.notes, e.created_at AS "createdAt", e.updated_at AS "updatedAt"
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN employees m ON m.id = e.manager_employee_id
       WHERE e.id = $1 AND e.organization_id = $2`,
      [id, ctx.actor.organizationId]
    ),
    'Employee'
  )
  const directReports = await c.many<EmployeeDetail['directReports'][number]>(
    `SELECT id, employee_code AS "employeeCode", full_name AS "fullName", employment_status AS "employmentStatus"
     FROM employees WHERE manager_employee_id = $1 AND organization_id = $2 ORDER BY lower(full_name)`,
    [id, ctx.actor.organizationId]
  )
  const workLocationPath = row.workLocationId ? ((await loadLocationPaths(c, ctx.actor.organizationId)).get(row.workLocationId)?.path ?? null) : null
  return { ...row, workLocationPath, directReports }
}

async function resolveRefs(
  c: SqlClient,
  ctx: OpContext,
  input: { departmentId: string | null; teamId: string | null; managerEmployeeId: string | null; workLocationId: string | null },
  selfId: string | null
): Promise<{ departmentId: string | null; teamId: string | null }> {
  const org = ctx.actor.organizationId
  let departmentId = input.departmentId
  if (departmentId) {
    const d = await c.one<{ a: boolean }>('SELECT is_active AS a FROM departments WHERE id = $1 AND organization_id = $2', [departmentId, org])
    if (!d) invalid('departmentId', 'Department not found')
    if (!d.a) invalid('departmentId', 'Department is deactivated')
  }
  if (input.teamId) {
    const t = await c.one<{ a: boolean; d: string }>('SELECT is_active AS a, department_id AS d FROM teams WHERE id = $1 AND organization_id = $2', [input.teamId, org])
    if (!t) invalid('teamId', 'Team not found')
    if (!t.a) invalid('teamId', 'Team is deactivated')
    if (departmentId && t.d !== departmentId) invalid('teamId', 'The team belongs to a different department')
    departmentId = t.d
  }
  if (input.workLocationId) {
    const l = await c.one<{ a: boolean }>('SELECT is_active AS a FROM locations WHERE id = $1 AND organization_id = $2', [input.workLocationId, org])
    if (!l) invalid('workLocationId', 'Location not found')
    if (!l.a) invalid('workLocationId', 'Location is deactivated')
  }
  if (input.managerEmployeeId) {
    if (input.managerEmployeeId === selfId) invalid('managerEmployeeId', 'An employee cannot be their own manager')
    const m = await c.one<{ s: EmploymentStatus }>('SELECT employment_status AS s FROM employees WHERE id = $1 AND organization_id = $2', [input.managerEmployeeId, org])
    if (!m) invalid('managerEmployeeId', 'Manager not found')
    if (m.s === 'exited') invalid('managerEmployeeId', 'The selected manager has exited')
    if (selfId) {
      // Walk up from the proposed manager; reaching the employee would create a reporting loop.
      let cur: string | null = input.managerEmployeeId
      const seen = new Set<string>()
      while (cur && !seen.has(cur)) {
        if (cur === selfId) invalid('managerEmployeeId', 'This manager reports (directly or indirectly) to the employee; that would create a reporting loop')
        seen.add(cur)
        cur = (await c.one<{ m: string | null }>('SELECT manager_employee_id AS m FROM employees WHERE id = $1', [cur]))?.m ?? null
      }
    }
  }
  return { departmentId, teamId: input.teamId }
}

async function checkUniqueness(c: SqlClient, ctx: OpContext, code: string, email: string | null, excludeId: string): Promise<void> {
  const org = ctx.actor.organizationId
  const dup = await c.one<{ c: string }>('SELECT employee_code AS c FROM employees WHERE organization_id = $1 AND employee_code_normalized = $2 AND id <> $3', [org, normalizeEmployeeCode(code), excludeId])
  if (dup) throw new AppError('DUPLICATE_RECORD', `Employee ID ${dup.c} is already in use.`, { employeeCode: 'Already in use by another employee' })
  if (email && (await getSettings(c, org)).employeeDuplicateEmailPolicy === 'reject') {
    if (await c.one('SELECT 1 FROM employees WHERE organization_id = $1 AND email_normalized = $2 AND id <> $3', [org, normalizeKey(email), excludeId])) {
      throw new AppError('DUPLICATE_RECORD', 'Another employee already uses this email address.', { email: 'Already used by another employee' })
    }
  }
}

export async function createEmployee(db: Db, raw: CreateEmployeeInput, ctx: OpContext): Promise<EmployeeDetail> {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = createEmployeeSchema.parse(raw)
  if (input.joiningDate && input.expectedExitDate && input.expectedExitDate < input.joiningDate) invalid('expectedExitDate', 'Expected exit date is before the joining date')
  const id = newId()
  return db.tx(async (t) => {
    await checkUniqueness(t, ctx, input.employeeCode, input.email, id)
    const refs = await resolveRefs(t, ctx, input, null)
    await t.exec(
      `INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, email, email_normalized, phone, job_title,
                              department_id, team_id, manager_employee_id, work_location_id, employment_status, joining_date, expected_exit_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [id, ctx.actor.organizationId, input.employeeCode, normalizeEmployeeCode(input.employeeCode), input.fullName, input.email, normalizeOptional(input.email),
        input.phone, input.jobTitle, refs.departmentId, refs.teamId, input.managerEmployeeId, input.workLocationId, input.employmentStatus, input.joiningDate, input.expectedExitDate, input.notes]
    )
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'employee.created', entityType: 'employee', entityId: id, summary: { employeeCode: input.employeeCode, departmentId: refs.departmentId, teamId: refs.teamId, employmentStatus: input.employmentStatus } })
    return getEmployee(t, id, ctx, false)
  })
}

export async function updateEmployee(db: Db, raw: UpdateEmployeeInput, ctx: OpContext): Promise<EmployeeDetail> {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = updateEmployeeSchema.parse(raw)
  if (input.joiningDate && input.expectedExitDate && input.expectedExitDate < input.joiningDate) invalid('expectedExitDate', 'Expected exit date is before the joining date')
  return db.tx(async (t) => {
    const before = await getEmployee(t, input.id, ctx, false)
    if (before.employmentStatus === 'exited') throw new AppError('STATE_CONFLICT', 'This employee has exited. Reactivate the record before editing it.')
    await checkUniqueness(t, ctx, input.employeeCode, input.email, input.id)
    const refs = await resolveRefs(t, ctx, input, input.id)
    await t.exec(
      `UPDATE employees SET employee_code = $2, employee_code_normalized = $3, full_name = $4, email = $5, email_normalized = $6, phone = $7, job_title = $8,
              department_id = $9, team_id = $10, manager_employee_id = $11, work_location_id = $12, employment_status = $13, joining_date = $14,
              expected_exit_date = $15, notes = $16, updated_at = now() WHERE id = $1`,
      [input.id, input.employeeCode, normalizeEmployeeCode(input.employeeCode), input.fullName, input.email, normalizeOptional(input.email), input.phone, input.jobTitle,
        refs.departmentId, refs.teamId, input.managerEmployeeId, input.workLocationId, input.employmentStatus, input.joiningDate, input.expectedExitDate, input.notes]
    )
    const after: Record<string, unknown> = { ...input, ...refs }
    const changed: Record<string, unknown> = {}
    const personalFieldsChanged: string[] = []
    for (const [key, value] of Object.entries(after)) {
      if (key === 'id') continue
      const prev = (before as unknown as Record<string, unknown>)[key]
      if (prev === value) continue
      if ((PERSONAL_FIELDS as readonly string[]).includes(key)) personalFieldsChanged.push(key)
      else changed[key] = { from: prev, to: value }
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'employee.updated', entityType: 'employee', entityId: input.id, summary: { changed, personalFieldsChanged } })
    return getEmployee(t, input.id, ctx, false)
  })
}

/** Marks an employee as exited; record, references and history are kept. Never returns assets. */
export async function deactivateEmployee(db: Db, raw: DeactivateEmployeeInput, ctx: OpContext): Promise<EmployeeDetail> {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = deactivateEmployeeSchema.parse(raw)
  return db.tx(async (t) => {
    const e = await getEmployee(t, input.id, ctx, false)
    if (e.employmentStatus === 'exited') throw new AppError('STATE_CONFLICT', 'This employee is already marked as exited.')
    if (e.joiningDate && input.actualExitDate < e.joiningDate) invalid('actualExitDate', 'Exit date is before the joining date')
    await t.exec("UPDATE employees SET employment_status = 'exited', actual_exit_date = $2, updated_at = now() WHERE id = $1", [input.id, input.actualExitDate])
    await recordAudit(t, {
      ...auditFrom(ctx),
      eventType: 'employee.deactivated',
      entityType: 'employee',
      entityId: input.id,
      reason: input.reason,
      summary: { employeeCode: e.employeeCode, previousStatus: e.employmentStatus, actualExitDate: input.actualExitDate, directReports: e.directReports.length }
    })
    return getEmployee(t, input.id, ctx, false)
  })
}

export async function reactivateEmployee(db: Db, raw: ReactivateEmployeeInput, ctx: OpContext): Promise<EmployeeDetail> {
  assertPermission(ctx.actor.permissions, 'employees.manage')
  const input = reactivateEmployeeSchema.parse(raw)
  return db.tx(async (t) => {
    const e = await getEmployee(t, input.id, ctx, false)
    if (e.employmentStatus !== 'exited') throw new AppError('STATE_CONFLICT', 'This employee is not marked as exited.')
    await t.exec("UPDATE employees SET employment_status = 'active', actual_exit_date = NULL, updated_at = now() WHERE id = $1", [input.id])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'employee.reactivated', entityType: 'employee', entityId: input.id, reason: input.reason, summary: { employeeCode: e.employeeCode, previousExitDate: e.actualExitDate } })
    return getEmployee(t, input.id, ctx, false)
  })
}
