import type { Database as DB } from 'better-sqlite3'
import type { DepartmentView, LocationView, PoolView, TeamView, WorkstationView } from '@shared/api'
import { LOCATION_PARENT_RULES, LOCATION_TYPE_LABELS, WORKSTATION_LOCATION_TYPES, type LocationType } from '@shared/organization'
import {
  createDepartmentSchema,
  createLocationSchema,
  createPoolSchema,
  createTeamSchema,
  createWorkstationSchema,
  listInputSchema,
  setActiveInputSchema,
  teamListInputSchema,
  updateDepartmentSchema,
  updateLocationSchema,
  updatePoolSchema,
  updateTeamSchema,
  updateWorkstationSchema,
  workstationListInputSchema,
  type CreateDepartmentInput,
  type CreateLocationInput,
  type CreatePoolInput,
  type CreateTeamInput,
  type CreateWorkstationInput,
  type ListInput,
  type SetActiveInput,
  type TeamListInput,
  type UpdateDepartmentInput,
  type UpdateLocationInput,
  type UpdatePoolInput,
  type UpdateTeamInput,
  type UpdateWorkstationInput,
  type WorkstationListInput
} from '@shared/orgSchemas'
import { assertPermission } from '../auth/permissions'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { recordAudit } from './audit'
import { assertAnyPermission, assertUnique, likePattern, normalizeKey, normalizeOptional, ORG_VIEW_PERMISSIONS, requireRow } from './common'
import type { OpContext } from './context'
import { getOrganizationId } from './setup'

const CURRENT_EMPLOYEE = "employment_status <> 'exited'"

function conflict(message: string): never {
  throw new AppError('STATE_CONFLICT', message)
}

function audit(db: DB, ctx: OpContext, eventType: string, entityType: string, entityId: string, summary: Record<string, unknown>, reason?: string): void {
  recordAudit(db, { actorUserId: ctx.actor.userId, eventType, entityType, entityId, correlationId: ctx.correlationId, summary, reason: reason ?? null })
}

/** An employee referenced as manager/lead must exist and not have exited. */
function assertCurrentEmployee(db: DB, id: string | null, field: string): void {
  if (!id) return
  const row = db.prepare('SELECT employment_status AS s FROM employees WHERE id = ?').get(id) as { s: string } | undefined
  if (!row) throw new AppError('VALIDATION_ERROR', 'The selected employee does not exist.', { [field]: 'Employee not found' })
  if (row.s === 'exited') throw new AppError('VALIDATION_ERROR', 'The selected employee has exited.', { [field]: 'Employee has exited' })
}

function assertActive(db: DB, table: 'departments' | 'teams' | 'locations', id: string | null, field: string, label: string): void {
  if (!id) return
  const row = db.prepare(`SELECT is_active AS a FROM ${table} WHERE id = ?`).get(id) as { a: number } | undefined
  if (!row) throw new AppError('VALIDATION_ERROR', `${label} not found.`, { [field]: `${label} not found` })
  if (!row.a) throw new AppError('VALIDATION_ERROR', `${label} is deactivated.`, { [field]: `${label} is deactivated` })
}

// =============================== Departments ===============================

const DEPARTMENT_SELECT = `
  SELECT d.id, d.code, d.name, d.manager_employee_id AS managerEmployeeId, m.full_name AS managerName, d.notes,
         d.is_active AS isActive, d.updated_at AS updatedAt,
         (SELECT count(*) FROM teams t WHERE t.department_id = d.id AND t.is_active = 1) AS activeTeamCount,
         (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.${CURRENT_EMPLOYEE}) AS currentEmployeeCount
  FROM departments d LEFT JOIN employees m ON m.id = d.manager_employee_id`

type Flagged<T> = Omit<T, 'isActive'> & { isActive: number }
const unflag = <T extends { isActive: boolean }>(r: Flagged<T>): T => ({ ...r, isActive: Boolean(r.isActive) }) as unknown as T

