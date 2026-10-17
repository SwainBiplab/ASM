import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreateAssetInput } from '../../src/shared/assetSchemas'
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

const PDF = Buffer.from('%PDF-1.4\n% invoice\n%%EOF\n')
const asset = (categoryId: string, extra: Partial<CreateAssetInput> = {}): CreateAssetInput => ({
  categoryId, modelId: null, manufacturer: null, modelName: null, serialNumber: null, specifications: null, condition: 'new', operationalStatus: 'ready',
  locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null, ...extra
})

async function catalog(a: ApiSession) {
  const laptop = await a.ok('categories.create', { code: 'LAP', name: 'Laptop', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })
  const chair = await a.ok('categories.create', { code: 'CHR', name: 'Chair', description: null, assetDomain: 'facilities', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  const cables = await a.ok('categories.create', { code: 'CBL', name: 'Cables', description: null, assetDomain: 'it', trackingMode: 'bulk', serialRequired: false, serialUnique: false })
  const model = await a.ok('models.create', { categoryId: laptop.id, manufacturer: 'Dell', modelName: 'Latitude 5440', modelNumber: null, specifications: null })
  const site = await a.ok('locations.create', { locationType: 'site', name: 'Pune', code: 'PUN', parentLocationId: null, notes: null })
  const bldg = await a.ok('locations.create', { locationType: 'building', name: 'Tower A', code: null, parentLocationId: site.id, notes: null })
  const floor = await a.ok('locations.create', { locationType: 'floor', name: 'Floor 1', code: null, parentLocationId: bldg.id, notes: null })
  return { laptop, chair, cables, model, site, floor }
}

describe('asset codes', () => {
  it('issues unique sequential codes under concurrent creates', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    expect((await a.ok('assets.getCodeConfig')).nextCodePreview).toBe('AST-000001')
    const created = await Promise.all(Array.from({ length: 20 }, () => a.ok('assets.create', asset(chair.id))))
    const codes = created.map((x) => x.assetCode).sort()
    expect(new Set(codes).size).toBe(20)
    expect(codes[0]).toBe('AST-000001')
    expect(codes[19]).toBe('AST-000020')
  })

  it('requires an idempotency key for asset creation and never registers a retried request twice', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    expect((await a.s.rpc('assets.create', asset(chair.id), { cookie: a.cookie })).status).toBe(400)
    const key = randomUUID()
    const [r1, r2] = await Promise.all([
      a.s.rpc<{ assetCode: string }>('assets.create', asset(chair.id), { cookie: a.cookie, headers: { 'idempotency-key': key } }),
      a.s.rpc<{ assetCode: string }>('assets.create', asset(chair.id), { cookie: a.cookie, headers: { 'idempotency-key': key } })
    ])
    expect(r1.body).toEqual(r2.body)
    expect(Number((await a.sql<{ n: number }>('SELECT count(*) AS n FROM assets'))[0]!.n)).toBe(1)
  })

  it('keeps codes immutable and never reused; only the Super Admin changes the format', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    const first = await a.ok('assets.create', asset(chair.id))
    await expect(a.s.tdb.db.exec("UPDATE assets SET asset_code = 'X-1' WHERE id = $1", [first.id])).rejects.toThrow(/immutable/)
    await expect(a.s.tdb.db.exec('DELETE FROM assets WHERE id = $1', [first.id])).rejects.toThrow(/cannot be deleted/)
    expect(await a.call('assets.updateCodeConfig', { prefix: 'AST', separator: '-', padding: 6, nextNumber: 1, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await a.ok('assets.updateCodeConfig', { prefix: 'BPO', separator: '/', padding: 4, nextNumber: 10, reason: 'new stock' })
    expect((await a.ok('assets.create', asset(chair.id))).assetCode).toBe('BPO/0010')
    await a.becomeNewUser('am.codes', ['asset_manager'])
    expect(await a.call('assets.updateCodeConfig', { prefix: 'HACK', separator: '-', padding: 6, nextNumber: 99, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('allows the padding minimum of 2 digits and rejects anything below it', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    expect(await a.call('assets.updateCodeConfig', { prefix: 'AST', separator: '-', padding: 1, nextNumber: 1, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await a.ok('assets.updateCodeConfig', { prefix: 'AST', separator: '-', padding: 2, nextNumber: 7, reason: 'short codes' })
    expect((await a.ok('assets.create', asset(chair.id))).assetCode).toBe('AST-07')
  })
})

describe('asset rules', () => {
  it('enforces serial policy (including at the database level) and blocks bulk categories', async () => {
    const a = await session()
    const { laptop, cables, model } = await catalog(a)
    expect(await a.call('assets.create', asset(laptop.id))).toMatchObject({ ok: false, error: { fieldErrors: { serialNumber: expect.any(String) } } })
    const x = await a.ok('assets.create', asset(laptop.id, { modelId: model.id, serialNumber: 'ABC 123' }))
    expect(x).toMatchObject({ manufacturer: 'Dell', modelName: 'Latitude 5440' })
    expect(await a.call('assets.create', asset(laptop.id, { modelId: model.id, serialNumber: 'abc123' }))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
    expect(await a.call('assets.create', asset(cables.id))).toMatchObject({ ok: false, error: { fieldErrors: { categoryId: expect.stringContaining('bulk') } } })
  })

  it('hides cost from users without finance permission and refuses their cost input', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    const x = await a.ok('assets.create', asset(chair.id, { acquisitionCost: '12,500.50' }))
    expect(x).toMatchObject({ costVisible: true, acquisitionCostMinor: 1250050 })
    await a.becomeNewUser('am.cost', ['asset_manager'])
    const seen = await a.ok('assets.get', { id: x.id })
    expect(seen).toMatchObject({ costVisible: false, acquisitionCostMinor: null })
    expect(await a.call('assets.create', asset(chair.id, { acquisitionCost: '10' }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    await a.ok('assets.update', { ...asset(chair.id), id: x.id, notes: 'moved', reason: null })
    expect(Number((await a.sql<{ c: number }>('SELECT acquisition_cost_minor AS c FROM assets WHERE id = $1', [x.id]))[0]!.c)).toBe(1250050)
  })

  it('follows lifecycle transitions and makes disposal final', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    const x = await a.ok('assets.create', asset(chair.id))
    const move = (toStatus: string, extra: Record<string, unknown> = {}) =>
      a.call('assets.changeLifecycle', { id: x.id, toStatus, reason: 'r', effectiveDate: '2026-10-01', disposalMethod: null, disposalProceeds: null, ...extra } as never)
    expect(await move('disposed')).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    await move('lost')
    expect(await move('active')).toMatchObject({ ok: true, data: { operationalStatus: 'awaiting_inspection' } })
    await move('retired')
    expect(await move('disposed', { disposalMethod: 'scrapped' })).toMatchObject({ ok: true, data: { lifecycleStatus: 'disposed', disposalDate: '2026-10-01' } })
    expect(await a.call('assets.update', { ...asset(chair.id), id: x.id, reason: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect(await a.call('assets.generateLabels', { assetIds: [x.id] })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })

  it('searches, looks up exactly and reports metrics from live data', async () => {
    const a = await session()
    const { laptop, chair, site, floor } = await catalog(a)
    const today = new Date()
    const inDays = (d: number) => new Date(today.getTime() + d * 86_400_000).toISOString().slice(0, 10)
    const x = await a.ok('assets.create', asset(laptop.id, { serialNumber: 'XYZ-9', locationId: floor.id, warrantyEnd: inDays(10) }))
    await a.ok('assets.create', asset(chair.id, { locationId: site.id, warrantyEnd: inDays(-5) }))
    const codes = async (q: Record<string, unknown>) => (await a.ok('assets.search', q as never)).items.map((i) => i.assetCode)
    expect(await codes({ query: 'xyz' })).toEqual([x.assetCode])
    expect(await codes({ query: x.qrPayload })).toEqual([x.assetCode])
    expect(await codes({ locationId: site.id })).toHaveLength(2)
    expect(await codes({ warranty: 'expiring' })).toEqual([x.assetCode])
    expect(await a.ok('assets.lookup', { query: `${x.assetCode.toLowerCase()}\r\n` })).toMatchObject({ matchType: 'asset_code', matches: [{ id: x.id }] })
    expect(await a.ok('assets.lookup', { query: ' xyz-9 ' })).toMatchObject({ matchType: 'serial' })
    expect(await a.ok('assets.lookup', { query: 'BPOAM:ASSET:not-a-uuid' })).toMatchObject({ matchType: 'none' })
    expect((await a.ok('dashboard.getSummary')).assets).toMatchObject({ totalActive: 2, ready: 2, warrantyExpiringSoon: 1 })
    const [label] = await a.ok('assets.generateLabels', { assetIds: [x.id] })
    expect(Buffer.from(label!.qrDataUrl.split(',')[1]!, 'base64').toString('utf8')).toMatch(/^<svg/)
  })
})

describe('documents', () => {
  it('uploads with validation, downloads with authorization and checksum checks, and unlinks softly', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    const x = await a.ok('assets.create', asset(chair.id))
    const url = `/api/v1/uploads/documents?entityType=asset&entityId=${x.id}&purpose=invoice`
    expect((await a.upload(url, { name: 'invoice.pdf', content: PDF, type: 'application/pdf' })).status).toBe(400) // no idempotency key
    const up = await a.upload(url, { name: 'C:\\fake\\path\\invoice.pdf', content: PDF, type: 'application/pdf' }, { 'idempotency-key': randomUUID() })
    expect(up).toMatchObject({ status: 200, body: { ok: true, data: { originalName: 'invoice.pdf', scanStatus: 'not_scanned', openable: true } } })
    const link = (up.body as { data: { documentId: string; linkId: string } }).data
    const stored = (await a.sql<{ storage_key: string }>('SELECT storage_key FROM documents'))[0]!.storage_key
    expect(stored).toMatch(/^[0-9a-f-]{36}\/assets\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/)
    expect(JSON.stringify(await a.ok('assets.get', { id: x.id }))).not.toContain(stored)

    expect((await a.upload(url, { name: 'fake.pdf', content: 'MZ not a pdf' }, { 'idempotency-key': randomUUID() })).status).toBe(400)
    expect((await a.upload(url, { name: 'virus.exe', content: 'MZ' }, { 'idempotency-key': randomUUID() })).status).toBe(400)
    expect((await a.upload(url, { name: 'invoice.pdf', content: PDF, type: 'image/png' }, { 'idempotency-key': randomUUID() })).status).toBe(400)
    expect((await a.upload(url.replace(x.id, randomUUID()), { name: 'a.pdf', content: PDF }, { 'idempotency-key': randomUUID() })).status).toBe(404)

    const dl = await a.get(`/api/v1/documents/${link.documentId}/content`)
    expect(dl.status).toBe(200)
    expect(dl.headers['content-type']).toBe('application/pdf')
    expect(String(dl.headers['content-disposition'])).toMatch(/^inline; filename="invoice.pdf"/)
    expect(dl.headers['x-content-type-options']).toBe('nosniff')
    expect(dl.raw.equals(PDF)).toBe(true)

    await a.becomeNewUser('agent.docs', ['employee'])
    expect((await a.get(`/api/v1/documents/${link.documentId}/content`)).status).toBe(403)
    await a.becomeAdmin()

    await a.s.storage.put(stored, Buffer.from('tampered'))
    expect((await a.get(`/api/v1/documents/${link.documentId}/content`)).status).toBe(409)
    await a.ok('documents.removeLink', { linkId: link.linkId, reason: 'wrong file' })
    expect((await a.ok('assets.get', { id: x.id })).documents).toEqual([])
    expect((await a.get(`/api/v1/documents/${link.documentId}/content`)).status).toBe(403)
    expect(Number((await a.sql<{ n: number }>('SELECT count(*) AS n FROM documents'))[0]!.n)).toBe(1)
  })

  it('replays a retried upload instead of attaching twice', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    const x = await a.ok('assets.create', asset(chair.id))
    const key = randomUUID()
    const url = `/api/v1/uploads/documents?entityType=asset&entityId=${x.id}&purpose=warranty`
    const first = await a.upload(url, { name: 'w.pdf', content: PDF }, { 'idempotency-key': key })
    const retry = await a.upload(url, { name: 'w.pdf', content: PDF }, { 'idempotency-key': key })
    expect(retry.body).toEqual(first.body)
    expect(Number((await a.sql<{ n: number }>('SELECT count(*) AS n FROM document_links'))[0]!.n)).toBe(1)
  })
})

describe('exports and organization boundary', () => {
  it('exports safe CSV, hides cost without permission and audits each export', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    await a.ok('assets.create', asset(chair.id, { acquisitionCost: '999', invoiceReference: '=CMD()' }))
    const r = await a.get('/api/v1/exports/assets.csv?lifecycle=all')
    expect(r.status).toBe(200)
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="assets-/)
    const csv = r.raw.toString('utf8')
    expect(csv).toContain('Acquisition cost (minor units)')
    expect(csv).toContain(`"'=CMD()"`)
    expect((await a.get('/api/v1/exports/assets.csv?bogus=1')).status).toBe(400)
    await a.becomeNewUser('am.export', ['asset_manager'])
    expect((await a.get('/api/v1/exports/assets.csv')).raw.toString('utf8')).not.toContain('Acquisition cost')
    await a.becomeNewUser('agent.export', ['employee'])
    expect((await a.get('/api/v1/exports/assets.csv')).status).toBe(403)
    await a.becomeAdmin()
    expect((await a.ok('audit.list', { page: 1, pageSize: 10, eventType: 'assets.exported' })).total).toBe(2)
  })

  it('never exposes another organization\'s assets or documents', async () => {
    const a = await session()
    const { chair } = await catalog(a)
    await a.ok('assets.create', asset(chair.id))
    const other = await bootstrapOrganization(a.s.tdb.db, { ...SETUP, organization: { ...SETUP.organization, legalName: 'Other BPO', displayName: 'Other' } }, newCorrelationId(), { allowAdditional: true })
    const [cat] = await a.sql<{ id: string }>("INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, asset_domain) VALUES (gen_random_uuid(), $1, 'X', 'x', 'X', 'x', 'it') RETURNING id", [other.organizationId])
    const [foreign] = await a.sql<{ id: string }>("INSERT INTO assets (id, organization_id, asset_code, category_id) VALUES (gen_random_uuid(), $1, 'AST-000001', $2) RETURNING id", [other.organizationId, cat!.id])
    expect((await a.ok('assets.search', { lifecycle: 'all' })).total).toBe(1)
    expect(await a.call('assets.get', { id: foreign!.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await a.ok('assets.lookup', { query: `BPOAM:ASSET:${foreign!.id}` })).toMatchObject({ matchType: 'none' })
    expect(await a.call('assets.generateLabels', { assetIds: [foreign!.id] })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const up = await a.upload(`/api/v1/uploads/documents?entityType=asset&entityId=${foreign!.id}&purpose=other`, { name: 'a.pdf', content: PDF }, { 'idempotency-key': randomUUID() })
    expect(up.status).toBe(404)
    expect(await a.call('assets.create', asset(cat!.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })
})
