import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreateAssetInput } from '../../src/shared/assetSchemas'
import { createReadyApp, makeTempDir, switchToNewUser, loginAsAdmin, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))
const track = (a: TestApp): TestApp => (apps.push(a), a)

const PDF = new TextEncoder().encode('%PDF-1.4\n% test invoice\n%%EOF\n')

async function catalog(app: TestApp) {
  const laptop = await app.ok('categories.create', { code: 'LAP', name: 'Laptop', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })
  const chair = await app.ok('categories.create', { code: 'CHR', name: 'Chair', description: null, assetDomain: 'facilities', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  const cables = await app.ok('categories.create', { code: 'CBL', name: 'Cables', description: null, assetDomain: 'it', trackingMode: 'bulk', serialRequired: false, serialUnique: false })
  const model = await app.ok('models.create', { categoryId: laptop.id, manufacturer: 'Dell', modelName: 'Latitude 5440', modelNumber: 'L5440', specifications: 'i5, 16 GB' })
  const supplier = await app.ok('suppliers.create', { code: 'SUP1', name: 'Acme IT Supplies', contactName: null, email: null, phone: null, address: null, taxReference: null, notes: null })
  const site = await app.ok('locations.create', { locationType: 'site', name: 'Pune', code: 'PUN', parentLocationId: null, notes: null })
  const bldg = await app.ok('locations.create', { locationType: 'building', name: 'Tower A', code: 'PUN-A', parentLocationId: site.id, notes: null })
  const floor = await app.ok('locations.create', { locationType: 'floor', name: 'Floor 1', code: 'PUN-A-F1', parentLocationId: bldg.id, notes: null })
  return { laptop, chair, cables, model, supplier, site, floor }
}

const asset = (categoryId: string, extra: Partial<CreateAssetInput> = {}): CreateAssetInput => ({
  categoryId,
  modelId: null,
  manufacturer: null,
  modelName: null,
  serialNumber: null,
  specifications: null,
  condition: 'new',
  operationalStatus: 'ready',
  locationId: null,
  supplierId: null,
  purchaseDate: null,
  acquisitionCost: null,
  invoiceReference: null,
  purchaseReference: null,
  warrantyStart: null,
  warrantyEnd: null,
  notes: null,
  ...extra
})

const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

describe('asset codes', () => {
  it('issues sequential AST-000001 codes inside the create transaction', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    expect((await app.ok('assets.getCodeConfig')).nextCodePreview).toBe('AST-000001')
    const codes: string[] = []
    for (let i = 0; i < 25; i++) codes.push((await app.ok('assets.create', asset(chair.id))).assetCode)
    expect(codes[0]).toBe('AST-000001')
    expect(codes[24]).toBe('AST-000025')
    expect(new Set(codes).size).toBe(25)
  })

  it('does not consume a number when the insert fails, and the database enforces uniqueness', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const first = await app.ok('assets.create', asset(chair.id))
    const db = app.container.dbm.db
    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON assets WHEN NEW.notes = 'boom' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END")
    expect((await app.call('assets.create', asset(chair.id, { notes: 'boom' }))).ok).toBe(false)
    db.exec('DROP TRIGGER fail_insert')
    expect((await app.ok('assets.create', asset(chair.id))).assetCode).toBe('AST-000002')
    expect(() => db.prepare("UPDATE assets SET asset_code = 'X-1' WHERE id = ?").run(first.id)).toThrow(/immutable/)
    expect(() =>
      db.prepare("INSERT INTO assets (id, organization_id, asset_code, category_id, created_at, updated_at) SELECT 'dup', organization_id, ?, category_id, 't', 't' FROM assets WHERE id = ?").run(first.assetCode, first.id)
    ).toThrow(/UNIQUE/)
  })

  it('lets only the Super Admin change prefix/numbering, never backwards, never reusing codes', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a1 = await app.ok('assets.create', asset(chair.id))
    expect(await app.call('assets.updateCodeConfig', { prefix: 'AST', separator: '-', padding: 6, nextNumber: 1, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('assets.updateCodeConfig', { prefix: 'ast', separator: '-', padding: 6, nextNumber: 5, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const cfg = await app.ok('assets.updateCodeConfig', { prefix: 'BPO', separator: '/', padding: 4, nextNumber: 10, reason: 'new label stock' })
    expect(cfg.nextCodePreview).toBe('BPO/0010')
    expect((await app.ok('assets.create', asset(chair.id))).assetCode).toBe('BPO/0010')
    expect((await app.ok('assets.get', { id: a1.id })).assetCode).toBe('AST-000001')
    // Switching back to the old prefix skips numbers already issued.
    await app.ok('assets.updateCodeConfig', { prefix: 'AST', separator: '-', padding: 6, nextNumber: 11, reason: 'revert' })
    expect((await app.ok('assets.create', asset(chair.id))).assetCode).toBe('AST-000011')

    await switchToNewUser(app, 'am.codes', ['asset_manager'])
    expect(await app.call('assets.updateCodeConfig', { prefix: 'HACK', separator: '-', padding: 6, nextNumber: 99, reason: 'x' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect((await app.ok('assets.getCodeConfig')).prefix).toBe('AST')
  })
})

describe('catalogue and asset validation', () => {
  it('snapshots model details, enforces category/model consistency and blocks bulk categories', async () => {
    const app = track(await createReadyApp())
    const { laptop, chair, cables, model } = await catalog(app)
    const a = await app.ok('assets.create', asset(laptop.id, { modelId: model.id, serialNumber: 'sn-001', manufacturer: 'ignored' }))
    expect(a).toMatchObject({ manufacturer: 'Dell', modelName: 'Latitude 5440', serialNumber: 'sn-001' })
    await app.ok('models.update', { id: model.id, categoryId: laptop.id, manufacturer: 'Dell', modelName: 'Latitude 5450', modelNumber: null, specifications: null })
    expect((await app.ok('assets.get', { id: a.id })).modelName).toBe('Latitude 5440')
    expect(await app.call('assets.create', asset(chair.id, { modelId: model.id }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { modelId: expect.any(String) } } })
    expect(await app.call('assets.create', asset(cables.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { categoryId: expect.stringContaining('bulk') } } })
  })

  it('enforces serial policy per category, including at the database level', async () => {
    const app = track(await createReadyApp())
    const { laptop, chair } = await catalog(app)
    expect(await app.call('assets.create', asset(laptop.id))).toMatchObject({ ok: false, error: { fieldErrors: { serialNumber: expect.any(String) } } })
    const a = await app.ok('assets.create', asset(laptop.id, { manufacturer: 'Dell', serialNumber: 'ABC 123' }))
    expect(await app.call('assets.create', asset(laptop.id, { manufacturer: 'dell', serialNumber: 'abc123' }))).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_RECORD', message: expect.stringContaining(a.assetCode) }
    })
    // Same serial from another manufacturer is a different device.
    expect((await app.call('assets.create', asset(laptop.id, { manufacturer: 'HP', serialNumber: 'ABC123' }))).ok).toBe(true)
    // Non-unique category allows repeats; turning uniqueness on is refused while duplicates exist.
    await app.ok('assets.create', asset(chair.id, { serialNumber: 'CH-1' }))
    await app.ok('assets.create', asset(chair.id, { serialNumber: 'ch-1' }))
    expect(await app.call('categories.update', { id: chair.id, code: 'CHR', name: 'Chair', description: null, assetDomain: 'facilities', trackingMode: 'individual', serialRequired: true, serialUnique: true })).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT' }
    })
    const db = app.container.dbm.db
    const key = (db.prepare('SELECT serial_unique_key AS k FROM assets WHERE id = ?').get(a.id) as { k: string }).k
    expect(() => db.prepare('UPDATE assets SET serial_unique_key = ? WHERE id <> ? AND category_id = ?').run(key, a.id, laptop.id)).toThrow(/UNIQUE/)
  })

  it('validates warranty dates and reference activity', async () => {
    const app = track(await createReadyApp())
    const { chair, supplier } = await catalog(app)
    expect(await app.call('assets.create', asset(chair.id, { warrantyStart: '2026-05-01', warrantyEnd: '2026-04-01' }))).toMatchObject({ ok: false, error: { fieldErrors: { warrantyEnd: expect.any(String) } } })
    await app.ok('suppliers.setActive', { id: supplier.id, isActive: false, reason: 'contract ended' })
    expect(await app.call('assets.create', asset(chair.id, { supplierId: supplier.id }))).toMatchObject({ ok: false, error: { fieldErrors: { supplierId: expect.any(String) } } })
  })
})

describe('financial fields', () => {
  it('records cost in minor units and hides it from users without finance permission', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a = await app.ok('assets.create', asset(chair.id, { acquisitionCost: '12,500.50', purchaseDate: '2026-01-10' }))
    expect(a).toMatchObject({ costVisible: true, acquisitionCostMinor: 1250050, currency: 'INR' })
    expect(await app.call('assets.create', asset(chair.id, { acquisitionCost: '12.345' }))).toMatchObject({ ok: false, error: { fieldErrors: { acquisitionCost: expect.any(String) } } })
    expect(JSON.stringify((await app.ok('assets.get', { id: a.id })).history)).not.toContain('1250050')

    await switchToNewUser(app, 'am.cost', ['asset_manager'])
    const seen = await app.ok('assets.get', { id: a.id })
    expect(seen).toMatchObject({ costVisible: false, acquisitionCostMinor: null })
    expect(await app.call('assets.create', asset(chair.id, { acquisitionCost: '10' }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    // Editing without finance permission keeps the hidden cost unchanged.
    const { id, assetCode, ...rest } = seen
    void assetCode
    await app.ok('assets.update', { ...asset(chair.id), id, notes: 'moved', reason: null, condition: rest.condition, purchaseDate: rest.purchaseDate })
    await loginAsAdmin(app)
    expect((await app.ok('assets.get', { id: a.id })).acquisitionCostMinor).toBe(1250050)
  })
})

describe('lifecycle', () => {
  it('follows allowed transitions with reasons, permissions and final disposal', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a = await app.ok('assets.create', asset(chair.id))
    const move = (toStatus: string, extra: Record<string, unknown> = {}) =>
      app.call('assets.changeLifecycle', { id: a.id, toStatus, reason: 'test', effectiveDate: '2026-10-01', disposalMethod: null, disposalProceeds: null, ...extra } as never)

    expect(await move('disposed')).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect((await move('lost')).ok).toBe(true)
    const found = await move('active')
    expect(found).toMatchObject({ ok: true, data: { lifecycleStatus: 'active', operationalStatus: 'awaiting_inspection' } })
    await move('retired')
    expect(await move('disposed')).toMatchObject({ ok: false, error: { fieldErrors: { disposalMethod: expect.any(String) } } })
    const disposed = await move('disposed', { disposalMethod: 'scrapped', disposalProceeds: '500' })
    expect(disposed).toMatchObject({ ok: true, data: { lifecycleStatus: 'disposed', disposalDate: '2026-10-01', disposalMethod: 'scrapped', disposalProceedsMinor: 50000 } })
    expect(await move('active')).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect(await app.call('assets.update', { ...asset(chair.id), id: a.id, reason: null })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    const history = (await app.ok('assets.get', { id: a.id })).history.filter((h) => h.eventType === 'asset.lifecycle_changed')
    expect(history).toHaveLength(4)
  })

  it('requires the dispose permission to dispose', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a = await app.ok('assets.create', asset(chair.id))
    await switchToNewUser(app, 'am.life', ['asset_manager'])
    await app.ok('assets.changeLifecycle', { id: a.id, toStatus: 'retired', reason: 'old', effectiveDate: '2026-10-01', disposalMethod: null, disposalProceeds: null })
    expect(await app.call('assets.changeLifecycle', { id: a.id, toStatus: 'disposed', reason: 'scrap', effectiveDate: '2026-10-02', disposalMethod: 'scrapped', disposalProceeds: null })).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' }
    })
  })
})

describe('search, lookup and dashboard', () => {
  it('filters by text, QR payload, location subtree, warranty and lifecycle', async () => {
    const app = track(await createReadyApp())
    const { laptop, chair, site, floor, supplier } = await catalog(app)
    const a = await app.ok('assets.create', asset(laptop.id, { serialNumber: 'XYZ-9', locationId: floor.id, warrantyEnd: isoIn(10), supplierId: supplier.id }))
    await app.ok('assets.create', asset(chair.id, { locationId: site.id, warrantyEnd: isoIn(-5) }))
    const old = await app.ok('assets.create', asset(chair.id))
    await app.ok('assets.changeLifecycle', { id: old.id, toStatus: 'retired', reason: 'x', effectiveDate: '2026-10-01', disposalMethod: null, disposalProceeds: null })

    const codes = async (q: Record<string, unknown>) => (await app.ok('assets.search', q as never)).items.map((i) => i.assetCode)
    expect(await codes({})).toHaveLength(2)
    expect(await codes({ lifecycle: 'all' })).toHaveLength(3)
    expect(await codes({ query: 'xyz' })).toEqual([a.assetCode])
    expect(await codes({ query: 'Acme' })).toEqual([a.assetCode])
    expect(await codes({ query: a.qrPayload })).toEqual([a.assetCode])
    expect(await codes({ locationId: site.id })).toHaveLength(2)
    expect(await codes({ locationId: floor.id })).toEqual([a.assetCode])
    expect(await codes({ warranty: 'expiring' })).toEqual([a.assetCode])
    expect(await codes({ warranty: 'expired' })).toHaveLength(1)
    expect(await codes({ warranty: 'none' })).toHaveLength(0)
    expect((await app.ok('assets.search', { query: 'xyz' })).items[0]!.locationPath).toBe('Pune / Tower A / Floor 1')

    const metrics = (await app.ok('dashboard.getSummary')).assets!
    expect(metrics).toMatchObject({ totalActive: 2, ready: 2, retired: 1, warrantyExpiringSoon: 1 })
  })

  it('looks up exactly by code, QR payload or serial, never fuzzily', async () => {
    const app = track(await createReadyApp())
    const { chair, laptop } = await catalog(app)
    const a = await app.ok('assets.create', asset(laptop.id, { serialNumber: 'SER-1' }))
    await app.ok('assets.create', asset(chair.id, { serialNumber: 'SHARED' }))
    await app.ok('assets.create', asset(chair.id, { serialNumber: 'shared' }))
    const look = (query: string) => app.ok('assets.lookup', { query })
    expect(await look(`${a.assetCode.toLowerCase()}\r\n`)).toMatchObject({ matchType: 'asset_code', matches: [{ id: a.id }] })
    expect(await look(a.qrPayload)).toMatchObject({ matchType: 'qr', matches: [{ id: a.id }] })
    expect(await look('BPOAM:ASSET:not-a-uuid')).toMatchObject({ matchType: 'none', message: expect.stringContaining('not a valid') })
    expect(await look('BPOAM:ASSET:00000000-0000-4000-8000-000000000000')).toMatchObject({ matchType: 'none' })
    expect(await look('ser-1')).toMatchObject({ matchType: 'serial', matches: [{ id: a.id }] })
    expect((await look('SHARED')).matches).toHaveLength(2)
    expect(await look('AST-0000')).toMatchObject({ matchType: 'none', matches: [] })
  })
})

describe('labels', () => {
  it('produces QR and Code 128 artwork without personal data, and respects permissions', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a = await app.ok('assets.create', asset(chair.id))
    const [label] = await app.ok('assets.generateLabels', { assetIds: [a.id] })
    expect(label).toMatchObject({ assetCode: a.assetCode, organizationName: 'Test BPO' })
    const svg = Buffer.from(label!.qrDataUrl.split(',')[1]!, 'base64').toString('utf8')
    expect(svg).toMatch(/^<svg/)
    expect(svg).not.toMatch(/<script|on[a-z]+=/i)
    expect(label!.barcodeDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect((await app.ok('assets.get', { id: a.id })).history.map((h) => h.eventType)).toContain('asset.label_generated')

    await switchToNewUser(app, 'aud.labels', ['auditor'])
    expect(await app.call('assets.generateLabels', { assetIds: [a.id] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})

describe('documents', () => {
  it('stores allow-listed files under generated keys with checksums and soft-removes links', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a = await app.ok('assets.create', asset(chair.id))
    const pick = (fileName: string, data: Uint8Array) => (app.container.pickDocumentFile = async () => ({ fileName, data }))

    pick('C:\\Users\\x\\invoice 123.pdf', PDF)
    const link = (await app.ok('documents.attach', { entityType: 'asset', entityId: a.id, purpose: 'invoice' }))!
    expect(link).toMatchObject({ originalName: 'C:\\Users\\x\\invoice 123.pdf'.slice(-255), purpose: 'invoice', openable: true, fileMissing: false })
    const doc = app.container.dbm.db.prepare('SELECT storage_key AS k, sha256 AS h FROM documents WHERE id = ?').get(link.documentId) as { k: string; h: string }
    expect(doc.k).toMatch(/^assets\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/)
    expect(existsSync(join(app.container.paths.documentsDir, doc.k))).toBe(true)

    pick('fake.pdf', new TextEncoder().encode('MZ executable'))
    expect(await app.call('documents.attach', { entityType: 'asset', entityId: a.id, purpose: 'invoice' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('does not match') } })
    pick('virus.exe', new Uint8Array([0x4d, 0x5a]))
    expect(await app.call('documents.attach', { entityType: 'asset', entityId: a.id, purpose: 'other' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('documents.attach', { entityType: 'asset', entityId: '00000000-0000-4000-8000-000000000000', purpose: 'other' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const opened: string[] = []
    app.container.openPath = async (p) => void opened.push(p)
    await app.ok('documents.open', { documentId: link.documentId })
    expect(opened).toHaveLength(1)

    const saveDir = makeTempDir()
    app.container.pickSavePath = async (name) => join(saveDir, name.replace(/[\\/:]/g, '_'))
    expect(await app.ok('documents.saveCopy', { documentId: link.documentId })).toEqual({ saved: true })
    rmSync(saveDir, { recursive: true, force: true })

    // Tampered file is refused; missing file is flagged.
    writeFileSync(join(app.container.paths.documentsDir, doc.k), 'tampered')
    expect(await app.call('documents.open', { documentId: link.documentId })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    rmSync(join(app.container.paths.documentsDir, doc.k))
    expect((await app.ok('assets.get', { id: a.id })).documents[0]!.fileMissing).toBe(true)

    await app.ok('documents.removeLink', { linkId: link.linkId, reason: 'wrong file' })
    expect((await app.ok('assets.get', { id: a.id })).documents).toEqual([])
    expect(app.container.dbm.db.prepare('SELECT count(*) AS n FROM documents').get()).toEqual({ n: 1 })
    const events = (await app.ok('assets.get', { id: a.id })).history.map((h) => h.eventType)
    expect(events).toEqual(expect.arrayContaining(['document.attached', 'document.unlinked']))
  })

  it('has no orphaned document links and includes documents in backup and restore', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    const a = await app.ok('assets.create', asset(chair.id))
    app.container.pickDocumentFile = async () => ({ fileName: 'warranty.pdf', data: PDF })
    const link = (await app.ok('documents.attach', { entityType: 'asset', entityId: a.id, purpose: 'warranty' }))!
    const orphans = app.container.dbm.db
      .prepare("SELECT count(*) AS n FROM document_links l WHERE l.entity_type = 'asset' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = l.entity_id)")
      .get() as { n: number }
    expect(orphans.n).toBe(0)

    const backup = await app.ok('backup.create')
    expect(backup.documentCount).toBe(1)
    const key = (app.container.dbm.db.prepare('SELECT storage_key AS k FROM documents').get() as { k: string }).k
    rmSync(join(app.container.paths.documentsDir, key))
    await app.ok('backup.restore', { backupId: backup.backupId, confirmation: 'RESTORE' })
    await loginAsAdmin(app)
    expect(readFileSync(join(app.container.paths.documentsDir, key)).equals(Buffer.from(PDF))).toBe(true)
    expect((await app.ok('assets.get', { id: a.id })).documents[0]).toMatchObject({ linkId: link.linkId, fileMissing: false })
  })
})

describe('export', () => {
  it('writes the filtered result as safe CSV, hides cost without permission and audits the export', async () => {
    const app = track(await createReadyApp())
    const { chair } = await catalog(app)
    await app.ok('assets.create', asset(chair.id, { notes: null, acquisitionCost: '999', invoiceReference: '=CMD()' }))
    const dir = makeTempDir()
    const file = join(dir, 'out.csv')
    app.container.pickSavePath = async () => file
    expect(await app.ok('assets.export', {})).toMatchObject({ saved: true, rowCount: 1, fileName: 'out.csv' })
    const csv = readFileSync(file, 'utf8')
    expect(csv).toContain('Acquisition cost (minor units)')
    expect(csv).toContain(`"'=CMD()"`)
    expect((await app.ok('audit.list', { page: 1, pageSize: 5, eventType: 'assets.exported' })).items[0]!.summary).toMatchObject({ rowCount: 1, includesCost: true })

    await switchToNewUser(app, 'am.export', ['asset_manager'])
    await app.ok('assets.export', {})
    expect(readFileSync(file, 'utf8')).not.toContain('Acquisition cost')
    app.container.pickSavePath = async () => null
    expect(await app.ok('assets.export', {})).toMatchObject({ saved: false })
    rmSync(dir, { recursive: true, force: true })

    await switchToNewUser(app, 'aud.export', ['employee'])
    expect(await app.call('assets.export', {})).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})
