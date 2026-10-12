import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDataPaths } from '../../src/main/app/env'
import { DatabaseManager } from '../../src/main/database/manager'
import { migration0001 } from '../../src/main/database/migrations/0001_foundation'
import { LATEST_SCHEMA_VERSION } from '../../src/main/database/migrations'
import { silentLogger } from '../../src/main/logging/logger'
import { completeSetup } from '../../src/main/services/setup'
import { ADMIN, SETUP_INPUT, createReadyApp, createTestApp, loginAsAdmin, makeTempDir, switchToNewUser, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))
const track = (a: TestApp): TestApp => (apps.push(a), a)

const dept = (name: string, code: string | null = null) => ({ code, name, managerEmployeeId: null, notes: null })
const team = (departmentId: string, name: string, code: string | null = null) => ({ departmentId, kind: 'team' as const, code, name, leadEmployeeId: null, notes: null })
const loc = (locationType: string, name: string, parentLocationId: string | null = null, code: string | null = null) =>
  ({ locationType, name, parentLocationId, code, notes: null }) as never

describe('upgrading an existing M1 database', () => {
  it('upgrades a v1 database with a verified pre-migration backup and keeps its data', async () => {
    const root = makeTempDir()
    const paths = resolveDataPaths(root)
    const v1 = new DatabaseManager(paths, silentLogger, '0.1.0', {}, [migration0001])
    await v1.open()
    await completeSetup(v1.db, SETUP_INPUT, 'test')
    v1.close()

    const app = track(await createTestApp(root))
    expect(app.container.startup.status).toBe('ready')
    expect(app.container.dbm.schemaVersion()).toBe(LATEST_SCHEMA_VERSION)
    const pre = readdirSync(paths.backupsDir).filter((d) => d.includes('pre_migration'))
    expect(pre).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(paths.backupsDir, pre[0]!, 'manifest.json'), 'utf8')).schemaVersion).toBe(1)
    expect(existsSync(join(paths.backupsDir, pre[0]!, 'database.sqlite'))).toBe(true)
    await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
    expect(await app.ok('departments.list', {})).toEqual([])
  })
})