export function listDepartments(db: DB, raw: ListInput, ctx: OpContext): DepartmentView[] {
  assertAnyPermission(ctx, ORG_VIEW_PERMISSIONS)
  const input = listInputSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (!input.includeInactive) where.push('d.is_active = 1')
  if (input.search) {
    where.push("(d.name LIKE ? ESCAPE '\\' OR d.code LIKE ? ESCAPE '\\')")
    params.push(likePattern(input.search), likePattern(input.search))
  }
  const sql = `${DEPARTMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.name COLLATE NOCASE`
  return (db.prepare(sql).all(...params) as Flagged<DepartmentView>[]).map(unflag)
}

function getDepartment(db: DB, id: string): DepartmentView {
  return unflag(requireRow(db.prepare(`${DEPARTMENT_SELECT} WHERE d.id = ?`).get(id) as Flagged<DepartmentView> | undefined, 'Department'))
}

function checkDepartmentUnique(db: DB, orgId: string, name: string, code: string | null, excludeId: string): void {
  assertUnique(db, 'SELECT 1 FROM departments WHERE organization_id = ? AND name_normalized = ? AND id <> ?', [orgId, normalizeKey(name), excludeId], 'name', 'A department with this name already exists.')
  if (code) assertUnique(db, 'SELECT 1 FROM departments WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [orgId, normalizeKey(code), excludeId], 'code', 'A department with this code already exists.')
}

export function createDepartment(db: DB, raw: CreateDepartmentInput, ctx: OpContext): DepartmentView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createDepartmentSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    checkDepartmentUnique(db, orgId, input.name, input.code, id)
    assertCurrentEmployee(db, input.managerEmployeeId, 'managerEmployeeId')
    const now = nowIso()
    db.prepare(
      `INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, manager_employee_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.managerEmployeeId, input.notes, now, now)
    audit(db, ctx, 'department.created', 'department', id, { name: input.name, code: input.code, managerEmployeeId: input.managerEmployeeId })
  })()
  return getDepartment(db, id)
}

export function updateDepartment(db: DB, raw: UpdateDepartmentInput, ctx: OpContext): DepartmentView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateDepartmentSchema.parse(raw)
  db.transaction(() => {
    const before = getDepartment(db, input.id)
    checkDepartmentUnique(db, getOrganizationId(db), input.name, input.code, input.id)
    if (input.managerEmployeeId !== before.managerEmployeeId) assertCurrentEmployee(db, input.managerEmployeeId, 'managerEmployeeId')
    db.prepare(
      'UPDATE departments SET code = ?, code_normalized = ?, name = ?, name_normalized = ?, manager_employee_id = ?, notes = ?, updated_at = ? WHERE id = ?'
    ).run(input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.managerEmployeeId, input.notes, nowIso(), input.id)
    audit(db, ctx, 'department.updated', 'department', input.id, {
      before: { name: before.name, code: before.code, managerEmployeeId: before.managerEmployeeId },
      after: { name: input.name, code: input.code, managerEmployeeId: input.managerEmployeeId }
    })
  })()
  return getDepartment(db, input.id)
}

export function setDepartmentActive(db: DB, raw: SetActiveInput, ctx: OpContext): DepartmentView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  db.transaction(() => {
    const d = getDepartment(db, input.id)
    if (d.isActive === input.isActive) return
    if (!input.isActive) {
      if (d.activeTeamCount > 0) conflict(`Deactivate or move the ${d.activeTeamCount} active team(s) in this department first.`)
      if (d.currentEmployeeCount > 0) conflict(`Move the ${d.currentEmployeeCount} current employee(s) to another department first.`)
      const pools = (db.prepare('SELECT count(*) AS n FROM asset_pools WHERE responsible_department_id = ? AND is_active = 1').get(input.id) as { n: number }).n
      if (pools > 0) conflict(`Reassign the ${pools} active asset pool(s) this department is responsible for first.`)
    }
    db.prepare('UPDATE departments SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'department.reactivated' : 'department.deactivated', 'department', input.id, { name: d.name }, input.reason)
  })()
  return getDepartment(db, input.id)
}

// =============================== Teams ===============================

const TEAM_SELECT = `
  SELECT t.id, t.department_id AS departmentId, d.name AS departmentName, t.kind, t.code, t.name,
         t.lead_employee_id AS leadEmployeeId, l.full_name AS leadName, t.notes, t.is_active AS isActive,
         (SELECT count(*) FROM employees e WHERE e.team_id = t.id AND e.${CURRENT_EMPLOYEE}) AS currentEmployeeCount
  FROM teams t JOIN departments d ON d.id = t.department_id LEFT JOIN employees l ON l.id = t.lead_employee_id`

export function listTeams(db: DB, raw: TeamListInput, ctx: OpContext): TeamView[] {
  assertAnyPermission(ctx, ORG_VIEW_PERMISSIONS)
  const input = teamListInputSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (!input.includeInactive) where.push('t.is_active = 1')
  if (input.departmentId) {
    where.push('t.department_id = ?')
    params.push(input.departmentId)
  }
  if (input.search) {
    where.push("(t.name LIKE ? ESCAPE '\\' OR t.code LIKE ? ESCAPE '\\')")
    params.push(likePattern(input.search), likePattern(input.search))
  }
  const sql = `${TEAM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.name COLLATE NOCASE, t.name COLLATE NOCASE`
  return (db.prepare(sql).all(...params) as Flagged<TeamView>[]).map(unflag)
}

function getTeam(db: DB, id: string): TeamView {
  return unflag(requireRow(db.prepare(`${TEAM_SELECT} WHERE t.id = ?`).get(id) as Flagged<TeamView> | undefined, 'Team'))
}

function checkTeamUnique(db: DB, orgId: string, departmentId: string, name: string, code: string | null, excludeId: string): void {
  assertUnique(db, 'SELECT 1 FROM teams WHERE department_id = ? AND name_normalized = ? AND id <> ?', [departmentId, normalizeKey(name), excludeId], 'name', 'This department already has a team with this name.')
  if (code) assertUnique(db, 'SELECT 1 FROM teams WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [orgId, normalizeKey(code), excludeId], 'code', 'A team with this code already exists.')
}

export function createTeam(db: DB, raw: CreateTeamInput, ctx: OpContext): TeamView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createTeamSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    assertActive(db, 'departments', input.departmentId, 'departmentId', 'Department')
    checkTeamUnique(db, orgId, input.departmentId, input.name, input.code, id)
    assertCurrentEmployee(db, input.leadEmployeeId, 'leadEmployeeId')
    const now = nowIso()
    db.prepare(
      `INSERT INTO teams (id, organization_id, department_id, kind, code, code_normalized, name, name_normalized, lead_employee_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.departmentId, input.kind, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.leadEmployeeId, input.notes, now, now)
    audit(db, ctx, 'team.created', 'team', id, { name: input.name, kind: input.kind, departmentId: input.departmentId })
  })()
  return getTeam(db, id)
}

