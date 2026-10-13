import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiSession, uploadAssetImport, type ApiSession } from './session-helpers'

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

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name))

const GOOD = [
  'Category,Manufacturer,Model,Serial Number,Condition,Location',
  'Laptops,Dell,Latitude 5420,SN-001,good,PUN',
  'Laptops,HP,EliteBook 840,SN-002,,',
  '',
  'Monitors,Dell,P2419H,,new,'
].join('\r\n')

async function withCatalog(a: ApiSession) {
  const laptops = await a.ok('categories.create', { code: 'LAP', name: 'Laptops', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })
  const monitors = await a.ok('categories.create', { code: 'MON', name: 'Monitors', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  const bulk = await a.ok('categories.create', { code: 'CAB', name: 'Cables', description: null, assetDomain: 'it', trackingMode: 'bulk', serialRequired: false, serialUnique: false })
  await a.ok('locations.create', { locationType: 'site', name: 'Pune Campus', code: 'PUN', parentLocationId: null, notes: null })
  return { laptops, monitors, bulk }
}

describe('asset CSV/Excel import over HTTP + PostgreSQL', () => {
  it('previews without writing, then commits all rows with codes issued by the server', async () => {
    const a = await session()
    await withCatalog(a)
    const auditBefore = await count(a, 'audit_events')
    const p = await uploadAssetImport(a, GOOD)
    if ('needsSheetSelection' in p) throw new Error('unexpected sheet choice for a CSV file')
    expect(p.counts).toEqual({ totalRows: 3, blankRowsSkipped: 1, accepted: 3, withWarnings: 0, rejected: 0, duplicates: 0 })
    await a.ok('assets.importPreview', { importId: p.importId, mapping: p.mapping, dateFormat: 'DD-MM-YYYY' })
    expect(await count(a, 'assets')).toBe(0)
    expect(await count(a, 'audit_events')).toBe(auditBefore)

    const r = await a.ok('assets.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })
    expect(r).toMatchObject({ imported: 3, skipped: 0 })
    const found = await a.ok('assets.search', { query: 'SN-001' })
    expect(found.items[0]).toMatchObject({ manufacturer: 'Dell', modelName: 'Latitude 5420', condition: 'good', lifecycleStatus: 'active', operationalStatus: 'ready' })
    expect(found.items[0]!.assetCode).toMatch(/^AST-\d{6}$/)
    const ev = (await a.ok('audit.list', { page: 1, pageSize: 5, eventType: 'assets.imported' })).items[0]!
    expect(JSON.stringify(ev.summary)).not.toMatch(/acquisitionCostMinor|acquisition_cost/)
  })

  it('rejects a row targeting a bulk category, a missing category, a missing required serial, and an existing-serial clash', async () => {
    const a = await session()
    const { laptops } = await withCatalog(a)
    await a.ok('assets.create', {
      categoryId: laptops.id, modelId: null, manufacturer: 'Dell', modelName: 'Old', serialNumber: 'SN-EXIST', specifications: null,
      condition: 'good', operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null,
      invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    })
    const csv = [
      'Category,Manufacturer,Serial Number',
      'Cables,Generic,',
      'Nonexistent Category,Generic,SN-100',
      'Laptops,Dell,',
      'Laptops,Dell,sn-exist'
    ].join('\n')
    const p = await uploadAssetImport(a, csv)
    if ('needsSheetSelection' in p) throw new Error('unexpected sheet choice')
    expect(p.counts).toMatchObject({ accepted: 0, rejected: 4 })
    expect(p.rows[0]!.issues[0]!.message).toMatch(/quantity-tracked/)
    expect(p.rows[1]!.issues[0]!.message).toMatch(/does not exist/)
    expect(p.rows[2]!.issues[0]!.message).toMatch(/requires a serial number/)
    expect(p.rows[3]!.issues[0]!.message).toMatch(/already registered/)
    expect(await a.call('assets.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await count(a, 'assets')).toBe(1)
  })

  it('rejects an in-file serial clash within the same category and skips only invalid rows when told to', async () => {
    const a = await session()
    await withCatalog(a)
    const csv = ['Category,Serial Number', 'Laptops,SN-DUP', 'Laptops,SN-DUP', 'Laptops,SN-900'].join('\n')
    const p = await uploadAssetImport(a, csv)
    if ('needsSheetSelection' in p) throw new Error('unexpected sheet choice')
    expect(p.counts).toMatchObject({ accepted: 1, rejected: 2 })
    expect(await a.ok('assets.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: true })).toMatchObject({ imported: 1, skipped: 2 })
    expect(await count(a, 'assets')).toBe(1)
  })

  it('blocks mapping the cost column without finance.view_cost, and imports a real cost value for a user who has it', async () => {
    const a = await session()
    await withCatalog(a)
    await a.becomeNewUser('am.import', ['asset_manager'])
    const csv = ['Category,Serial Number,Acquisition Cost', 'Laptops,SN-700,45000.00'].join('\n')
    const p = await uploadAssetImport(a, csv)
    if ('needsSheetSelection' in p) throw new Error('unexpected sheet choice')
    expect(p.fileIssues.join(' ')).toMatch(/permission to import acquisition cost/)

    await a.becomeAdmin()
    const p2 = await uploadAssetImport(a, csv)
    if ('needsSheetSelection' in p2) throw new Error('unexpected sheet choice')
    expect(p2.fileIssues).toEqual([])
    const r = await a.ok('assets.importCommit', { importId: p2.importId, mapping: p2.mapping, dateFormat: p2.dateFormat, skipInvalidRows: false })
    expect(r).toMatchObject({ imported: 1 })
    const detail = await a.ok('assets.get', { id: (await a.ok('assets.search', { query: 'SN-700' })).items[0]!.id })
    expect(detail.acquisitionCostMinor).toBe(4500000)
  })

  it('reads a single-sheet workbook directly, and a multi-sheet workbook only after a sheet is chosen', async () => {
    const a = await session()
    await withCatalog(a)
    const single = await uploadAssetImport(a, fixture('asset-import-single-sheet.xlsx'), 'single.xlsx')
    if ('needsSheetSelection' in single) throw new Error('a single-sheet workbook must not ask for a sheet')
    expect(single.counts).toMatchObject({ totalRows: 2, accepted: 2 })

    const multi = await uploadAssetImport(a, fixture('asset-import-multi-sheet.xlsx'), 'multi.xlsx')
    if (!('needsSheetSelection' in multi)) throw new Error('a multi-sheet workbook must ask for a sheet')
    expect(multi.sheets).toEqual(['IT_Assets', 'Monitors'])

    const chosen = await uploadAssetImport(a, fixture('asset-import-multi-sheet.xlsx'), 'multi.xlsx', '?sheet=Monitors')
    if ('needsSheetSelection' in chosen) throw new Error('sheet was chosen; this must not ask again')
    expect(chosen.counts).toMatchObject({ totalRows: 1, accepted: 1 })
    expect(chosen.rows[0]!.values.category).toBe('Monitors')
  })

  it('requires an idempotency key on commit and replays a retried commit instead of importing twice', async () => {
    const a = await session()
    await withCatalog(a)
    const p = await uploadAssetImport(a, 'Category\nMonitors\n')
    if ('needsSheetSelection' in p) throw new Error('unexpected sheet choice')
    const body = { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false }
    expect((await a.s.rpc('assets.importCommit', body, { cookie: a.cookie })).status).toBe(400)
    const key = randomUUID()
    const first = await a.s.rpc('assets.importCommit', body, { cookie: a.cookie, headers: { 'idempotency-key': key } })
    const retry = await a.s.rpc('assets.importCommit', body, { cookie: a.cookie, headers: { 'idempotency-key': key } })
    expect(first.status).toBe(200)
    expect(retry.body).toEqual(first.body)
    expect(await count(a, 'assets')).toBe(1)
    expect(await a.call('assets.importCommit', body)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('rejects bad files safely and binds sessions and the permission to their owner', async () => {
    const a = await session()
    await withCatalog(a)
    for (const content of ['', 'Category\n']) {
      const r = await a.upload('/api/v1/uploads/asset-import', { name: 'bad.csv', content })
      expect(r).toMatchObject({ status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR' } } })
    }
    const p = await uploadAssetImport(a, 'Category\nMonitors\n')
    if ('needsSheetSelection' in p) throw new Error('unexpected sheet choice')
    await a.becomeNewUser('am.two', ['asset_manager'])
    expect(await a.call('assets.importCommit', { importId: p.importId, mapping: p.mapping, dateFormat: p.dateFormat, skipInvalidRows: false })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await a.becomeNewUser('hr.noaccess', ['hr_officer'])
    expect((await a.upload('/api/v1/uploads/asset-import', { name: 'x.csv', content: 'Category\nMonitors\n' })).status).toBe(403)
  })
})
