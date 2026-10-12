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
import type { PermissionKey } from '@shared/permissions'
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { auditFrom, recordAudit } from './foundation'
import { assertUnique, conflict, likePattern, normalizeKey, normalizeOptional, Params, requireRow } from './common'

/** Permissions that allow reading the organization structure. */
export const ORG_VIEW: readonly PermissionKey[] = ['locations.manage', 'employees.view', 'employees.manage', 'assets.view']
const CURRENT = "employment_status <> 'exited'"

const audit = (c: SqlClient, ctx: OpContext, eventType: string, entityType: string, entityId: string, summary: Record<string, unknown>, reason?: string) =>
  recordAudit(c, { ...auditFrom(ctx), eventType, entityType, entityId, summary, reason: reason ?? null })

async function assertCurrentEmployee(c: SqlClient, ctx: OpContext, id: string | null, field: string): Promise<void> {
  if (!id) return
  const row = await c.one<{ s: string }>('SELECT employment_status AS s FROM employees WHERE id = $1 AND organization_id = $2', [id, ctx.actor.organizationId])
  if (!row) throw new AppError('VALIDATION_ERROR', 'The selected employee does not exist.', { [field]: 'Employee not found' })
  if (row.s === 'exited') throw new AppError('VALIDATION_ERROR', 'The selected employee has exited.', { [field]: 'Employee has exited' })
}