export function updateTeam(db: DB, raw: UpdateTeamInput, ctx: OpContext): TeamView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateTeamSchema.parse(raw)
  db.transaction(() => {
    const before = getTeam(db, input.id)
    if (input.departmentId !== before.departmentId) {
      assertActive(db, 'departments', input.departmentId, 'departmentId', 'Department')
      // Employees' team must belong to their department; moving a staffed team would break that.
      if (before.currentEmployeeCount > 0) conflict(`Move the ${before.currentEmployeeCount} current employee(s) out of this team before changing its department.`)
    }
    checkTeamUnique(db, getOrganizationId(db), input.departmentId, input.name, input.code, input.id)
    if (input.leadEmployeeId !== before.leadEmployeeId) assertCurrentEmployee(db, input.leadEmployeeId, 'leadEmployeeId')
    db.prepare(
      'UPDATE teams SET department_id = ?, kind = ?, code = ?, code_normalized = ?, name = ?, name_normalized = ?, lead_employee_id = ?, notes = ?, updated_at = ? WHERE id = ?'
    ).run(input.departmentId, input.kind, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.leadEmployeeId, input.notes, nowIso(), input.id)
    audit(db, ctx, 'team.updated', 'team', input.id, {
      before: { name: before.name, kind: before.kind, departmentId: before.departmentId, leadEmployeeId: before.leadEmployeeId },
      after: { name: input.name, kind: input.kind, departmentId: input.departmentId, leadEmployeeId: input.leadEmployeeId }
    })
  })()
  return getTeam(db, input.id)
}

