import { afterEach, describe, expect, it } from 'vitest'
import type { CreateEmployeeInput } from '../../src/shared/orgSchemas'
import { newCorrelationId } from '../../server/src/core'
import { bootstrapOrganization } from '../../server/src/services/identity'
import { SETUP } from './api-helpers'
import { createApiSession, type ApiSession } from './session-helpers'

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})
const session = async () => {
  const a = await createApiSession()
  sessions.push(a)
  return a
}

const dept = (name: string, code: string | null = null) => ({ code, name, managerEmployeeId: null, notes: null })
const team = (departmentId: string, name: string, code: string | null = null) => ({ departmentId, kind: 'team' as const, code, name, leadEmployeeId: null, notes: null })
const loc = (locationType: string, name: string, parentLocationId: string | null = null, code: string | null = null) => ({ locationType, name, parentLocationId, code, notes: null }) as never
const emp = (employeeCode: string, fullName: string, extra: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput => ({
  employeeCode, fullName, email: null, phone: null, jobTitle: null, departmentId: null, teamId: null, managerEmployeeId: null,
  workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null, ...extra
})

describe('departments, teams and locations on PostgreSQL', () => {
  it('enforces case-insensitive uniqueness, relationships and deactivation guards', async () => {
    const a = await session()
    const ops = await a.ok('departments.create', dept('Operations', 'OPS'))
    expect(await a.call('departments.create', dept(' operations '))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD', fieldErrors: { name: expect.any(String) } } })
    const t = await a.ok('teams.create', team(ops.id, 'Voice'))
    expect(await a.call('departments.setActive', { id: ops.id, isActive: false, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    await a.ok('teams.setActive', { id: t.id, isActive: false, reason: 'merged' })
    expect((await a.ok('departments.setActive', { id: ops.id, isActive: false, reason: 'restructure' })).isActive).toBe(false)
    expect(await a.call('teams.setActive', { id: t.id, isActive: true, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('builds location paths, enforces parent rules and prevents cycles', async () => {
    const a = await session()
    const site = await a.ok('locations.create', loc('site', 'Pune Campus', null, 'PUN'))
    const bldg = await a.ok('locations.create', loc('building', 'Tower B', site.id))
    const floor = await a.ok('locations.create', loc('floor', 'Floor 3', bldg.id))
    const bay = await a.ok('locations.create', loc('bay', 'Bay 3A', floor.id))
    expect(bay.path).toBe('Pune Campus / Tower B / Floor 3 / Bay 3A')
    expect(await a.call('locations.create', loc('bay', 'Bad', site.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await a.call('locations.create', loc('floor', 'floor 3', bldg.id))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
    const z1 = await a.ok('locations.create', loc('other', 'Zone A'))
    const z2 = await a.ok('locations.create', loc('other', 'Zone B', z1.id))
    expect(await a.call('locations.update', { id: z1.id, locationType: 'other', name: 'Zone A', parentLocationId: z2.id, code: null, notes: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    const ws = await a.ok('workstations.create', { locationId: bay.id, kind: 'seat', code: 'PUN-3A-01', label: null, notes: null })
    expect(ws.locationPath).toContain('Bay 3A')
    expect(await a.call('locations.setActive', { id: bay.id, isActive: false, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect(await a.call('workstations.create', { locationId: site.id, kind: 'workstation', code: 'X', label: null, notes: null })).toMatchObject({ ok: false, error: { fieldErrors: { locationId: expect.any(String) } } })
  })

  it('validates asset pools and lets read-only roles view but not change', async () => {
    const a = await session()
    const itd = await a.ok('departments.create', dept('IT'))
    const ops = await a.ok('departments.create', dept('Ops'))
    const desk = await a.ok('teams.create', team(itd.id, 'Desktop'))
    expect(await a.call('pools.create', { code: null, name: 'Spares', purpose: null, responsibleDepartmentId: ops.id, responsibleTeamId: desk.id, defaultLocationId: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect((await a.ok('pools.create', { code: null, name: 'Spares', purpose: null, responsibleDepartmentId: itd.id, responsibleTeamId: desk.id, defaultLocationId: null })).responsibleTeamName).toBe('Desktop')
    await a.becomeNewUser('auditor.one', ['auditor'])
    expect((await a.ok('departments.list', {})).length).toBe(2)
    expect(await a.call('departments.create', dept('Shadow'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.becomeNewUser('agent.one', ['employee'])
    expect(await a.call('departments.list', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})

describe('employees on PostgreSQL', () => {
  it('derives department from team, prevents loops and preserves history on exit', async () => {
    const a = await session()
    const ops = await a.ok('departments.create', dept('Operations', 'OPS'))
    const voice = await a.ok('teams.create', { ...team(ops.id, 'Voice'), kind: 'process' })
    const mgr = await a.ok('employees.create', emp('M001', 'Asha Menon', { departmentId: ops.id }))
    const e = await a.ok('employees.create', emp('E001', 'Ravi Kumar', { teamId: voice.id, managerEmployeeId: mgr.id, joiningDate: '2026-01-15' }))
    expect(e).toMatchObject({ departmentId: ops.id, teamName: 'Voice', managerName: 'Asha Menon', joiningDate: '2026-01-15' })
    expect(await a.call('employees.update', { ...emp('M001', 'Asha Menon'), id: mgr.id, managerEmployeeId: e.id })).toMatchObject({ ok: false, error: { message: expect.stringContaining('loop') } })
    expect(await a.call('employees.create', emp('e001', 'Dup'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
    await a.ok('employees.deactivate', { id: mgr.id, actualExitDate: '2026-10-01', reason: 'Resigned' })
    expect(await a.ok('employees.get', { id: e.id })).toMatchObject({ managerEmployeeId: mgr.id, managerStatus: 'exited' })
    expect(await a.call('employees.create', emp('E002', 'New', { managerEmployeeId: mgr.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect((await a.ok('employees.reactivate', { id: mgr.id, reason: 'Rehired' })).employmentStatus).toBe('active')
    expect((await a.ok('employees.search', { query: 'asha' })).total).toBe(1)
    expect((await a.ok('employees.search', { query: '%' })).total).toBe(0)
  })

  it('audits personal-field changes without their values and applies the email policy', async () => {
    const a = await session()
    const e = await a.ok('employees.create', emp('E1', 'Agent', { email: 'old@bpo.example' }))
    await a.ok('employees.update', { ...emp('E1', 'Agent Renamed', { email: 'new@bpo.example', jobTitle: 'Lead' }), id: e.id })
    const ev = (await a.ok('audit.list', { page: 1, pageSize: 5, eventType: 'employee.updated' })).items[0]!
    expect(ev.summary).toMatchObject({ personalFieldsChanged: expect.arrayContaining(['fullName', 'email']), changed: { jobTitle: { from: null, to: 'Lead' } } })
    expect(JSON.stringify(ev.summary)).not.toMatch(/new@bpo|Renamed/)
    await a.ok('settings.update', { employeeDuplicateEmailPolicy: 'reject' })
    expect(await a.call('employees.create', emp('E2', 'B', { email: 'NEW@bpo.example' }))).toMatchObject({ ok: false, error: { fieldErrors: { email: expect.any(String) } } })
  })

  it('gives asset managers read-only access and blocks HR from the structure', async () => {
    const a = await session()
    await a.ok('employees.create', emp('E1', 'A'))
    await a.becomeNewUser('am.one', ['asset_manager'])
    expect((await a.ok('employees.search', {})).total).toBe(1)
    expect(await a.call('employees.create', emp('E2', 'B'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.becomeNewUser('hr.one', ['hr_officer'])
    expect((await a.call('employees.create', emp('E3', 'C'))).ok).toBe(true)
    expect(await a.call('departments.create', dept('X'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})

describe('organization boundary', () => {
  it('never reads or writes another organization\'s structure, even with valid IDs', async () => {
    const a = await session()
    const mine = await a.ok('departments.create', dept('Mine'))
    const other = await bootstrapOrganization(a.s.tdb.db, { ...SETUP, organization: { ...SETUP.organization, legalName: 'Other BPO', displayName: 'Other' } }, newCorrelationId(), { allowAdditional: true })
    const [foreignDept] = await a.sql<{ id: string }>(
      "INSERT INTO departments (id, organization_id, name, name_normalized) VALUES (gen_random_uuid(), $1, 'Foreign', 'foreign') RETURNING id",
      [other.organizationId]
    )
    expect((await a.ok('departments.list', { includeInactive: true })).map((d) => d.id)).toEqual([mine.id])
    expect(await a.call('departments.update', { id: foreignDept!.id, code: null, name: 'Hijacked', managerEmployeeId: null, notes: null })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await a.call('teams.create', team(foreignDept!.id, 'Sneaky'))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await a.call('employees.create', emp('X1', 'X', { departmentId: foreignDept!.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    // The database itself refuses a cross-organization reference.
    await expect(a.s.tdb.db.exec("INSERT INTO teams (id, organization_id, department_id, name, name_normalized) SELECT gen_random_uuid(), organization_id, $1, 'x', 'x' FROM departments WHERE id = $2", [foreignDept!.id, mine.id])).rejects.toMatchObject({ code: '23503' })
  })
})