async function assertActive(c: SqlClient, ctx: OpContext, table: 'departments' | 'teams' | 'locations', id: string | null, field: string, label: string): Promise<void> {
  if (!id) return
  const row = await c.one<{ a: boolean }>(`SELECT is_active AS a FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, ctx.actor.organizationId])
  if (!row) throw new AppError('VALIDATION_ERROR', `${label} not found.`, { [field]: `${label} not found` })
  if (!row.a) throw new AppError('VALIDATION_ERROR', `${label} is deactivated.`, { [field]: `${label} is deactivated` })
}

const count = async (c: SqlClient, sql: string, params: unknown[]) => (await c.one<{ n: number }>(sql, params))!.n

// =============================== Departments ===============================

const DEPARTMENT_SELECT = `
  SELECT d.id, d.code, d.name, d.manager_employee_id AS "managerEmployeeId", m.full_name AS "managerName", d.notes,
         d.is_active AS "isActive", d.updated_at AS "updatedAt",
         (SELECT count(*) FROM teams t WHERE t.department_id = d.id AND t.is_active) AS "activeTeamCount",
         (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.${CURRENT}) AS "currentEmployeeCount"
  FROM departments d LEFT JOIN employees m ON m.id = d.manager_employee_id`

export async function listDepartments(db: Db, raw: ListInput, ctx: OpContext): Promise<DepartmentView[]> {
  assertAnyPermission(ctx, ORG_VIEW)
  const input = listInputSchema.parse(raw)
  const p = new Params()
  const where = [`d.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (!input.includeInactive) where.push('d.is_active')
  if (input.search) {
    const s = p.add(likePattern(input.search))
    where.push(`(d.name ILIKE ${s} ESCAPE '\\' OR d.code ILIKE ${s} ESCAPE '\\')`)
  }
  return db.many<DepartmentView>(`${DEPARTMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(d.name)`, p.values)
}

async function getDepartment(c: SqlClient, ctx: OpContext, id: string): Promise<DepartmentView> {
  return requireRow(await c.one<DepartmentView>(`${DEPARTMENT_SELECT} WHERE d.id = $1 AND d.organization_id = $2`, [id, ctx.actor.organizationId]), 'Department')
}

async function checkDepartmentUnique(c: SqlClient, org: string, name: string, code: string | null, excludeId: string): Promise<void> {
  await assertUnique(c, 'SELECT 1 FROM departments WHERE organization_id = $1 AND name_normalized = $2 AND id <> $3', [org, normalizeKey(name), excludeId], 'name', 'A department with this name already exists.')
  if (code) await assertUnique(c, 'SELECT 1 FROM departments WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [org, normalizeKey(code), excludeId], 'code', 'A department with this code already exists.')
}

export async function createDepartment(db: Db, raw: CreateDepartmentInput, ctx: OpContext): Promise<DepartmentView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createDepartmentSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await checkDepartmentUnique(t, org, input.name, input.code, id)
    await assertCurrentEmployee(t, ctx, input.managerEmployeeId, 'managerEmployeeId')
    await t.exec(
      `INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, manager_employee_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, org, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.managerEmployeeId, input.notes]
    )
    await audit(t, ctx, 'department.created', 'department', id, { name: input.name, code: input.code, managerEmployeeId: input.managerEmployeeId })
    return getDepartment(t, ctx, id)
  })
}

export async function updateDepartment(db: Db, raw: UpdateDepartmentInput, ctx: OpContext): Promise<DepartmentView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateDepartmentSchema.parse(raw)
  return db.tx(async (t) => {
    const before = await getDepartment(t, ctx, input.id)
    await checkDepartmentUnique(t, ctx.actor.organizationId, input.name, input.code, input.id)
    if (input.managerEmployeeId !== before.managerEmployeeId) await assertCurrentEmployee(t, ctx, input.managerEmployeeId, 'managerEmployeeId')
    await t.exec(
      `UPDATE departments SET code = $2, code_normalized = $3, name = $4, name_normalized = $5, manager_employee_id = $6, notes = $7, updated_at = now() WHERE id = $1`,
      [input.id, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.managerEmployeeId, input.notes]
    )
    await audit(t, ctx, 'department.updated', 'department', input.id, {
      before: { name: before.name, code: before.code, managerEmployeeId: before.managerEmployeeId },
      after: { name: input.name, code: input.code, managerEmployeeId: input.managerEmployeeId }
    })
    return getDepartment(t, ctx, input.id)
  })
}

export async function setDepartmentActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<DepartmentView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  return db.tx(async (t) => {
    const d = await getDepartment(t, ctx, input.id)
    if (d.isActive === input.isActive) return d
    if (!input.isActive) {
      if (d.activeTeamCount > 0) conflict(`Deactivate or move the ${d.activeTeamCount} active team(s) in this department first.`)
      if (d.currentEmployeeCount > 0) conflict(`Move the ${d.currentEmployeeCount} current employee(s) to another department first.`)
      const pools = await count(t, 'SELECT count(*) AS n FROM asset_pools WHERE responsible_department_id = $1 AND is_active', [input.id])
      if (pools > 0) conflict(`Reassign the ${pools} active asset pool(s) this department is responsible for first.`)
    }
    await t.exec('UPDATE departments SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'department.reactivated' : 'department.deactivated', 'department', input.id, { name: d.name }, input.reason)
    return getDepartment(t, ctx, input.id)
  })
}

// =============================== Teams ===============================

const TEAM_SELECT = `
  SELECT t.id, t.department_id AS "departmentId", d.name AS "departmentName", t.kind, t.code, t.name,
         t.lead_employee_id AS "leadEmployeeId", l.full_name AS "leadName", t.notes, t.is_active AS "isActive",
         (SELECT count(*) FROM employees e WHERE e.team_id = t.id AND e.${CURRENT}) AS "currentEmployeeCount"
  FROM teams t JOIN departments d ON d.id = t.department_id LEFT JOIN employees l ON l.id = t.lead_employee_id`

export async function listTeams(db: Db, raw: TeamListInput, ctx: OpContext): Promise<TeamView[]> {
  assertAnyPermission(ctx, ORG_VIEW)
  const input = teamListInputSchema.parse(raw)
  const p = new Params()
  const where = [`t.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (!input.includeInactive) where.push('t.is_active')
  if (input.departmentId) where.push(`t.department_id = ${p.add(input.departmentId)}`)
  if (input.search) {
    const s = p.add(likePattern(input.search))
    where.push(`(t.name ILIKE ${s} ESCAPE '\\' OR t.code ILIKE ${s} ESCAPE '\\')`)
  }
  return db.many<TeamView>(`${TEAM_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(d.name), lower(t.name)`, p.values)
}

async function getTeam(c: SqlClient, ctx: OpContext, id: string): Promise<TeamView> {
  return requireRow(await c.one<TeamView>(`${TEAM_SELECT} WHERE t.id = $1 AND t.organization_id = $2`, [id, ctx.actor.organizationId]), 'Team')
}

async function checkTeamUnique(c: SqlClient, org: string, departmentId: string, name: string, code: string | null, excludeId: string): Promise<void> {
  await assertUnique(c, 'SELECT 1 FROM teams WHERE department_id = $1 AND name_normalized = $2 AND id <> $3', [departmentId, normalizeKey(name), excludeId], 'name', 'This department already has a team with this name.')
  if (code) await assertUnique(c, 'SELECT 1 FROM teams WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [org, normalizeKey(code), excludeId], 'code', 'A team with this code already exists.')
}

export async function createTeam(db: Db, raw: CreateTeamInput, ctx: OpContext): Promise<TeamView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createTeamSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await assertActive(t, ctx, 'departments', input.departmentId, 'departmentId', 'Department')
    await checkTeamUnique(t, org, input.departmentId, input.name, input.code, id)
    await assertCurrentEmployee(t, ctx, input.leadEmployeeId, 'leadEmployeeId')
    await t.exec(
      `INSERT INTO teams (id, organization_id, department_id, kind, code, code_normalized, name, name_normalized, lead_employee_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, org, input.departmentId, input.kind, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.leadEmployeeId, input.notes]
    )
    await audit(t, ctx, 'team.created', 'team', id, { name: input.name, kind: input.kind, departmentId: input.departmentId })
    return getTeam(t, ctx, id)
  })
}

export async function updateTeam(db: Db, raw: UpdateTeamInput, ctx: OpContext): Promise<TeamView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateTeamSchema.parse(raw)
  return db.tx(async (t) => {
    const before = await getTeam(t, ctx, input.id)
    if (input.departmentId !== before.departmentId) {
      await assertActive(t, ctx, 'departments', input.departmentId, 'departmentId', 'Department')
      if (before.currentEmployeeCount > 0) conflict(`Move the ${before.currentEmployeeCount} current employee(s) out of this team before changing its department.`)
    }
    await checkTeamUnique(t, ctx.actor.organizationId, input.departmentId, input.name, input.code, input.id)
    if (input.leadEmployeeId !== before.leadEmployeeId) await assertCurrentEmployee(t, ctx, input.leadEmployeeId, 'leadEmployeeId')
    await t.exec(
      `UPDATE teams SET department_id = $2, kind = $3, code = $4, code_normalized = $5, name = $6, name_normalized = $7, lead_employee_id = $8, notes = $9, updated_at = now() WHERE id = $1`,
      [input.id, input.departmentId, input.kind, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.leadEmployeeId, input.notes]
    )
    await audit(t, ctx, 'team.updated', 'team', input.id, {
      before: { name: before.name, kind: before.kind, departmentId: before.departmentId, leadEmployeeId: before.leadEmployeeId },
      after: { name: input.name, kind: input.kind, departmentId: input.departmentId, leadEmployeeId: input.leadEmployeeId }
    })
    return getTeam(t, ctx, input.id)
  })
}

export async function setTeamActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<TeamView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  return db.tx(async (t) => {
    const team = await getTeam(t, ctx, input.id)
    if (team.isActive === input.isActive) return team
    if (input.isActive) {
      await assertActive(t, ctx, 'departments', team.departmentId, 'departmentId', 'Department')
    } else {
      if (team.currentEmployeeCount > 0) conflict(`Move the ${team.currentEmployeeCount} current employee(s) to another team first.`)
      const pools = await count(t, 'SELECT count(*) AS n FROM asset_pools WHERE responsible_team_id = $1 AND is_active', [input.id])
      if (pools > 0) conflict(`Reassign the ${pools} active asset pool(s) this team is responsible for first.`)
    }
    await t.exec('UPDATE teams SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'team.reactivated' : 'team.deactivated', 'team', input.id, { name: team.name }, input.reason)
    return getTeam(t, ctx, input.id)
  })
}

// =============================== Locations ===============================

interface LocationRow {
  id: string
  parentLocationId: string | null
  locationType: LocationType
  code: string | null
  name: string
  notes: string | null
  isActive: boolean
}

/** All of an organization's locations with their full paths (hundreds of rows at most). */
export async function loadLocationPaths(c: SqlClient, organizationId: string): Promise<Map<string, { row: LocationRow; path: string }>> {
  const rows = await c.many<LocationRow>(
    'SELECT id, parent_location_id AS "parentLocationId", location_type AS "locationType", code, name, notes, is_active AS "isActive" FROM locations WHERE organization_id = $1',
    [organizationId]
  )
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

async function toLocationView(c: SqlClient, paths: Map<string, { row: LocationRow; path: string }>, id: string): Promise<LocationView> {
  const entry = requireRow(paths.get(id), 'Location')
  const counts = (await c.one<{ c: number; w: number }>(
    `SELECT (SELECT count(*) FROM locations WHERE parent_location_id = $1 AND is_active) AS c,
            (SELECT count(*) FROM workstations WHERE location_id = $1 AND is_active) AS w`,
    [id]
  ))!
  return { ...entry.row, path: entry.path, activeChildCount: counts.c, activeWorkstationCount: counts.w }
}

export async function listLocations(db: Db, raw: ListInput, ctx: OpContext): Promise<LocationView[]> {
  assertAnyPermission(ctx, ORG_VIEW)
  const input = listInputSchema.parse(raw)
  const paths = await loadLocationPaths(db, ctx.actor.organizationId)
  const search = input.search ? normalizeKey(input.search) : null
  const rows = [...paths.values()]
    .filter(({ row, path }) => (input.includeInactive || row.isActive) && (!search || path.toLowerCase().includes(search) || (row.code ?? '').toLowerCase().includes(search)))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
  const counts = await db.many<{ id: string; c: number; w: number }>(
    `SELECT l.id, (SELECT count(*) FROM locations x WHERE x.parent_location_id = l.id AND x.is_active) AS c,
            (SELECT count(*) FROM workstations w WHERE w.location_id = l.id AND w.is_active) AS w
     FROM locations l WHERE l.organization_id = $1`,
    [ctx.actor.organizationId]
  )
  const byId = new Map(counts.map((r) => [r.id, r]))
  return rows.map(({ row, path }) => ({ ...row, path, activeChildCount: byId.get(row.id)?.c ?? 0, activeWorkstationCount: byId.get(row.id)?.w ?? 0 }))
}

async function assertParentAllowed(c: SqlClient, ctx: OpContext, type: LocationType, parentId: string | null): Promise<void> {
  const allowed = LOCATION_PARENT_RULES[type]
  if (!parentId) {
    if (!allowed.includes(null)) throw new AppError('VALIDATION_ERROR', `A ${LOCATION_TYPE_LABELS[type].toLowerCase()} must be placed inside another location.`, { parentLocationId: 'Choose a parent location' })
    return
  }
  const parent = await c.one<{ t: LocationType; a: boolean }>('SELECT location_type AS t, is_active AS a FROM locations WHERE id = $1 AND organization_id = $2', [parentId, ctx.actor.organizationId])
  if (!parent) throw new AppError('VALIDATION_ERROR', 'Parent location not found.', { parentLocationId: 'Parent location not found' })
  if (!parent.a) throw new AppError('VALIDATION_ERROR', 'Parent location is deactivated.', { parentLocationId: 'Parent location is deactivated' })
  if (!allowed.includes(parent.t)) {
    const names = allowed.map((t) => (t ? LOCATION_TYPE_LABELS[t].toLowerCase() : 'top level')).join(', ')
    throw new AppError('VALIDATION_ERROR', `A ${LOCATION_TYPE_LABELS[type].toLowerCase()} cannot be inside a ${LOCATION_TYPE_LABELS[parent.t].toLowerCase()}. Allowed: ${names}.`, { parentLocationId: 'Not an allowed parent for this type' })
  }
}

async function checkLocationUnique(c: SqlClient, org: string, parentId: string | null, name: string, code: string | null, excludeId: string): Promise<void> {
  await assertUnique(
    c,
    'SELECT 1 FROM locations WHERE organization_id = $1 AND parent_location_id IS NOT DISTINCT FROM $2 AND name_normalized = $3 AND id <> $4',
    [org, parentId, normalizeKey(name), excludeId],
    'name',
    'A location with this name already exists at this level.'
  )
  if (code) await assertUnique(c, 'SELECT 1 FROM locations WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [org, normalizeKey(code), excludeId], 'code', 'A location with this code already exists.')
}

export async function createLocation(db: Db, raw: CreateLocationInput, ctx: OpContext): Promise<LocationView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createLocationSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await assertParentAllowed(t, ctx, input.locationType, input.parentLocationId)
    await checkLocationUnique(t, org, input.parentLocationId, input.name, input.code, id)
    await t.exec(
      `INSERT INTO locations (id, organization_id, parent_location_id, location_type, code, code_normalized, name, name_normalized, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, org, input.parentLocationId, input.locationType, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.notes]
    )
    await audit(t, ctx, 'location.created', 'location', id, { name: input.name, type: input.locationType, parentLocationId: input.parentLocationId })
    return toLocationView(t, await loadLocationPaths(t, org), id)
  })
}