export function setTeamActive(db: DB, raw: SetActiveInput, ctx: OpContext): TeamView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  db.transaction(() => {
    const t = getTeam(db, input.id)
    if (t.isActive === input.isActive) return
    if (input.isActive) {
      assertActive(db, 'departments', t.departmentId, 'departmentId', 'Department')
    } else {
      if (t.currentEmployeeCount > 0) conflict(`Move the ${t.currentEmployeeCount} current employee(s) to another team first.`)
      const pools = (db.prepare('SELECT count(*) AS n FROM asset_pools WHERE responsible_team_id = ? AND is_active = 1').get(input.id) as { n: number }).n
      if (pools > 0) conflict(`Reassign the ${pools} active asset pool(s) this team is responsible for first.`)
    }
    db.prepare('UPDATE teams SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'team.reactivated' : 'team.deactivated', 'team', input.id, { name: t.name }, input.reason)
  })()
  return getTeam(db, input.id)
}

// =============================== Locations ===============================

interface LocationRow {
  id: string
  parentLocationId: string | null
  locationType: LocationType
  code: string | null
  name: string
  notes: string | null
  isActive: number
}

/** Loads the whole hierarchy once; location counts are small (hundreds) for one BPO. */
export function loadLocationPaths(db: DB): Map<string, { row: LocationRow; path: string }> {
  const rows = db
    .prepare('SELECT id, parent_location_id AS parentLocationId, location_type AS locationType, code, name, notes, is_active AS isActive FROM locations')
    .all() as LocationRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Map<string, { row: LocationRow; path: string }>()
  for (const r of rows) {
    const names: string[] = []
    let cur: LocationRow | undefined = r
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      names.unshift(cur.name)
      cur = cur.parentLocationId ? byId.get(cur.parentLocationId) : undefined
    }
    out.set(r.id, { row: r, path: names.join(' / ') })
  }
  return out
}

function toLocationView(db: DB, paths: Map<string, { row: LocationRow; path: string }>, id: string): LocationView {
  const entry = requireRow(paths.get(id), 'Location')
  const counts = db
    .prepare(
      `SELECT (SELECT count(*) FROM locations WHERE parent_location_id = ? AND is_active = 1) AS c,
              (SELECT count(*) FROM workstations WHERE location_id = ? AND is_active = 1) AS w`
    )
    .get(id, id) as { c: number; w: number }
  const { isActive, ...rest } = entry.row
  return { ...rest, isActive: Boolean(isActive), path: entry.path, activeChildCount: counts.c, activeWorkstationCount: counts.w }
}

export function listLocations(db: DB, raw: ListInput, ctx: OpContext): LocationView[] {
  assertAnyPermission(ctx, ORG_VIEW_PERMISSIONS)
  const input = listInputSchema.parse(raw)
  const paths = loadLocationPaths(db)
  const search = input.search ? normalizeKey(input.search) : null
  return [...paths.values()]
    .filter(({ row, path }) => (input.includeInactive || row.isActive) && (!search || path.toLowerCase().includes(search) || (row.code ?? '').toLowerCase().includes(search)))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
    .map(({ row }) => toLocationView(db, paths, row.id))
}

function assertParentAllowed(db: DB, type: LocationType, parentId: string | null): void {
  const allowed = LOCATION_PARENT_RULES[type]
  if (!parentId) {
    if (!allowed.includes(null)) {
      throw new AppError('VALIDATION_ERROR', `A ${LOCATION_TYPE_LABELS[type].toLowerCase()} must be placed inside another location.`, { parentLocationId: 'Choose a parent location' })
    }
    return
  }
  const parent = db.prepare('SELECT location_type AS t, is_active AS a FROM locations WHERE id = ?').get(parentId) as { t: LocationType; a: number } | undefined
  if (!parent) throw new AppError('VALIDATION_ERROR', 'Parent location not found.', { parentLocationId: 'Parent location not found' })
  if (!parent.a) throw new AppError('VALIDATION_ERROR', 'Parent location is deactivated.', { parentLocationId: 'Parent location is deactivated' })
  if (!allowed.includes(parent.t)) {
    const names = allowed.map((t) => (t ? LOCATION_TYPE_LABELS[t].toLowerCase() : 'top level')).join(', ')
    throw new AppError('VALIDATION_ERROR', `A ${LOCATION_TYPE_LABELS[type].toLowerCase()} cannot be inside a ${LOCATION_TYPE_LABELS[parent.t].toLowerCase()}. Allowed: ${names}.`, {
      parentLocationId: 'Not an allowed parent for this type'
    })
  }
}