describe('departments and teams', () => {
  it('enforces case-insensitive unique names and codes', async () => {
    const app = track(await createReadyApp())
    await app.ok('departments.create', dept('Operations', 'OPS'))
    expect(await app.call('departments.create', dept('  operations ', null))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD', fieldErrors: { name: expect.any(String) } } })
    expect(await app.call('departments.create', dept('IT', 'ops'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD', fieldErrors: { code: expect.any(String) } } })
  })

  it('scopes team names to their department and shows relationships', async () => {
    const app = track(await createReadyApp())
    const ops = await app.ok('departments.create', dept('Operations'))
    const it_ = await app.ok('departments.create', dept('IT'))
    await app.ok('teams.create', team(ops.id, 'Night Shift'))
    await app.ok('teams.create', team(it_.id, 'Night Shift'))
    expect(await app.call('teams.create', team(ops.id, 'night shift'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
    expect((await app.ok('teams.list', { departmentId: ops.id })).map((t) => t.departmentName)).toEqual(['Operations'])
    expect((await app.ok('departments.list', {})).find((d) => d.id === ops.id)!.activeTeamCount).toBe(1)
  })

  it('blocks deactivating a department with active teams, then allows it and keeps history', async () => {
    const app = track(await createReadyApp())
    const ops = await app.ok('departments.create', dept('Operations'))
    const t = await app.ok('teams.create', team(ops.id, 'Voice'))
    expect(await app.call('departments.setActive', { id: ops.id, isActive: false, reason: 'restructure' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    await app.ok('teams.setActive', { id: t.id, isActive: false, reason: 'merged' })
    await app.ok('departments.setActive', { id: ops.id, isActive: false, reason: 'restructure' })
    expect(await app.ok('departments.list', {})).toEqual([])
    expect((await app.ok('departments.list', { includeInactive: true }))[0]!.isActive).toBe(false)
    // A team cannot be reactivated inside a deactivated department.
    expect(await app.call('teams.setActive', { id: t.id, isActive: true, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('teams.create', team(ops.id, 'New'))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const events = (await app.ok('audit.list', { page: 1, pageSize: 50 })).items.map((e) => e.eventType)
    expect(events).toEqual(expect.arrayContaining(['department.created', 'team.created', 'team.deactivated', 'department.deactivated']))
  })

  it('requires a reason to deactivate', async () => {
    const app = track(await createReadyApp())
    const ops = await app.ok('departments.create', dept('Operations'))
    expect(await app.call('departments.setActive', { id: ops.id, isActive: false, reason: ' ' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })
})

describe('location hierarchy', () => {
  async function campus(app: TestApp) {
    const site = await app.ok('locations.create', loc('site', 'Pune Campus', null, 'PUN'))
    const bldg = await app.ok('locations.create', loc('building', 'Tower B', site.id))
    const floor = await app.ok('locations.create', loc('floor', 'Floor 3', bldg.id))
    const bay = await app.ok('locations.create', loc('bay', 'Bay 3A', floor.id))
    return { site, bldg, floor, bay }
  }

  it('builds paths and enforces structural parent rules', async () => {
    const app = track(await createReadyApp())
    const { site, bay } = await campus(app)
    expect(bay.path).toBe('Pune Campus / Tower B / Floor 3 / Bay 3A')
    expect(await app.call('locations.create', loc('building', 'Orphan'))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { parentLocationId: expect.any(String) } } })
    expect(await app.call('locations.create', loc('bay', 'Bad bay', site.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('locations.create', loc('site', 'Nested site', site.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect((await app.call('locations.create', loc('storage', 'IT Store', site.id))).ok).toBe(true)
  })

  it('allows the same name under different parents but not siblings', async () => {
    const app = track(await createReadyApp())
    const { bldg } = await campus(app)
    const other = await app.ok('locations.create', loc('building', 'Tower C', (await app.ok('locations.list', {})).find((l) => l.locationType === 'site')!.id))
    expect((await app.call('locations.create', loc('floor', 'Floor 3', other.id))).ok).toBe(true)
    expect(await app.call('locations.create', loc('floor', 'floor 3', bldg.id))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
  })

  it('prevents cycles and incompatible type changes', async () => {
    const app = track(await createReadyApp())
    const { floor } = await campus(app)
    const a = await app.ok('locations.create', loc('other', 'Zone A'))
    const b = await app.ok('locations.create', loc('other', 'Zone B', a.id))
    expect(await app.call('locations.update', { id: a.id, locationType: 'other', name: 'Zone A', parentLocationId: b.id, code: null, notes: null })).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT', message: expect.stringContaining('inside itself') }
    })
    // Floor holds a bay; turning it into a storage area would orphan the bay structurally.
    expect(await app.call('locations.update', { id: floor.id, locationType: 'storage', name: 'Floor 3', parentLocationId: floor.parentLocationId, code: null, notes: null })).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT' }
    })
  })

  it('blocks deactivation while sub-locations or workstations are active', async () => {
    const app = track(await createReadyApp())
    const { site, floor, bay } = await campus(app)
    const ws = await app.ok('workstations.create', { locationId: bay.id, kind: 'seat', code: 'PUN-3A-001', label: null, notes: null })
    expect(ws.locationPath).toContain('Bay 3A')
    expect(await app.call('locations.setActive', { id: floor.id, isActive: false, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect(await app.call('locations.setActive', { id: bay.id, isActive: false, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('workstation') } })
    await app.ok('workstations.setActive', { id: ws.id, isActive: false, reason: 'bay closed' })
    await app.ok('locations.setActive', { id: bay.id, isActive: false, reason: 'bay closed' })
    expect(await app.call('workstations.setActive', { id: ws.id, isActive: true, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('workstations.create', { locationId: site.id, kind: 'workstation', code: 'X1', label: null, notes: null })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', fieldErrors: { locationId: expect.any(String) } }
    })
  })

  it('enforces unique workstation codes', async () => {
    const app = track(await createReadyApp())
    const { floor } = await campus(app)
    await app.ok('workstations.create', { locationId: floor.id, kind: 'workstation', code: 'WS-1', label: null, notes: null })
    expect(await app.call('workstations.create', { locationId: floor.id, kind: 'seat', code: 'ws-1', label: null, notes: null })).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
  })
})

describe('asset pools', () => {
  it('requires a responsible unit that is consistent and active', async () => {
    const app = track(await createReadyApp())
    const ops = await app.ok('departments.create', dept('Operations'))
    const it_ = await app.ok('departments.create', dept('IT'))
    const t = await app.ok('teams.create', team(it_.id, 'Desktop Support'))
    const base = { code: null, name: 'Spare headsets', purpose: 'Floor spares', defaultLocationId: null }
    expect(await app.call('pools.create', { ...base, responsibleDepartmentId: null, responsibleTeamId: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('pools.create', { ...base, responsibleDepartmentId: ops.id, responsibleTeamId: t.id })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const pool = await app.ok('pools.create', { ...base, responsibleDepartmentId: it_.id, responsibleTeamId: t.id })
    expect(pool).toMatchObject({ responsibleDepartmentName: 'IT', responsibleTeamName: 'Desktop Support' })
    expect(await app.call('teams.setActive', { id: t.id, isActive: false, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('pool') } })
  })
})

describe('organization permissions', () => {
  it('lets read-only roles view but not change the structure', async () => {
    const app = track(await createReadyApp())
    await app.ok('departments.create', dept('Operations'))
    await switchToNewUser(app, 'auditor.one', ['auditor'])
    expect((await app.ok('departments.list', {})).length).toBe(1)
    expect(await app.call('departments.create', dept('Shadow IT'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await app.call('locations.create', loc('site', 'X'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('hides the structure from roles without any viewing permission', async () => {
    const app = track(await createReadyApp())
    await switchToNewUser(app, 'agent.one', ['employee'])
    expect(await app.call('departments.list', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(await app.call('employees.search', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await loginAsAdmin(app)
  })
})
