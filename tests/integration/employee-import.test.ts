import { afterEach, describe, expect, it } from 'vitest'
import type { ImportPreview } from '../../src/shared/api'
import type { ImportMapping } from '../../src/shared/orgSchemas'
import { createReadyApp, switchToNewUser, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))
const track = (a: TestApp): TestApp => (apps.push(a), a)

async function withOrg(app: TestApp) {
  const ops = await app.ok('departments.create', { code: 'OPS', name: 'Operations', managerEmployeeId: null, notes: null })
  await app.ok('teams.create', { departmentId: ops.id, kind: 'process', code: 'VOICE', name: 'Voice Support', leadEmployeeId: null, notes: null })
  const site = await app.ok('locations.create', { locationType: 'site', name: 'Pune Campus', code: 'PUN', parentLocationId: null, notes: null })
  return { ops, site }
}

const count = (app: TestApp, sql: string): number => (app.container.dbm.db.prepare(sql).get() as { n: number }).n
const employeeCount = (app: TestApp) => count(app, 'SELECT count(*) AS n FROM employees')
const auditCount = (app: TestApp) => count(app, 'SELECT count(*) AS n FROM audit_events')

async function load(app: TestApp, content: string): Promise<ImportPreview> {
  app.setPickedFile({ fileName: 'employees.csv', content })
  const preview = await app.ok('employees.importSelectFile')
  if (!preview) throw new Error('expected a preview')
  return preview
}

const commit = (app: TestApp, p: ImportPreview, skipInvalidRows = false, mapping: ImportMapping = p.mapping) =>
  app.call('employees.importCommit', { importId: p.importId, mapping, dateFormat: p.dateFormat, skipInvalidRows })

const GOOD_CSV = [
  'Employee ID,Full Name,Email,Department,Team,Manager ID,Location,Status,Date of Joining',
  'E002,"Kumar, Ravi",ravi@bpo.example,Operations,Voice Support,E001,PUN,Active,2026-01-15',
  'E001,"Menon ""Asha""",asha@bpo.example,OPS,,,Pune Campus,,2025-06-01',
  '',
  'E003,Neha Singh,,,VOICE,E002,,On leave,'
].join('\r\n')

