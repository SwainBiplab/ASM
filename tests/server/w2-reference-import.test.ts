import { afterEach, describe, expect, it } from 'vitest'
import { createApiSession, uploadReferenceImport, type ApiSession } from './session-helpers'

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

describe('reference-data CSV import (categories/models/suppliers/departments/teams/locations/workstations)', () => {
  it('imports categories: happy path, then rejects a duplicate code/name against the DB and within the file', async () => {
    const a = await session()
    const csv = ['Code,Name,Domain,Tracking,Serial Required,Serial Unique', 'LAP,Laptops,IT,Individual,Yes,Yes', 'CHR,Chairs,Facilities,,,'].join('\r\n')
    const p = await uploadReferenceImport(a, 'categories', csv)
    expect(p.counts).toMatchObject({ accepted: 2, rejected: 0, duplicates: 0 })
    expect(await count(a, 'asset_categories')).toBe(0)
    const r = await a.ok('referenceData.importCommit', { importId: p.importId, mapping: p.mapping, skipInvalidRows: false })
    expect(r).toMatchObject({ imported: 2, skipped: 0 })
    expect(await count(a, 'asset_categories')).toBe(2)
    const chairs = (await a.ok('categories.list', {})).find((c) => c.code === 'CHR')!
    expect(chairs).toMatchObject({ trackingMode: 'individual', serialRequired: false, serialUnique: false })

    // Re-importing the same code (against the DB) plus an in-file duplicate name both get caught.
    const csv2 = ['Code,Name,Domain', 'LAP,Not Laptops,IT', 'NEW,Monitors,IT', 'NEW2,Monitors,IT'].join('\r\n')
    const p2 = await uploadReferenceImport(a, 'categories', csv2)
    expect(p2.counts).toMatchObject({ accepted: 0, rejected: 0, duplicates: 3 })
    const rows = p2.rows
    expect(rows.find((x) => x.rowNumber === 2)!.issues.some((i) => i.message.includes('already exists'))).toBe(true)
    expect(rows.find((x) => x.rowNumber === 3)!.issues.some((i) => i.message.includes('more than once'))).toBe(true)
  })

  it('imports models resolving category by code, rejecting an unknown category', async () => {
    const a = await session()
    await a.ok('categories.create', { code: 'LAP', name: 'Laptops', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const csv = ['Category,Manufacturer,Model name', 'LAP,Dell,Latitude 5420', 'GHOST,Dell,Nope'].join('\r\n')
    const p = await uploadReferenceImport(a, 'models', csv)
    expect(p.counts).toMatchObject({ accepted: 1, rejected: 1 })
    expect(p.rows.find((r) => r.rowNumber === 3)!.issues[0]!.message).toContain('does not exist')
    const r = await a.ok('referenceData.importCommit', { importId: p.importId, mapping: p.mapping, skipInvalidRows: true })
    expect(r).toMatchObject({ imported: 1, skipped: 1 })
    expect((await a.ok('models.list', {}))[0]).toMatchObject({ manufacturer: 'Dell', modelName: 'Latitude 5420' })
  })

  it('imports departments then teams, resolving the department by name and rejecting a missing one', async () => {
    const a = await session()
    const deptCsv = ['Name,Code', 'Operations,OPS'].join('\r\n')
    const deptPreview = await uploadReferenceImport(a, 'departments', deptCsv)
    await a.ok('referenceData.importCommit', { importId: deptPreview.importId, mapping: deptPreview.mapping, skipInvalidRows: false })
    expect(await count(a, 'departments')).toBe(1)

    const teamCsv = ['Department,Name,Kind', 'Operations,Night Shift,Team', 'Nonexistent Dept,Day Shift,Team'].join('\r\n')
    const teamPreview = await uploadReferenceImport(a, 'teams', teamCsv)
    expect(teamPreview.counts).toMatchObject({ accepted: 1, rejected: 1 })
    expect(teamPreview.rows.find((r) => r.rowNumber === 3)!.issues[0]!.message).toContain('does not exist')
    const r = await a.ok('referenceData.importCommit', { importId: teamPreview.importId, mapping: teamPreview.mapping, skipInvalidRows: true })
    expect(r.imported).toBe(1)
    const team = (await a.ok('teams.list', { includeInactive: true }))[0]!
    expect(team).toMatchObject({ name: 'Night Shift', kind: 'team' })
  })

  it('imports locations in two passes (parents must already exist) and then a workstation inside one', async () => {
    const a = await session()
    const sitesCsv = ['Name,Type', 'Pune Campus,Site'].join('\r\n')
    const sitesPreview = await uploadReferenceImport(a, 'locations', sitesCsv)
    await a.ok('referenceData.importCommit', { importId: sitesPreview.importId, mapping: sitesPreview.mapping, skipInvalidRows: false })

    const floorsCsv = ['Name,Type,Parent location', 'Floor 2,Floor,Pune Campus', 'Floor 3,Floor,No Such Campus'].join('\r\n')
    const floorsPreview = await uploadReferenceImport(a, 'locations', floorsCsv)
    expect(floorsPreview.counts).toMatchObject({ accepted: 1, rejected: 1 })
    expect(floorsPreview.rows.find((r) => r.rowNumber === 3)!.issues[0]!.message).toContain('must already exist')
    await a.ok('referenceData.importCommit', { importId: floorsPreview.importId, mapping: floorsPreview.mapping, skipInvalidRows: true })
    const floor2 = (await a.ok('locations.list', {})).find((l) => l.name === 'Floor 2')!
    expect(floor2.path).toBe('Pune Campus / Floor 2')

    // Both rows share the same code, so -- matching the existing employee/asset importers' own
    // in-file-duplicate convention -- every row sharing the key is rejected, not just the second.
    const wsCsv = ['Location,Code', 'Floor 2,WS-001', 'Floor 2,WS-001', 'Floor 2,WS-002'].join('\r\n')
    const wsPreview = await uploadReferenceImport(a, 'workstations', wsCsv)
    expect(wsPreview.counts).toMatchObject({ accepted: 1, duplicates: 2 })
    const r = await a.ok('referenceData.importCommit', { importId: wsPreview.importId, mapping: wsPreview.mapping, skipInvalidRows: true })
    expect(r.imported).toBe(1)
    expect((await a.ok('workstations.list', {}))[0]).toMatchObject({ code: 'WS-002' })
  })

  it('enforces the same permission a hand-created record would need, per kind', async () => {
    const a = await session()
    await a.becomeNewUser('viewer-only', ['employee'])
    const csv = ['Name,Code', 'Finance,FIN'].join('\r\n')
    const res = await a.upload('/api/v1/uploads/reference-import?kind=departments', { name: 'd.csv', content: csv, type: 'text/csv' })
    expect(res.status).toBe(403)
  })

  it('an unauthenticated (unknown-column) file reports file-level issues without touching the database', async () => {
    const a = await session()
    const csv = ['Foo,Bar', '1,2'].join('\r\n')
    const p = await uploadReferenceImport(a, 'suppliers', csv)
    expect(p.fileIssues.length).toBeGreaterThan(0)
    expect(p.rows).toHaveLength(0)
  })
})
