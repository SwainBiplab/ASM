import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEMO_ADMIN, seedDemoData } from '../../src/main/app/demoSeed'
import { createTestApp, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))

async function seeded(): Promise<TestApp> {
  const app = await createTestApp()
  apps.push(app)
  expect((await seedDemoData(app.container)).skipped).toBe(false)
  await app.ok('session.login', { username: DEMO_ADMIN.username, password: DEMO_ADMIN.password })
  return app
}

async function previewFile(app: TestApp, path: string) {
  app.setPickedFile({ fileName: path, content: readFileSync(path) })
  return (await app.ok('employees.importSelectFile'))!
}

describe('demo data and sample import files', () => {
  it('seeds a consistent organization once and is idempotent', async () => {
    const app = await seeded()
    expect((await app.ok('employees.search', { status: 'all', pageSize: 1 })).total).toBeGreaterThan(100)
    expect((await app.ok('departments.list', {})).every((d) => d.managerName)).toBe(true)
    expect((await app.ok('assets.search', { lifecycle: 'all', pageSize: 1 })).total).toBe(165)
    expect((await app.ok('dashboard.getSummary')).assets).toMatchObject({ lost: 2, retired: 2, disposed: 1 })
    expect((await seedDemoData(app.container)).skipped).toBe(true)
  })

  it('clean sample imports fully, including a manager defined later in the file', async () => {
    const app = await seeded()
    const p = await previewFile(app, 'docs/samples/employees-import-clean.csv')
    expect(p.fileIssues).toEqual([])
    expect(p.counts).toMatchObject({ totalRows: 8, accepted: 8, rejected: 0, duplicates: 0 })
    const r = await app.ok('employees.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })
    expect(r.imported).toBe(8)
  })

  it('error sample shows every kind of problem', async () => {
    const app = await seeded()
    const p = await previewFile(app, 'docs/samples/employees-import-with-errors.csv')
    expect(p.counts).toEqual({ totalRows: 15, blankRowsSkipped: 0, accepted: 3, withWarnings: 3, rejected: 9, duplicates: 3 })
  })
})