export async function updateLocation(db: Db, raw: UpdateLocationInput, ctx: OpContext): Promise<LocationView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateLocationSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const paths = await loadLocationPaths(t, org)
    const before = requireRow(paths.get(input.id), 'Location').row
    if (before.locationType !== input.locationType || before.parentLocationId !== input.parentLocationId) {
      await assertParentAllowed(t, ctx, input.locationType, input.parentLocationId)
      // The new parent must not be this location or one of its descendants.
      let cur = input.parentLocationId
      while (cur) {
        if (cur === input.id) conflict('A location cannot be moved inside itself or one of its own sub-locations.')
        cur = paths.get(cur)?.row.parentLocationId ?? null
      }
      if (before.locationType !== input.locationType) {
        const children = await t.many<{ t: LocationType }>('SELECT location_type AS t FROM locations WHERE parent_location_id = $1 AND is_active', [input.id])
        const bad = children.find((ch) => !LOCATION_PARENT_RULES[ch.t].includes(input.locationType))
        if (bad) conflict(`This location contains a ${LOCATION_TYPE_LABELS[bad.t].toLowerCase()}, which cannot sit inside a ${LOCATION_TYPE_LABELS[input.locationType].toLowerCase()}.`)
        const ws = await count(t, 'SELECT count(*) AS n FROM workstations WHERE location_id = $1 AND is_active', [input.id])
        if (ws > 0 && !WORKSTATION_LOCATION_TYPES.includes(input.locationType)) conflict(`This location has ${ws} active workstation(s); a ${LOCATION_TYPE_LABELS[input.locationType].toLowerCase()} cannot hold workstations.`)
      }
    }
    await checkLocationUnique(t, org, input.parentLocationId, input.name, input.code, input.id)
    await t.exec(
      `UPDATE locations SET parent_location_id = $2, location_type = $3, code = $4, code_normalized = $5, name = $6, name_normalized = $7, notes = $8, updated_at = now() WHERE id = $1`,
      [input.id, input.parentLocationId, input.locationType, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.notes]
    )
    await audit(t, ctx, 'location.updated', 'location', input.id, {
      before: { name: before.name, type: before.locationType, parentLocationId: before.parentLocationId, code: before.code },
      after: { name: input.name, type: input.locationType, parentLocationId: input.parentLocationId, code: input.code }
    })
    return toLocationView(t, await loadLocationPaths(t, org), input.id)
  })
}