function checkLocationUnique(db: DB, orgId: string, parentId: string | null, name: string, code: string | null, excludeId: string): void {
  assertUnique(
    db,
    "SELECT 1 FROM locations WHERE organization_id = ? AND COALESCE(parent_location_id, '') = ? AND name_normalized = ? AND id <> ?",
    [orgId, parentId ?? '', normalizeKey(name), excludeId],
    'name',
    'A location with this name already exists at this level.'
  )
  if (code) assertUnique(db, 'SELECT 1 FROM locations WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [orgId, normalizeKey(code), excludeId], 'code', 'A location with this code already exists.')
}

export function createLocation(db: DB, raw: CreateLocationInput, ctx: OpContext): LocationView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createLocationSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    assertParentAllowed(db, input.locationType, input.parentLocationId)
    checkLocationUnique(db, orgId, input.parentLocationId, input.name, input.code, id)
    const now = nowIso()
    db.prepare(
      `INSERT INTO locations (id, organization_id, parent_location_id, location_type, code, code_normalized, name, name_normalized, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.parentLocationId, input.locationType, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.notes, now, now)
    audit(db, ctx, 'location.created', 'location', id, { name: input.name, type: input.locationType, parentLocationId: input.parentLocationId })
  })()
  return toLocationView(db, loadLocationPaths(db), id)
}

export function updateLocation(db: DB, raw: UpdateLocationInput, ctx: OpContext): LocationView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateLocationSchema.parse(raw)
  db.transaction(() => {
    const paths = loadLocationPaths(db)
    const before = requireRow(paths.get(input.id), 'Location').row
    const structural = before.locationType !== input.locationType || before.parentLocationId !== input.parentLocationId
    if (structural) {
      assertParentAllowed(db, input.locationType, input.parentLocationId)
      // Cycle check: the new parent must not be this location or one of its descendants.
      let cur = input.parentLocationId
      while (cur) {
        if (cur === input.id) conflict('A location cannot be moved inside itself or one of its own sub-locations.')
        cur = paths.get(cur)?.row.parentLocationId ?? null
      }
      if (before.locationType !== input.locationType) {
        const children = db.prepare('SELECT location_type AS t FROM locations WHERE parent_location_id = ? AND is_active = 1').all(input.id) as Array<{ t: LocationType }>
        const bad = children.find((c) => !LOCATION_PARENT_RULES[c.t].includes(input.locationType))
        if (bad) conflict(`This location contains a ${LOCATION_TYPE_LABELS[bad.t].toLowerCase()}, which cannot sit inside a ${LOCATION_TYPE_LABELS[input.locationType].toLowerCase()}.`)
        const ws = (db.prepare('SELECT count(*) AS n FROM workstations WHERE location_id = ? AND is_active = 1').get(input.id) as { n: number }).n
        if (ws > 0 && !WORKSTATION_LOCATION_TYPES.includes(input.locationType)) {
          conflict(`This location has ${ws} active workstation(s); a ${LOCATION_TYPE_LABELS[input.locationType].toLowerCase()} cannot hold workstations.`)
        }
      }
    }
    checkLocationUnique(db, getOrganizationId(db), input.parentLocationId, input.name, input.code, input.id)
    db.prepare(
      'UPDATE locations SET parent_location_id = ?, location_type = ?, code = ?, code_normalized = ?, name = ?, name_normalized = ?, notes = ?, updated_at = ? WHERE id = ?'
    ).run(input.parentLocationId, input.locationType, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.notes, nowIso(), input.id)
    audit(db, ctx, 'location.updated', 'location', input.id, {
      before: { name: before.name, type: before.locationType, parentLocationId: before.parentLocationId, code: before.code },
      after: { name: input.name, type: input.locationType, parentLocationId: input.parentLocationId, code: input.code }
    })
  })()
  return toLocationView(db, loadLocationPaths(db), input.id)
}

export function setLocationActive(db: DB, raw: SetActiveInput, ctx: OpContext): LocationView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  db.transaction(() => {
    const paths = loadLocationPaths(db)
    const loc = toLocationView(db, paths, input.id)
    if (loc.isActive === input.isActive) return
    if (input.isActive) {
      if (loc.parentLocationId) assertActive(db, 'locations', loc.parentLocationId, 'parentLocationId', 'Parent location')
    } else {
      if (loc.activeChildCount > 0) conflict(`Deactivate the ${loc.activeChildCount} active sub-location(s) first.`)
      if (loc.activeWorkstationCount > 0) conflict(`Deactivate the ${loc.activeWorkstationCount} active workstation(s) at this location first.`)
      const staff = (db.prepare(`SELECT count(*) AS n FROM employees WHERE work_location_id = ? AND ${CURRENT_EMPLOYEE}`).get(input.id) as { n: number }).n
      if (staff > 0) conflict(`${staff} current employee(s) work at this location. Change their work location first.`)
      const pools = (db.prepare('SELECT count(*) AS n FROM asset_pools WHERE default_location_id = ? AND is_active = 1').get(input.id) as { n: number }).n
      if (pools > 0) conflict(`${pools} active asset pool(s) use this as their default location. Change them first.`)
    }
    db.prepare('UPDATE locations SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'location.reactivated' : 'location.deactivated', 'location', input.id, { name: loc.name, path: loc.path }, input.reason)
  })()
  return toLocationView(db, loadLocationPaths(db), input.id)
}

// =============================== Workstations ===============================

interface WorkstationRow {
  id: string
  locationId: string
  kind: WorkstationView['kind']
  code: string
  label: string | null
  notes: string | null
  isActive: number
}

const WORKSTATION_SELECT = 'SELECT id, location_id AS locationId, kind, code, label, notes, is_active AS isActive FROM workstations'

function toWorkstationView(r: WorkstationRow, paths: Map<string, { path: string }>): WorkstationView {
  return { ...r, isActive: Boolean(r.isActive), locationPath: paths.get(r.locationId)?.path ?? '' }
}

export function listWorkstations(db: DB, raw: WorkstationListInput, ctx: OpContext): WorkstationView[] {
  assertAnyPermission(ctx, ORG_VIEW_PERMISSIONS)
  const input = workstationListInputSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (!input.includeInactive) where.push('is_active = 1')
  if (input.locationId) {
    where.push('location_id = ?')
    params.push(input.locationId)
  }
  if (input.search) {
    where.push("(code LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\')")
    params.push(likePattern(input.search), likePattern(input.search))
  }
  const rows = db.prepare(`${WORKSTATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY code COLLATE NOCASE`).all(...params) as WorkstationRow[]
  const paths = loadLocationPaths(db)
  return rows.map((r) => toWorkstationView(r, paths))
}

function getWorkstation(db: DB, id: string): WorkstationView {
  const row = requireRow(db.prepare(`${WORKSTATION_SELECT} WHERE id = ?`).get(id) as WorkstationRow | undefined, 'Workstation')
  return toWorkstationView(row, loadLocationPaths(db))
}

function assertWorkstationLocation(db: DB, locationId: string): void {
  assertActive(db, 'locations', locationId, 'locationId', 'Location')
  const t = (db.prepare('SELECT location_type AS t FROM locations WHERE id = ?').get(locationId) as { t: LocationType }).t
  if (!WORKSTATION_LOCATION_TYPES.includes(t)) {
    throw new AppError('VALIDATION_ERROR', `Workstations belong in a floor, room or bay, not a ${LOCATION_TYPE_LABELS[t].toLowerCase()}.`, { locationId: 'Choose a floor, room or bay' })
  }
}

export function createWorkstation(db: DB, raw: CreateWorkstationInput, ctx: OpContext): WorkstationView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createWorkstationSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    assertWorkstationLocation(db, input.locationId)
    assertUnique(db, 'SELECT 1 FROM workstations WHERE organization_id = ? AND code_normalized = ?', [orgId, normalizeKey(input.code)], 'code', 'A workstation with this code already exists.')
    const now = nowIso()
    db.prepare(
      `INSERT INTO workstations (id, organization_id, location_id, kind, code, code_normalized, label, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.locationId, input.kind, input.code, normalizeKey(input.code), input.label, input.notes, now, now)
    audit(db, ctx, 'workstation.created', 'workstation', id, { code: input.code, kind: input.kind, locationId: input.locationId })
  })()
  return getWorkstation(db, id)
}

