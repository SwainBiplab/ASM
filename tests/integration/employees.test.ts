import { afterEach, describe, expect, it } from 'vitest'
import type { CreateEmployeeInput } from '../../src/shared/orgSchemas'
import { createReadyApp, switchToNewUser, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))
const track = (a: TestApp): TestApp => (apps.push(a), a)

const emp = (employeeCode: string, fullName: string, extra: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput => ({
  employeeCode,
  fullName,
  email: null,
  phone: null,
  jobTitle: null,
  departmentId: null,
  teamId: null,
  managerEmployeeId: null,
  workLocationId: null,
  employmentStatus: 'active',
  joiningDate: null,
  expectedExitDate: null,
  notes: null,
  ...extra
})

async function orgFixture(app: TestApp) {
  const ops = await app.ok('departments.create', { code: 'OPS', name: 'Operations', managerEmployeeId: null, notes: null })
  const it_ = await app.ok('departments.create', { code: 'IT', name: 'IT', managerEmployeeId: null, notes: null })
  const voice = await app.ok('teams.create', { departmentId: ops.id, kind: 'process', code: 'VOICE', name: 'Voice Support', leadEmployeeId: null, notes: null })
  return { ops, it_, voice }
}

describe('employee records', () => {
  it('creates employees, derives the department from the team and shows relationships', async () => {
    const app = track(await createReadyApp())
    const { ops, voice } = await orgFixture(app)
    const mgr = await app.ok('employees.create', emp('M001', 'Asha Menon', { departmentId: ops.id }))
    const e = await app.ok('employees.create', emp('E001', 'Ravi Kumar', { teamId: voice.id, managerEmployeeId: mgr.id, joiningDate: '2026-01-15' }))
    expect(e).toMatchObject({ departmentId: ops.id, departmentName: 'Operations', teamName: 'Voice Support', managerName: 'Asha Menon' })
    expect((await app.ok('employees.get', { id: mgr.id })).directReports.map((r) => r.employeeCode)).toEqual(['E001'])
  })

  it('rejects a team from another department and invalid dates', async () => {
    const app = track(await createReadyApp())
    const { it_, voice } = await orgFixture(app)
    expect(await app.call('employees.create', emp('E1', 'A', { departmentId: it_.id, teamId: voice.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { teamId: expect.any(String) } } })
    expect(await app.call('employees.create', emp('E1', 'A', { joiningDate: '2026-02-30' }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('employees.create', emp('E1', 'A', { joiningDate: '2026-05-01', expectedExitDate: '2026-04-01' }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('rejects duplicate employee IDs case-insensitively', async () => {
    const app = track(await createReadyApp())
    await app.ok('employees.create', emp('e001', 'A'))
    expect(await app.call('employees.create', emp('E001', 'B'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD', fieldErrors: { employeeCode: expect.any(String) } } })
  })

  it('applies the configurable duplicate-email policy', async () => {
    const app = track(await createReadyApp())
    await app.ok('employees.create', emp('E1', 'A', { email: 'same@bpo.example' }))
    expect((await app.call('employees.create', emp('E2', 'B', { email: 'SAME@bpo.example' }))).ok).toBe(true)
    await app.ok('settings.update', { employeeDuplicateEmailPolicy: 'reject' })
    expect(await app.call('employees.create', emp('E3', 'C', { email: 'same@bpo.example' }))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD', fieldErrors: { email: expect.any(String) } } })
  })

  it('prevents self-management and reporting loops', async () => {
    const app = track(await createReadyApp())
    const a = await app.ok('employees.create', emp('A', 'Alpha'))
    const b = await app.ok('employees.create', emp('B', 'Beta', { managerEmployeeId: a.id }))
    const c = await app.ok('employees.create', emp('C', 'Gamma', { managerEmployeeId: b.id }))
    const asInput = (d: typeof a, managerEmployeeId: string | null) => ({ ...emp(d.employeeCode, d.fullName), id: d.id, managerEmployeeId })
    expect(await app.call('employees.update', asInput(a, a.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('employees.update', asInput(a, c.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('loop') } })
  })
})

describe('employee lifecycle', () => {
  it('deactivates without deleting, keeps references and blocks new links to exited staff', async () => {
    const app = track(await createReadyApp())
    const { ops } = await orgFixture(app)
    const mgr = await app.ok('employees.create', emp('M1', 'Manager', { departmentId: ops.id }))
    const e = await app.ok('employees.create', emp('E1', 'Agent', { departmentId: ops.id, managerEmployeeId: mgr.id }))

    expect(await app.call('employees.deactivate', { id: mgr.id, actualExitDate: '2026-10-01', reason: '' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const exited = await app.ok('employees.deactivate', { id: mgr.id, actualExitDate: '2026-10-01', reason: 'Resigned' })
    expect(exited).toMatchObject({ employmentStatus: 'exited', actualExitDate: '2026-10-01', departmentId: ops.id })
    // History preserved: the report still points to the exited manager.
    expect(await app.ok('employees.get', { id: e.id })).toMatchObject({ managerEmployeeId: mgr.id, managerStatus: 'exited' })

    expect(await app.call('employees.create', emp('E2', 'New', { managerEmployeeId: mgr.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('employees.update', { ...emp('M1', 'Manager'), id: mgr.id })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect(await app.call('employees.deactivate', { id: mgr.id, actualExitDate: '2026-10-02', reason: 'again' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    const back = await app.ok('employees.reactivate', { id: mgr.id, reason: 'Rehired' })
    expect(back).toMatchObject({ employmentStatus: 'active', actualExitDate: null })
    const events = (await app.ok('audit.list', { page: 1, pageSize: 50, entityType: 'employee' })).items.map((e) => e.eventType)
    expect(events).toEqual(expect.arrayContaining(['employee.created', 'employee.deactivated', 'employee.reactivated']))
  })

  it('blocks department deactivation while current employees remain, allows it after they exit', async () => {
    const app = track(await createReadyApp())
    const ops = await app.ok('departments.create', { code: null, name: 'Ops', managerEmployeeId: null, notes: null })
    const e = await app.ok('employees.create', emp('E1', 'Agent', { departmentId: ops.id }))
    expect(await app.call('departments.setActive', { id: ops.id, isActive: false, reason: 'closing' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    await app.ok('employees.deactivate', { id: e.id, actualExitDate: '2026-10-01', reason: 'left' })
    await app.ok('departments.setActive', { id: ops.id, isActive: false, reason: 'closing' })
    expect((await app.ok('employees.get', { id: e.id })).departmentName).toBe('Ops')
  })

  it('audits personal-field changes without storing their values', async () => {
    const app = track(await createReadyApp())
    const e = await app.ok('employees.create', emp('E1', 'Agent', { email: 'old@bpo.example' }))
    await app.ok('employees.update', { ...emp('E1', 'Agent Renamed', { email: 'new@bpo.example', jobTitle: 'Team Lead' }), id: e.id })
    const ev = (await app.ok('audit.list', { page: 1, pageSize: 5, eventType: 'employee.updated' })).items[0]!
    expect(ev.summary).toMatchObject({ personalFieldsChanged: expect.arrayContaining(['fullName', 'email']), changed: { jobTitle: { from: null, to: 'Team Lead' } } })
    expect(JSON.stringify(ev.summary)).not.toContain('new@bpo.example')
    expect(JSON.stringify(ev.summary)).not.toContain('Agent Renamed')
  })
})

describe('employee search', () => {
  it('filters by text, department and status, and escapes wildcards', async () => {
    const app = track(await createReadyApp())
    const { ops } = await orgFixture(app)
    await app.ok('employees.create', emp('E1', 'Priya Rao', { departmentId: ops.id, email: 'priya@bpo.example' }))
    const gone = await app.ok('employees.create', emp('E2', 'Old Timer'))
    await app.ok('employees.create', emp('E3', '100% Agent'))
    await app.ok('employees.deactivate', { id: gone.id, actualExitDate: '2026-01-01', reason: 'left' })

    expect((await app.ok('employees.search', {})).total).toBe(2)
    expect((await app.ok('employees.search', { status: 'all' })).total).toBe(3)
    expect((await app.ok('employees.search', { status: 'exited' })).items.map((e) => e.employeeCode)).toEqual(['E2'])
    expect((await app.ok('employees.search', { query: 'PRIYA@' })).items.map((e) => e.employeeCode)).toEqual(['E1'])
    expect((await app.ok('employees.search', { departmentId: ops.id })).total).toBe(1)
    expect((await app.ok('employees.search', { query: '%' })).items.map((e) => e.employeeCode)).toEqual(['E3'])
    expect((await app.ok('employees.search', { pageSize: 1, page: 2 })).items).toHaveLength(1)
  })
})

describe('employee permissions', () => {
  it('lets HR manage employees but not the organization structure', async () => {
    const app = track(await createReadyApp())
    await switchToNewUser(app, 'hr.one', ['hr_officer'])
    expect((await app.call('employees.create', emp('E1', 'A'))).ok).toBe(true)
    expect(await app.call('departments.create', { code: null, name: 'X', managerEmployeeId: null, notes: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('gives asset managers read-only employee access', async () => {
    const app = track(await createReadyApp())
    await app.ok('employees.create', emp('E1', 'A'))
    await switchToNewUser(app, 'am.one', ['asset_manager'])
    expect((await app.ok('employees.search', {})).total).toBe(1)
    expect(await app.call('employees.create', emp('E2', 'B'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await app.call('employees.importSelectFile')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})