export async function setLocationActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<LocationView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const loc = await toLocationView(t, await loadLocationPaths(t, org), input.id)
    if (loc.isActive === input.isActive) return loc
    if (input.isActive) {
      if (loc.parentLocationId) await assertActive(t, ctx, 'locations', loc.parentLocationId, 'parentLocationId', 'Parent location')
    } else {
      if (loc.activeChildCount > 0) conflict(`Deactivate the ${loc.activeChildCount} active sub-location(s) first.`)
      if (loc.activeWorkstationCount > 0) conflict(`Deactivate the ${loc.activeWorkstationCount} active workstation(s) at this location first.`)
      const staff = await count(t, `SELECT count(*) AS n FROM employees WHERE work_location_id = $1 AND ${CURRENT}`, [input.id])
      if (staff > 0) conflict(`${staff} current employee(s) work at this location. Change their work location first.`)
      const pools = await count(t, 'SELECT count(*) AS n FROM asset_pools WHERE default_location_id = $1 AND is_active', [input.id])
      if (pools > 0) conflict(`${pools} active asset pool(s) use this as their default location. Change them first.`)
    }
    await t.exec('UPDATE locations SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'location.reactivated' : 'location.deactivated', 'location', input.id, { name: loc.name, path: loc.path }, input.reason)
    return toLocationView(t, await loadLocationPaths(t, org), input.id)
  })
}