export function updateWorkstation(db: DB, raw: UpdateWorkstationInput, ctx: OpContext): WorkstationView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateWorkstationSchema.parse(raw)
  db.transaction(() => {
    const before = getWorkstation(db, input.id)
    if (input.locationId !== before.locationId) assertWorkstationLocation(db, input.locationId)
    assertUnique(db, 'SELECT 1 FROM workstations WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [getOrganizationId(db), normalizeKey(input.code), input.id], 'code', 'A workstation with this code already exists.')
    db.prepare('UPDATE workstations SET location_id = ?, kind = ?, code = ?, code_normalized = ?, label = ?, notes = ?, updated_at = ? WHERE id = ?').run(
      input.locationId, input.kind, input.code, normalizeKey(input.code), input.label, input.notes, nowIso(), input.id
    )
    audit(db, ctx, 'workstation.updated', 'workstation', input.id, {
      before: { code: before.code, kind: before.kind, locationId: before.locationId },
      after: { code: input.code, kind: input.kind, locationId: input.locationId }
    })
  })()
  return getWorkstation(db, input.id)
}

export function setWorkstationActive(db: DB, raw: SetActiveInput, ctx: OpContext): WorkstationView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  db.transaction(() => {
    const w = getWorkstation(db, input.id)
    if (w.isActive === input.isActive) return
    if (input.isActive) assertActive(db, 'locations', w.locationId, 'locationId', 'Location')
    // M4 adds: block deactivation while assets are actively assigned to this workstation.
    db.prepare('UPDATE workstations SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'workstation.reactivated' : 'workstation.deactivated', 'workstation', input.id, { code: w.code }, input.reason)
  })()
  return getWorkstation(db, input.id)
}

