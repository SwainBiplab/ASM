import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiSession, uploadImport, type ApiSession } from './session-helpers'

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})
const session = async () => {
  const a = await createApiSession()
  sessions.push(a)
  return a
}
const count = async (a: ApiSession, table: string) => Number((await a.sql<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n)

const GOOD = ['Employee ID,Full Name,Email,Department,Team,Manager ID,Location,Status,Date of Joining',
  'E002,"Kumar, Ravi",ravi@bpo.example,Operations,Voice Support,E001,PUN,Active,2026-01-15',
  'E001,"Menon ""Asha""",asha@bpo.example,OPS,,,Pune Campus,,2025-06-01',
  '',
  'E003,Neha Singh,,,VOICE,E002,,On leave,'].join('\r\n')

async function withOrg(a: ApiSession) {
  const ops = await a.ok('departments.create', { code: 'OPS', name: 'Operations', managerEmployeeId: null, notes: null })
  await a.ok('teams.create', { departmentId: ops.id, kind: 'process', code: 'VOICE', name: 'Voice Support', leadEmployeeId: null, notes: null })
  await a.ok('locations.create', { locationType: 'site', name: 'Pune Campus', code: 'PUN', parentLocationId: null, notes: null })
  return ops
}

describe('employee CSV import over HTTP + PostgreSQL', () => {
  it('previews without writing, then commits all rows with managers linked', async () => {
    const a = await session()
    const ops = await withOrg(a)
    const auditBefore = await count(a, 'audit_events')
    const p = await uploadImport(a, GOOD)
    expect(p.counts).toEqual({ totalRows: 3, blankRowsSkipped: 1, accepted: 3, withWarnings: 0, rejected: 0, duplicates: 0 })
    await a.ok('employees.importPreview', { importId: p.importId, mapping: p.mapping, dateFormat: 'DD-MM-YYYY' })
    expect(await count(a, 'employees')).toBe(0)
    expect(await count(a, 'audit_events')).toBe(auditBefore)

    const r = await a.ok('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })
    expect(r).toMatchObject({ imported: 3, skipped: 0 })
    expect((await a.ok('employees.search', { query: 'E003' })).items[0]).toMatchObject({ departmentName: 'Operations', employmentStatus: 'on_leave', managerName: 'Kumar, Ravi' })
    expect((await a.ok('employees.search', { departmentId: ops.id })).total).toBe(3)
    const ev = (await a.ok('audit.list', { page: 1, pageSize: 5, eventType: 'employees.imported' })).items[0]!
    expect(JSON.stringify(ev.summary)).not.toMatch(/Ravi|Asha|ravi@bpo/)
  })

  it('reports duplicates and errors, blocks by default and imports only accepted rows when told to skip', async () => {
    const a = await session()
    await withOrg(a)
    await a.ok('employees.create', { employeeCode: 'E100', fullName: 'Existing', email: null, phone: null, jobTitle: null, departmentId: null, teamId: null, managerEmployeeId: null, workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null })
    const p = await uploadImport(a, ['Employee ID,Full Name,Department', 'e100,Clash,', 'E200,Twin,', 'E200,Twin 2,', 'E300,,Nowhere', 'E500,Fine,Operations'].join('\n'))
    expect(p.counts).toMatchObject({ accepted: 1, rejected: 1, duplicates: 3 })
    expect(await a.call('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await count(a, 'employees')).toBe(1)
    expect(await a.ok('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: true })).toMatchObject({ imported: 1, skipped: 4 })
    expect((await a.ok('employees.search', { query: 'E100' })).items[0]!.fullName).toBe('Existing')
  })

  it('rolls back every row when a write fails mid-import and keeps the session for a retry', async () => {
    const a = await session()
    const p = await uploadImport(a, 'Employee ID,Full Name\nE1,One\nE2,Two\nE3,Three\nE4,Four\n')
    await a.s.tdb.db.exec(`CREATE FUNCTION fail_e3() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.employee_code = 'E3' THEN RAISE EXCEPTION 'simulated disk failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_e3 BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION fail_e3();`)
    const auditBefore = await count(a, 'audit_events')
    const r = await a.call('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })
    expect(r.ok).toBe(false)
    expect(await count(a, 'employees')).toBe(0)
    expect(await count(a, 'audit_events')).toBe(auditBefore)
    await a.s.tdb.db.exec('DROP TRIGGER fail_e3 ON employees')
    expect(await a.ok('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })).toMatchObject({ imported: 4 })
  })

  it('requires an idempotency key on commit and replays a retried commit instead of importing twice', async () => {
    const a = await session()
    const p = await uploadImport(a, 'Employee ID,Full Name\nE1,One\n')
    const body = { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false }
    expect((await a.s.rpc('employees.importCommit', body, { cookie: a.cookie })).status).toBe(400)
    const key = randomUUID()
    const first = await a.s.rpc('employees.importCommit', body, { cookie: a.cookie, headers: { 'idempotency-key': key } })
    const retry = await a.s.rpc('employees.importCommit', body, { cookie: a.cookie, headers: { 'idempotency-key': key } })
    expect(first.status).toBe(200)
    expect(retry.body).toEqual(first.body)
    expect(await count(a, 'employees')).toBe(1)
    // A new key cannot reuse the consumed session.
    expect(await a.call('employees.importCommit', body)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('rejects bad files safely and binds sessions to their owner', async () => {
    const a = await session()
    for (const content of ['', 'Employee ID,Full Name\n', 'Employee ID,Full Name\nE1,"Broken\n', new Uint8Array([0x45, 0x2c, 0x4e, 0x0a, 0x31, 0x2c, 0xc3, 0x28])]) {
      const r = await a.upload('/api/v1/uploads/employee-import', { name: 'bad.csv', content })
      expect(r).toMatchObject({ status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR' } } })
    }
    const p = await uploadImport(a, 'Employee ID,Full Name\nE9,Nine\n')
    await a.becomeNewUser('hr.two', ['hr_officer'])
    expect(await a.call('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await a.becomeNewUser('am.import', ['asset_manager'])
    expect((await a.upload('/api/v1/uploads/employee-import', { name: 'x.csv', content: 'Employee ID,Full Name\nE1,A\n' })).status).toBe(403)
  })
})