// =============================== Workstations ===============================

type WorkstationRow = Omit<WorkstationView, 'locationPath'>
const WORKSTATION_SELECT = 'SELECT id, location_id AS "locationId", kind, code, label, notes, is_active AS "isActive" FROM workstations'

export async function listWorkstations(db: Db, raw: WorkstationListInput, ctx: OpContext): Promise<WorkstationView[]> {
  assertAnyPermission(ctx, ORG_VIEW)
  const input = workstationListInputSchema.parse(raw)
  const p = new Params()
  const where = [`organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (!input.includeInactive) where.push('is_active')
  if (input.locationId) where.push(`location_id = ${p.add(input.locationId)}`)
  if (input.search) {
    const s = p.add(likePattern(input.search))
    where.push(`(code ILIKE ${s} ESCAPE '\\' OR label ILIKE ${s} ESCAPE '\\')`)
  }
  const rows = await db.many<WorkstationRow>(`${WORKSTATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(code)`, p.values)
  const paths = await loadLocationPaths(db, ctx.actor.organizationId)
  return rows.map((r) => ({ ...r, locationPath: paths.get(r.locationId)?.path ?? '' }))
}

async function getWorkstation(c: SqlClient, ctx: OpContext, id: string): Promise<WorkstationView> {
  const row = requireRow(await c.one<WorkstationRow>(`${WORKSTATION_SELECT} WHERE id = $1 AND organization_id = $2`, [id, ctx.actor.organizationId]), 'Workstation')
  return { ...row, locationPath: (await loadLocationPaths(c, ctx.actor.organizationId)).get(row.locationId)?.path ?? '' }
}

async function assertWorkstationLocation(c: SqlClient, ctx: OpContext, locationId: string): Promise<void> {
  await assertActive(c, ctx, 'locations', locationId, 'locationId', 'Location')
  const t = (await c.one<{ t: LocationType }>('SELECT location_type AS t FROM locations WHERE id = $1', [locationId]))!.t
  if (!WORKSTATION_LOCATION_TYPES.includes(t)) {
    throw new AppError('VALIDATION_ERROR', `Workstations belong in a floor, room or bay, not a ${LOCATION_TYPE_LABELS[t].toLowerCase()}.`, { locationId: 'Choose a floor, room or bay' })
  }
}

export async function createWorkstation(db: Db, raw: CreateWorkstationInput, ctx: OpContext): Promise<WorkstationView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createWorkstationSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await assertWorkstationLocation(t, ctx, input.locationId)
    await assertUnique(t, 'SELECT 1 FROM workstations WHERE organization_id = $1 AND code_normalized = $2', [org, normalizeKey(input.code)], 'code', 'A workstation with this code already exists.')
    await t.exec(
      `INSERT INTO workstations (id, organization_id, location_id, kind, code, code_normalized, label, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, org, input.locationId, input.kind, input.code, normalizeKey(input.code), input.label, input.notes]
    )
    await audit(t, ctx, 'workstation.created', 'workstation', id, { code: input.code, kind: input.kind, locationId: input.locationId })
    return getWorkstation(t, ctx, id)
  })
}