// =============================== Asset pools ===============================

const POOL_SELECT = `
  SELECT p.id, p.code, p.name, p.purpose, p.responsible_department_id AS responsibleDepartmentId, d.name AS responsibleDepartmentName,
         p.responsible_team_id AS responsibleTeamId, t.name AS responsibleTeamName, p.default_location_id AS defaultLocationId,
         p.is_active AS isActive
  FROM asset_pools p LEFT JOIN departments d ON d.id = p.responsible_department_id LEFT JOIN teams t ON t.id = p.responsible_team_id`

type PoolRow = Omit<PoolView, 'isActive' | 'defaultLocationPath'> & { isActive: number }

function toPoolView(r: PoolRow, paths: Map<string, { path: string }>): PoolView {
  return { ...r, isActive: Boolean(r.isActive), defaultLocationPath: r.defaultLocationId ? (paths.get(r.defaultLocationId)?.path ?? null) : null }
}

export function listPools(db: DB, raw: ListInput, ctx: OpContext): PoolView[] {
  assertAnyPermission(ctx, ORG_VIEW_PERMISSIONS)
  const input = listInputSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (!input.includeInactive) where.push('p.is_active = 1')
  if (input.search) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\')")
    params.push(likePattern(input.search), likePattern(input.search))
  }
  const rows = db.prepare(`${POOL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name COLLATE NOCASE`).all(...params) as PoolRow[]
  const paths = loadLocationPaths(db)
  return rows.map((r) => toPoolView(r, paths))
}

function getPool(db: DB, id: string): PoolView {
  return toPoolView(requireRow(db.prepare(`${POOL_SELECT} WHERE p.id = ?`).get(id) as PoolRow | undefined, 'Asset pool'), loadLocationPaths(db))
}