describe('employee CSV import: happy path', () => {
  it('previews without writing, then commits all rows with managers linked in one transaction', async () => {
    const app = track(await createReadyApp())
    const { ops } = await withOrg(app)
    const auditBefore = auditCount(app)

    const p = await load(app, GOOD_CSV)
    expect(p.mapping).toMatchObject({ employeeCode: 0, fullName: 1, email: 2, department: 3, team: 4, managerCode: 5, workLocation: 6, employmentStatus: 7, joiningDate: 8 })
    expect(p.fileIssues).toEqual([])
    expect(p.counts).toEqual({ totalRows: 3, blankRowsSkipped: 1, accepted: 3, withWarnings: 0, rejected: 0, duplicates: 0 })
    expect(p.rows.map((r) => r.rowNumber)).toEqual([2, 3, 5])
    // Re-previewing with another date format is also read-only.
    await app.ok('employees.importPreview', { importId: p.importId, mapping: p.mapping, dateFormat: 'DD-MM-YYYY' })
    expect(employeeCount(app)).toBe(0)
    expect(auditCount(app)).toBe(auditBefore)

    const result = await commit(app, p)
    expect(result).toMatchObject({ ok: true, data: { imported: 3, skipped: 0 } })
    const ravi = (await app.ok('employees.search', { query: 'E002' })).items[0]!
    expect(ravi).toMatchObject({ fullName: 'Kumar, Ravi', departmentName: 'Operations', teamName: 'Voice Support', managerName: 'Menon "Asha"' })
    const neha = (await app.ok('employees.search', { query: 'E003' })).items[0]!
    expect(neha).toMatchObject({ departmentName: 'Operations', employmentStatus: 'on_leave', managerName: 'Kumar, Ravi' })
    expect((await app.ok('employees.search', { departmentId: ops.id })).total).toBe(3)

    const ev = (await app.ok('audit.list', { page: 1, pageSize: 5, eventType: 'employees.imported' })).items
    expect(ev).toHaveLength(1)
    expect(ev[0]!.summary).toMatchObject({ imported: 3, totalRows: 3, fileName: 'employees.csv', fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const serialized = JSON.stringify(ev[0]!.summary)
    for (const secret of ['Ravi', 'Asha', 'ravi@bpo.example', 'Neha']) expect(serialized).not.toContain(secret)
  })

  it('returns null and creates nothing when the user cancels the file dialog', async () => {
    const app = track(await createReadyApp())
    app.setPickedFile(null)
    expect(await app.ok('employees.importSelectFile')).toBeNull()
  })
})

describe('employee CSV import: validation and duplicates', () => {
  it('reports in-file and existing duplicates and row errors with clear counts', async () => {
    const app = track(await createReadyApp())
    await withOrg(app)
    await app.ok('employees.create', {
      employeeCode: 'E100', fullName: 'Existing', email: 'taken@bpo.example', phone: null, jobTitle: null, departmentId: null, teamId: null,
      managerEmployeeId: null, workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null
    })
    const p = await load(
      app,
      [
        'Employee ID,Full Name,Email,Department,Date of Joining',
        'e100,Clash With Existing,,,', // duplicate (existing, case-insensitive)
        'E200,Twin One,,,',
        'E200,Twin Two,,,', // duplicate within file
        'E300,,bad-email,Nowhere,31-12-2026', // rejected: name, email, department, date
        'E400,Shares Email,TAKEN@bpo.example,,', // warning (policy = warn)
        'E500,Fine,,Operations,2026-02-01',
        'E600,Short row'
      ].join('\n')
    )
    expect(p.counts).toEqual({ totalRows: 7, blankRowsSkipped: 0, accepted: 2, withWarnings: 1, rejected: 2, duplicates: 3 })
    const byRow = new Map(p.rows.map((r) => [r.rowNumber, r]))
    expect(byRow.get(2)!.status).toBe('duplicate')
    expect([byRow.get(3)!.status, byRow.get(4)!.status]).toEqual(['duplicate', 'duplicate'])
    expect(byRow.get(5)!.issues.map((i) => i.field).sort()).toEqual(['department', 'email', 'fullName', 'joiningDate'].sort())
    expect(byRow.get(6)).toMatchObject({ status: 'warning', issues: [{ field: 'email', severity: 'warning' }] })
    expect(byRow.get(8)!.issues[0]!.message).toMatch(/columns/)

    // Default: any rejected/duplicate row blocks the whole import.
    expect(await commit(app, p)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(employeeCount(app)).toBe(1)

    // Explicitly skipping invalid rows imports only accepted rows; the existing record is untouched.
    expect(await commit(app, p, true)).toMatchObject({ ok: true, data: { imported: 2, skipped: 5 } })
    expect(employeeCount(app)).toBe(3)
    expect((await app.ok('employees.search', { query: 'E100' })).items[0]!.fullName).toBe('Existing')
  })

  it('rejects duplicate emails when the policy is set to reject', async () => {
    const app = track(await createReadyApp())
    await app.ok('settings.update', { employeeDuplicateEmailPolicy: 'reject' })
    const p = await load(app, 'Employee ID,Full Name,Email\nE1,A,x@bpo.example\nE2,B,X@bpo.example\n')
    expect(p.duplicateEmailPolicy).toBe('reject')
    expect(p.counts).toMatchObject({ accepted: 0, rejected: 2 })
  })

  it('requires mapping for Employee ID and name, and lets the user remap columns', async () => {
    const app = track(await createReadyApp())
    const p = await load(app, 'Staff Ref,Person\nA1,Anita\n')
    expect(p.fileIssues.length).toBe(2)
    expect(p.rows).toEqual([])
    const mapping = { ...p.mapping, employeeCode: 0, fullName: 1 }
    const remapped = await app.ok('employees.importPreview', { importId: p.importId, mapping, dateFormat: 'YYYY-MM-DD' })
    expect(remapped.counts.accepted).toBe(1)
    expect(await app.call('employees.importPreview', { importId: p.importId, mapping: { ...mapping, email: 1 }, dateFormat: 'YYYY-MM-DD' })).toMatchObject({
      ok: true,
      data: { fileIssues: [expect.stringContaining('more than one field')] }
    })
    expect(await commit(app, p, false, mapping)).toMatchObject({ ok: true, data: { imported: 1 } })
  })

  it('propagates manager-row failures and detects reporting loops', async () => {
    const app = track(await createReadyApp())
    const p = await load(
      app,
      ['Employee ID,Full Name,Manager ID', 'A1,Bad Manager Row,', 'A2,Reports To Bad,A9', 'A3,Loop One,A4', 'A4,Loop Two,A3', 'A5,Self,A5', 'A6,,', 'A7,Under Invalid,A6'].join('\n')
    )
    const status = Object.fromEntries(p.rows.map((r) => [r.values.employeeCode, r.status]))
    expect(status).toMatchObject({ A1: 'accepted', A2: 'rejected', A3: 'rejected', A4: 'rejected', A5: 'rejected', A6: 'rejected', A7: 'rejected' })
  })

  it.each([
    ['empty file', ''],
    ['header only', 'Employee ID,Full Name\n'],
    ['unclosed quote', 'Employee ID,Full Name\nE1,"Broken\n'],
    ['invalid encoding', new Uint8Array([0x45, 0x2c, 0x4e, 0x0a, 0x31, 0x2c, 0xc3, 0x28])]
  ])('rejects %s safely without creating a session or records', async (_name, content) => {
    const app = track(await createReadyApp())
    app.setPickedFile({ fileName: 'bad.csv', content })
    expect(await app.call('employees.importSelectFile')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(employeeCount(app)).toBe(0)
  })
})

describe('employee CSV import: transaction integrity', () => {
  it('rolls back every row when a database write fails mid-import', async () => {
    const app = track(await createReadyApp())
    const p = await load(app, 'Employee ID,Full Name\nE1,One\nE2,Two\nE3,Three\nE4,Four\n')
    // Simulate a failure on the third insert (after two rows were already written).
    app.container.dbm.db.exec("CREATE TRIGGER fail_e3 BEFORE INSERT ON employees WHEN NEW.employee_code = 'E3' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END")
    const auditBefore = auditCount(app)
    const r = await commit(app, p)
    expect(r.ok).toBe(false)
    expect(employeeCount(app)).toBe(0)
    expect(auditCount(app)).toBe(auditBefore)

    // The session survives a failed commit, so the user can retry after the fault clears.
    app.container.dbm.db.exec('DROP TRIGGER fail_e3')
    expect(await commit(app, p)).toMatchObject({ ok: true, data: { imported: 4 } })
  })

  it('re-validates at commit time and refuses rows that became duplicates after preview', async () => {
    const app = track(await createReadyApp())
    const p = await load(app, 'Employee ID,Full Name\nE1,One\nE2,Two\n')
    expect(p.counts.accepted).toBe(2)
    await app.ok('employees.create', {
      employeeCode: 'E2', fullName: 'Created Meanwhile', email: null, phone: null, jobTitle: null, departmentId: null, teamId: null,
      managerEmployeeId: null, workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null
    })
    expect(await commit(app, p)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(employeeCount(app)).toBe(1)
  })

  it('cannot be committed twice or by another user, and can be cancelled', async () => {
    const app = track(await createReadyApp())
    const p = await load(app, 'Employee ID,Full Name\nE1,One\n')
    expect((await commit(app, p)).ok).toBe(true)
    expect(await commit(app, p)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const p2 = await load(app, 'Employee ID,Full Name\nE9,Nine\n')
    await switchToNewUser(app, 'hr.two', ['hr_officer'])
    expect(await commit(app, p2)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const p3 = await load(app, 'Employee ID,Full Name\nE8,Eight\n')
    await app.ok('employees.importCancel', { importId: p3.importId })
    expect(await commit(app, p3)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(employeeCount(app)).toBe(1)
  })

  it('expires abandoned import sessions', async () => {
    const app = track(await createReadyApp())
    await app.ok('settings.update', { idleTimeoutMinutes: 120 })
    const p = await load(app, 'Employee ID,Full Name\nE1,One\n')
    app.clock.now += 31 * 60_000
    expect(await app.call('employees.importPreview', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' }
    })
  })
})