export async function updateWorkstation(db: Db, raw: UpdateWorkstationInput, ctx: OpContext): Promise<WorkstationView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updateWorkstationSchema.parse(raw)
  return db.tx(async (t) => {
    const before = await getWorkstation(t, ctx, input.id)
    if (input.locationId !== before.locationId) await assertWorkstationLocation(t, ctx, input.locationId)
    await assertUnique(t, 'SELECT 1 FROM workstations WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [ctx.actor.organizationId, normalizeKey(input.code), input.id], 'code', 'A workstation with this code already exists.')
    await t.exec('UPDATE workstations SET location_id = $2, kind = $3, code = $4, code_normalized = $5, label = $6, notes = $7, updated_at = now() WHERE id = $1', [
      input.id, input.locationId, input.kind, input.code, normalizeKey(input.code), input.label, input.notes
    ])
    await audit(t, ctx, 'workstation.updated', 'workstation', input.id, {
      before: { code: before.code, kind: before.kind, locationId: before.locationId },
      after: { code: input.code, kind: input.kind, locationId: input.locationId }
    })
    return getWorkstation(t, ctx, input.id)
  })
}

export async function setWorkstationActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<WorkstationView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  return db.tx(async (t) => {
    const w = await getWorkstation(t, ctx, input.id)
    if (w.isActive === input.isActive) return w
    if (input.isActive) await assertActive(t, ctx, 'locations', w.locationId, 'locationId', 'Location')
    // W4 adds: block deactivation while assets are actively assigned to this workstation.
    await t.exec('UPDATE workstations SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'workstation.reactivated' : 'workstation.deactivated', 'workstation', input.id, { code: w.code }, input.reason)
    return getWorkstation(t, ctx, input.id)
  })
}