function validatePoolRefs(db: DB, input: { responsibleDepartmentId: string | null; responsibleTeamId: string | null; defaultLocationId: string | null }): void {
  assertActive(db, 'departments', input.responsibleDepartmentId, 'responsibleDepartmentId', 'Department')
  assertActive(db, 'teams', input.responsibleTeamId, 'responsibleTeamId', 'Team')
  assertActive(db, 'locations', input.defaultLocationId, 'defaultLocationId', 'Location')
  if (input.responsibleDepartmentId && input.responsibleTeamId) {
    const t = db.prepare('SELECT department_id AS d FROM teams WHERE id = ?').get(input.responsibleTeamId) as { d: string }
    if (t.d !== input.responsibleDepartmentId) {
      throw new AppError('VALIDATION_ERROR', 'The responsible team belongs to a different department.', { responsibleTeamId: 'Team is not in the selected department' })
    }
  }
}

function checkPoolUnique(db: DB, orgId: string, name: string, code: string | null, excludeId: string): void {
  assertUnique(db, 'SELECT 1 FROM asset_pools WHERE organization_id = ? AND name_normalized = ? AND id <> ?', [orgId, normalizeKey(name), excludeId], 'name', 'An asset pool with this name already exists.')
  if (code) assertUnique(db, 'SELECT 1 FROM asset_pools WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [orgId, normalizeKey(code), excludeId], 'code', 'An asset pool with this code already exists.')
}

export function createPool(db: DB, raw: CreatePoolInput, ctx: OpContext): PoolView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createPoolSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    validatePoolRefs(db, input)
    checkPoolUnique(db, orgId, input.name, input.code, id)
    const now = nowIso()
    db.prepare(
      `INSERT INTO asset_pools (id, organization_id, code, code_normalized, name, name_normalized, purpose, responsible_department_id, responsible_team_id, default_location_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.purpose, input.responsibleDepartmentId, input.responsibleTeamId, input.defaultLocationId, now, now)
    audit(db, ctx, 'asset_pool.created', 'asset_pool', id, { name: input.name, responsibleDepartmentId: input.responsibleDepartmentId, responsibleTeamId: input.responsibleTeamId })
  })()
  return getPool(db, id)
}

export function updatePool(db: DB, raw: UpdatePoolInput, ctx: OpContext): PoolView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updatePoolSchema.parse(raw)
  db.transaction(() => {
    const before = getPool(db, input.id)
    validatePoolRefs(db, input)
    checkPoolUnique(db, getOrganizationId(db), input.name, input.code, input.id)
    db.prepare(
      `UPDATE asset_pools SET code = ?, code_normalized = ?, name = ?, name_normalized = ?, purpose = ?, responsible_department_id = ?,
              responsible_team_id = ?, default_location_id = ?, updated_at = ? WHERE id = ?`
    ).run(input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.purpose, input.responsibleDepartmentId, input.responsibleTeamId, input.defaultLocationId, nowIso(), input.id)
    audit(db, ctx, 'asset_pool.updated', 'asset_pool', input.id, {
      before: { name: before.name, responsibleDepartmentId: before.responsibleDepartmentId, responsibleTeamId: before.responsibleTeamId, defaultLocationId: before.defaultLocationId },
      after: { name: input.name, responsibleDepartmentId: input.responsibleDepartmentId, responsibleTeamId: input.responsibleTeamId, defaultLocationId: input.defaultLocationId }
    })
  })()
  return getPool(db, input.id)
}

export function setPoolActive(db: DB, raw: SetActiveInput, ctx: OpContext): PoolView {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  db.transaction(() => {
    const p = getPool(db, input.id)
    if (p.isActive === input.isActive) return
    if (input.isActive) validatePoolRefs(db, p)
    // M4 adds: block deactivation while assets are actively assigned to this pool.
    db.prepare('UPDATE asset_pools SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'asset_pool.reactivated' : 'asset_pool.deactivated', 'asset_pool', input.id, { name: p.name }, input.reason)
  })()
  return getPool(db, input.id)
}