// =============================== Asset pools ===============================

const POOL_SELECT = `
  SELECT p.id, p.code, p.name, p.purpose, p.responsible_department_id AS "responsibleDepartmentId", d.name AS "responsibleDepartmentName",
         p.responsible_team_id AS "responsibleTeamId", t.name AS "responsibleTeamName", p.default_location_id AS "defaultLocationId", p.is_active AS "isActive"
  FROM asset_pools p LEFT JOIN departments d ON d.id = p.responsible_department_id LEFT JOIN teams t ON t.id = p.responsible_team_id`
type PoolRow = Omit<PoolView, 'defaultLocationPath'>

export async function listPools(db: Db, raw: ListInput, ctx: OpContext): Promise<PoolView[]> {
  assertAnyPermission(ctx, ORG_VIEW)
  const input = listInputSchema.parse(raw)
  const p = new Params()
  const where = [`p.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (!input.includeInactive) where.push('p.is_active')
  if (input.search) {
    const s = p.add(likePattern(input.search))
    where.push(`(p.name ILIKE ${s} ESCAPE '\\' OR p.code ILIKE ${s} ESCAPE '\\')`)
  }
  const rows = await db.many<PoolRow>(`${POOL_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(p.name)`, p.values)
  const paths = await loadLocationPaths(db, ctx.actor.organizationId)
  return rows.map((r) => ({ ...r, defaultLocationPath: r.defaultLocationId ? (paths.get(r.defaultLocationId)?.path ?? null) : null }))
}

async function getPool(c: SqlClient, ctx: OpContext, id: string): Promise<PoolView> {
  const r = requireRow(await c.one<PoolRow>(`${POOL_SELECT} WHERE p.id = $1 AND p.organization_id = $2`, [id, ctx.actor.organizationId]), 'Asset pool')
  const paths = await loadLocationPaths(c, ctx.actor.organizationId)
  return { ...r, defaultLocationPath: r.defaultLocationId ? (paths.get(r.defaultLocationId)?.path ?? null) : null }
}

async function validatePoolRefs(c: SqlClient, ctx: OpContext, input: { responsibleDepartmentId: string | null; responsibleTeamId: string | null; defaultLocationId: string | null }): Promise<void> {
  await assertActive(c, ctx, 'departments', input.responsibleDepartmentId, 'responsibleDepartmentId', 'Department')
  await assertActive(c, ctx, 'teams', input.responsibleTeamId, 'responsibleTeamId', 'Team')
  await assertActive(c, ctx, 'locations', input.defaultLocationId, 'defaultLocationId', 'Location')
  if (input.responsibleDepartmentId && input.responsibleTeamId) {
    const team = (await c.one<{ d: string }>('SELECT department_id AS d FROM teams WHERE id = $1', [input.responsibleTeamId]))!
    if (team.d !== input.responsibleDepartmentId) throw new AppError('VALIDATION_ERROR', 'The responsible team belongs to a different department.', { responsibleTeamId: 'Team is not in the selected department' })
  }
}

async function checkPoolUnique(c: SqlClient, org: string, name: string, code: string | null, excludeId: string): Promise<void> {
  await assertUnique(c, 'SELECT 1 FROM asset_pools WHERE organization_id = $1 AND name_normalized = $2 AND id <> $3', [org, normalizeKey(name), excludeId], 'name', 'An asset pool with this name already exists.')
  if (code) await assertUnique(c, 'SELECT 1 FROM asset_pools WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [org, normalizeKey(code), excludeId], 'code', 'An asset pool with this code already exists.')
}

export async function createPool(db: Db, raw: CreatePoolInput, ctx: OpContext): Promise<PoolView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = createPoolSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await validatePoolRefs(t, ctx, input)
    await checkPoolUnique(t, org, input.name, input.code, id)
    await t.exec(
      `INSERT INTO asset_pools (id, organization_id, code, code_normalized, name, name_normalized, purpose, responsible_department_id, responsible_team_id, default_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, org, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.purpose, input.responsibleDepartmentId, input.responsibleTeamId, input.defaultLocationId]
    )
    await audit(t, ctx, 'asset_pool.created', 'asset_pool', id, { name: input.name, responsibleDepartmentId: input.responsibleDepartmentId, responsibleTeamId: input.responsibleTeamId })
    return getPool(t, ctx, id)
  })
}

export async function updatePool(db: Db, raw: UpdatePoolInput, ctx: OpContext): Promise<PoolView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = updatePoolSchema.parse(raw)
  return db.tx(async (t) => {
    const before = await getPool(t, ctx, input.id)
    await validatePoolRefs(t, ctx, input)
    await checkPoolUnique(t, ctx.actor.organizationId, input.name, input.code, input.id)
    await t.exec(
      `UPDATE asset_pools SET code = $2, code_normalized = $3, name = $4, name_normalized = $5, purpose = $6, responsible_department_id = $7, responsible_team_id = $8, default_location_id = $9, updated_at = now() WHERE id = $1`,
      [input.id, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.purpose, input.responsibleDepartmentId, input.responsibleTeamId, input.defaultLocationId]
    )
    await audit(t, ctx, 'asset_pool.updated', 'asset_pool', input.id, {
      before: { name: before.name, responsibleDepartmentId: before.responsibleDepartmentId, responsibleTeamId: before.responsibleTeamId, defaultLocationId: before.defaultLocationId },
      after: { name: input.name, responsibleDepartmentId: input.responsibleDepartmentId, responsibleTeamId: input.responsibleTeamId, defaultLocationId: input.defaultLocationId }
    })
    return getPool(t, ctx, input.id)
  })
}

export async function setPoolActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<PoolView> {
  assertPermission(ctx.actor.permissions, 'locations.manage')
  const input = setActiveInputSchema.parse(raw)
  return db.tx(async (t) => {
    const pool = await getPool(t, ctx, input.id)
    if (pool.isActive === input.isActive) return pool
    if (input.isActive) await validatePoolRefs(t, ctx, pool)
    // W4 adds: block deactivation while assets are actively assigned to this pool.
    await t.exec('UPDATE asset_pools SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'asset_pool.reactivated' : 'asset_pool.deactivated', 'asset_pool', input.id, { name: pool.name }, input.reason)
    return getPool(t, ctx, input.id)
  })
}
