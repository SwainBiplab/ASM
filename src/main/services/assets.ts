import type { Database as DB } from 'better-sqlite3'
import type { AssetCodeConfigView, AssetDetail, AssetListItem, AssetLookupResult, AssetMetrics, AuditEventView, Page, WarrantyState } from '@shared/api'
import {
  LIFECYCLE_TRANSITIONS,
  formatAssetCode,
  parseMoneyToMinor,
  parseQrPayload,
  qrPayloadFor,
  QR_PREFIX,
  type AssetCodeFormat,
  type LifecycleStatus
} from '@shared/assets'
import {
  assetCodeConfigSchema,
  assetLookupSchema,
  assetSearchSchema,
  changeLifecycleSchema,
  createAssetSchema,
  updateAssetSchema,
  type AssetCodeConfigInput,
  type AssetLookupInput,
  type AssetSearchInput,
  type ChangeLifecycleInput,
  type CreateAssetInput,
  type UpdateAssetInput
} from '@shared/assetSchemas'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { assertPermission } from '../auth/permissions'
import { recordAudit } from './audit'
import { normalizeSerial, serialUniqueKey } from './catalog'
import { assertAnyPermission, likePattern, requireRow } from './common'
import type { OpContext } from './context'
import { listDocumentLinks } from './documents'
import { loadLocationPaths } from './organization'
import { getSettings } from './settings'
import { getOrganizationId } from './setup'

const todayUtc = (): string => new Date().toISOString().slice(0, 10)
const addDays = (isoDate: string, days: number): string => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

function invalid(field: string, message: string): never {
  throw new AppError('VALIDATION_ERROR', message, { [field]: message })
}

const canViewCost = (ctx: OpContext): boolean => ctx.actor.permissions.has('finance.view_cost')

function baseCurrency(db: DB): string {
  return (db.prepare('SELECT base_currency AS c FROM organization_profile LIMIT 1').get() as { c: string }).c
}

// =============================== Asset codes ===============================

interface CodeConfigRow extends AssetCodeFormat {
  nextNumber: number
}

function readCodeConfig(db: DB): CodeConfigRow {
  return db.prepare('SELECT prefix, separator, padding, next_number AS nextNumber FROM asset_code_config WHERE id = 1').get() as CodeConfigRow
}

export function getAssetCodeConfig(db: DB, ctx: OpContext): AssetCodeConfigView {
  assertAnyPermission(ctx, ['assets.view', 'assets.configure_codes'])
  const c = readCodeConfig(db)
  return { ...c, nextCodePreview: formatAssetCode(c, c.nextNumber), issuedCount: (db.prepare('SELECT count(*) AS n FROM assets').get() as { n: number }).n }
}

/**
 * Super Admin changes prefix/padding/next number. Existing asset codes never change, and the
 * next number may only move forward so a code can never be issued twice.
 */
export function updateAssetCodeConfig(db: DB, raw: AssetCodeConfigInput, ctx: OpContext): AssetCodeConfigView {
  assertPermission(ctx.actor.permissions, 'assets.configure_codes')
  const input = assetCodeConfigSchema.parse(raw)
  db.transaction(() => {
    const before = readCodeConfig(db)
    if (input.nextNumber < before.nextNumber) {
      invalid('nextNumber', `The next number cannot go backwards (currently ${before.nextNumber}); earlier numbers may already be in use.`)
    }
    const preview = formatAssetCode(input, input.nextNumber)
    if (db.prepare('SELECT 1 FROM assets WHERE asset_code = ?').get(preview)) {
      invalid('nextNumber', `${preview} is already in use. Choose a higher next number or a different prefix.`)
    }
    db.prepare('UPDATE asset_code_config SET prefix = ?, separator = ?, padding = ?, next_number = ?, updated_at = ?, updated_by = ? WHERE id = 1').run(
      input.prefix, input.separator, input.padding, input.nextNumber, nowIso(), ctx.actor.userId
    )
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'asset_code_config.updated',
      entityType: 'asset_code_config',
      entityId: '1',
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: { before, after: { prefix: input.prefix, separator: input.separator, padding: input.padding, nextNumber: input.nextNumber } }
    })
  })()
  return getAssetCodeConfig(db, ctx)
}

/** Issues the next free code. Must run inside the caller's write transaction. */
function issueAssetCode(db: DB): string {
  const config = readCodeConfig(db)
  let n = config.nextNumber
  const exists = db.prepare('SELECT 1 FROM assets WHERE asset_code = ?')
  // Skips numbers already taken (possible only after a prefix was changed back).
  while (exists.get(formatAssetCode(config, n))) n++
  db.prepare('UPDATE asset_code_config SET next_number = ? WHERE id = 1').run(n + 1)
  return formatAssetCode(config, n)
}

// =============================== Queries ===============================

const LIST_COLUMNS = `
  a.id, a.asset_code AS assetCode, c.name AS categoryName, c.asset_domain AS assetDomain, a.manufacturer, a.model_name AS modelName,
  a.serial_number AS serialNumber, a.lifecycle_status AS lifecycleStatus, a.operational_status AS operationalStatus, a.condition,
  a.location_id AS locationId, a.warranty_end AS warrantyEnd, a.updated_at AS updatedAt`
const LIST_FROM = 'FROM assets a JOIN asset_categories c ON c.id = a.category_id LEFT JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN locations l ON l.id = a.location_id'

type ListRow = Omit<AssetListItem, 'locationPath'> & { locationId: string | null }

function withPaths(db: DB, rows: ListRow[]): AssetListItem[] {
  const paths = loadLocationPaths(db)
  return rows.map(({ locationId, ...r }) => ({ ...r, locationPath: locationId ? (paths.get(locationId)?.path ?? null) : null }))
}

function buildSearch(db: DB, input: ReturnType<typeof assetSearchSchema.parse>): { whereSql: string; params: unknown[]; orderSql: string } {
  const where: string[] = []
  const params: unknown[] = []
  if (input.query) {
    const qrId = parseQrPayload(input.query)
    if (qrId) {
      where.push('a.id = ?')
      params.push(qrId)
    } else {
      const p = likePattern(input.query)
      where.push(
        "(a.asset_code LIKE ? ESCAPE '\\' OR a.serial_number LIKE ? ESCAPE '\\' OR a.manufacturer LIKE ? ESCAPE '\\' OR a.model_name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\' OR a.invoice_reference LIKE ? ESCAPE '\\')"
      )
      params.push(p, p, p, p, p, p, p)
    }
  }
  if (input.categoryId) {
    where.push('a.category_id = ?')
    params.push(input.categoryId)
  }
  if (input.lifecycle !== 'all') {
    where.push('a.lifecycle_status = ?')
    params.push(input.lifecycle)
  }
  if (input.operational) {
    where.push('a.operational_status = ?')
    params.push(input.operational)
  }
  if (input.condition) {
    where.push('a.condition = ?')
    params.push(input.condition)
  }
  if (input.supplierId) {
    where.push('a.supplier_id = ?')
    params.push(input.supplierId)
  }
  if (input.locationId) {
    // Includes every sub-location (a floor filter also finds assets in its bays).
    where.push(`a.location_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT x.id FROM locations x JOIN sub ON x.parent_location_id = sub.id) SELECT id FROM sub)`)
    params.push(input.locationId)
  }
  const today = todayUtc()
  if (input.warranty === 'none') where.push('a.warranty_end IS NULL')
  else if (input.warranty === 'expired') {
    where.push('a.warranty_end < ?')
    params.push(today)
  } else if (input.warranty === 'in_warranty') {
    where.push('a.warranty_end >= ?')
    params.push(today)
  } else if (input.warranty === 'expiring') {
    where.push('a.warranty_end BETWEEN ? AND ?')
    params.push(today, addDays(today, getSettings(db).warrantyExpiryWindowDays))
  }
  const dir = input.direction === 'desc' ? 'DESC' : 'ASC'
  const order = {
    code: `a.asset_code ${dir}`,
    created: `a.created_at ${dir}, a.asset_code ${dir}`,
    warranty: `a.warranty_end IS NULL, a.warranty_end ${dir}, a.asset_code`,
    category: `c.name COLLATE NOCASE ${dir}, a.asset_code`
  }[input.sort]
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params, orderSql: `ORDER BY ${order}` }
}

export function searchAssets(db: DB, raw: AssetSearchInput, ctx: OpContext): Page<AssetListItem> {
  assertPermission(ctx.actor.permissions, 'assets.view')
  const input = assetSearchSchema.parse(raw)
  const { whereSql, params, orderSql } = buildSearch(db, input)
  const total = (db.prepare(`SELECT count(*) AS n ${LIST_FROM} ${whereSql}`).get(...params) as { n: number }).n
  const rows = db.prepare(`SELECT ${LIST_COLUMNS} ${LIST_FROM} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`).all(...params, input.pageSize, (input.page - 1) * input.pageSize) as ListRow[]
  return { items: withPaths(db, rows), total, page: input.page, pageSize: input.pageSize }
}

/** Full (unpaginated, capped) result set for CSV export; cost columns only for finance viewers. */
export function exportAssetRows(db: DB, raw: AssetSearchInput, ctx: OpContext): { headers: string[]; rows: Array<Array<string | number | null>>; includesCost: boolean } {
  assertPermission(ctx.actor.permissions, 'assets.view')
  assertPermission(ctx.actor.permissions, 'reports.export')
  const input = assetSearchSchema.parse({ ...raw, page: 1, pageSize: 200 })
  const { whereSql, params, orderSql } = buildSearch(db, input)
  const includesCost = canViewCost(ctx)
  const rows = db
    .prepare(
      `SELECT ${LIST_COLUMNS}, s.name AS supplierName, a.purchase_date AS purchaseDate, a.invoice_reference AS invoiceReference,
              a.warranty_start AS warrantyStart, a.acquisition_cost_minor AS cost, a.currency
       ${LIST_FROM} ${whereSql} ${orderSql} LIMIT 50000`
    )
    .all(...params) as Array<ListRow & { supplierName: string | null; purchaseDate: string | null; invoiceReference: string | null; warrantyStart: string | null; cost: number | null; currency: string | null }>
  const paths = loadLocationPaths(db)
  const headers = ['Asset code', 'Category', 'Manufacturer', 'Model', 'Serial number', 'Lifecycle', 'Operational status', 'Condition', 'Location', 'Supplier', 'Purchase date', 'Invoice reference', 'Warranty start', 'Warranty end']
  if (includesCost) headers.push('Acquisition cost (minor units)', 'Currency')
  return {
    headers,
    includesCost,
    rows: rows.map((r) => {
      const base: Array<string | number | null> = [r.assetCode, r.categoryName, r.manufacturer, r.modelName, r.serialNumber, r.lifecycleStatus, r.operationalStatus, r.condition,
        r.locationId ? (paths.get(r.locationId)?.path ?? null) : null, r.supplierName, r.purchaseDate, r.invoiceReference, r.warrantyStart, r.warrantyEnd]
      if (includesCost) base.push(r.cost, r.currency)
      return base
    })
  }
}

function warrantyState(db: DB, end: string | null): WarrantyState {
  if (!end) return 'none'
  const today = todayUtc()
  if (end < today) return 'expired'
  return end <= addDays(today, getSettings(db).warrantyExpiryWindowDays) ? 'expiring' : 'active'
}

export function getAsset(db: DB, id: string, ctx: OpContext): AssetDetail {
  assertPermission(ctx.actor.permissions, 'assets.view')
  const row = requireRow(
    db
      .prepare(
        `SELECT a.id, a.asset_code AS assetCode, a.category_id AS categoryId, c.name AS categoryName, c.asset_domain AS assetDomain,
                c.serial_required AS serialRequired, a.model_id AS modelId, a.manufacturer, a.model_name AS modelName, a.serial_number AS serialNumber,
                a.specifications, a.lifecycle_status AS lifecycleStatus, a.operational_status AS operationalStatus, a.condition,
                a.location_id AS locationId, a.supplier_id AS supplierId, s.name AS supplierName, a.purchase_date AS purchaseDate,
                a.acquisition_cost_minor AS acquisitionCostMinor, a.disposal_proceeds_minor AS disposalProceedsMinor, a.currency,
                a.invoice_reference AS invoiceReference, a.purchase_reference AS purchaseReference, a.warranty_start AS warrantyStart,
                a.warranty_end AS warrantyEnd, a.disposal_date AS disposalDate, a.disposal_method AS disposalMethod, a.notes,
                a.created_at AS createdAt, a.updated_at AS updatedAt
         FROM assets a JOIN asset_categories c ON c.id = a.category_id LEFT JOIN suppliers s ON s.id = a.supplier_id
         WHERE a.id = ?`
      )
      .get(id) as (Omit<AssetDetail, 'serialRequired' | 'qrPayload' | 'locationPath' | 'costVisible' | 'warrantyState' | 'documents' | 'history' | 'currency'> & { serialRequired: number; currency: string | null }) | undefined,
    'Asset'
  )
  const costVisible = canViewCost(ctx)
  return {
    ...row,
    serialRequired: !!row.serialRequired,
    qrPayload: qrPayloadFor(row.id),
    currency: row.currency ?? baseCurrency(db),
    locationPath: row.locationId ? (loadLocationPaths(db).get(row.locationId)?.path ?? null) : null,
    costVisible,
    acquisitionCostMinor: costVisible ? row.acquisitionCostMinor : null,
    disposalProceedsMinor: costVisible ? row.disposalProceedsMinor : null,
    warrantyState: warrantyState(db, row.warrantyEnd),
    documents: listDocumentLinks(db, 'asset', id),
    history: assetHistory(db, id)
  }
}

function assetHistory(db: DB, assetId: string): AuditEventView[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.occurred_at AS occurredAt, a.actor_user_id AS actorUserId, u.display_name AS actorName, a.event_type AS eventType,
              a.entity_type AS entityType, a.entity_id AS entityId, a.reason, a.correlation_id AS correlationId, a.summary_json AS summaryJson
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.entity_type = 'asset' AND a.entity_id = ?
       ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 200`
    )
    .all(assetId) as Array<Omit<AuditEventView, 'summary'> & { summaryJson: string | null }>
  return rows.map(({ summaryJson, ...r }) => ({ ...r, summary: summaryJson ? (JSON.parse(summaryJson) as Record<string, unknown>) : null }))
}

/**
 * Exact identification for scanners and manual entry (TAS §10.2–10.3): QR payload, asset code,
 * or serial number. Never fuzzy; the caller must confirm before any state change.
 */
export function lookupAsset(db: DB, raw: AssetLookupInput, ctx: OpContext): AssetLookupResult {
  assertPermission(ctx.actor.permissions, 'assets.view')
  // Scanners may append CR/LF/TAB or other control characters.
  const query = assetLookupSchema.parse(raw).query.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const find = (where: string, ...params: unknown[]) =>
    withPaths(db, db.prepare(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE ${where} ORDER BY a.asset_code LIMIT 50`).all(...params) as ListRow[])

  if (query.toUpperCase().startsWith(QR_PREFIX)) {
    const id = parseQrPayload(query)
    if (!id) return { matchType: 'none', matches: [], message: 'This QR code is not a valid asset label.' }
    const matches = find('a.id = ?', id)
    return matches.length
      ? { matchType: 'qr', matches, message: `Found ${matches[0]!.assetCode} from its QR label.` }
      : { matchType: 'none', matches: [], message: 'This label belongs to an asset that is not in this database.' }
  }
  const byCode = find('a.asset_code = ?', query.toUpperCase())
  if (byCode.length) return { matchType: 'asset_code', matches: byCode, message: `Found ${byCode[0]!.assetCode}.` }
  const bySerial = find('a.serial_normalized = ?', normalizeSerial(query))
  if (bySerial.length) {
    return {
      matchType: 'serial',
      matches: bySerial,
      message: bySerial.length === 1 ? `Found ${bySerial[0]!.assetCode} by serial number.` : `${bySerial.length} assets share this serial number. Choose the right one.`
    }
  }
  return { matchType: 'none', matches: [], message: `No asset has the code or serial number "${query}".` }
}

export function getAssetMetrics(db: DB, ctx: OpContext): AssetMetrics | null {
  if (!ctx.actor.permissions.has('assets.view')) return null
  const counts = db
    .prepare(
      `SELECT
         sum(lifecycle_status = 'active') AS totalActive,
         sum(lifecycle_status = 'active' AND operational_status = 'ready') AS ready,
         sum(lifecycle_status = 'active' AND operational_status = 'under_maintenance') AS underMaintenance,
         sum(lifecycle_status = 'active' AND operational_status = 'awaiting_inspection') AS awaitingInspection,
         sum(lifecycle_status = 'active' AND operational_status = 'non_operational') AS nonOperational,
         sum(lifecycle_status = 'lost') AS lost,
         sum(lifecycle_status = 'retired') AS retired,
         sum(lifecycle_status = 'disposed') AS disposed
       FROM assets`
    )
    .get() as Record<string, number | null>
  const window = getSettings(db).warrantyExpiryWindowDays
  const today = todayUtc()
  const expiring = (db.prepare("SELECT count(*) AS n FROM assets WHERE lifecycle_status = 'active' AND warranty_end BETWEEN ? AND ?").get(today, addDays(today, window)) as { n: number }).n
  const n = (k: string) => counts[k] ?? 0
  return {
    totalActive: n('totalActive'), ready: n('ready'), underMaintenance: n('underMaintenance'), awaitingInspection: n('awaitingInspection'),
    nonOperational: n('nonOperational'), lost: n('lost'), retired: n('retired'), disposed: n('disposed'),
    warrantyExpiringSoon: expiring, warrantyWindowDays: window
  }
}

// =============================== Mutations ===============================

interface ResolvedAsset {
  categoryId: string
  modelId: string | null
  manufacturer: string | null
  modelName: string | null
  serialNumber: string | null
  serialNormalized: string | null
  serialUniqueKey: string | null
}

/** Validates category/model/serial/location/supplier and returns snapshot values. */
function resolveAssetRefs(db: DB, input: { categoryId: string; modelId: string | null; manufacturer: string | null; modelName: string | null; serialNumber: string | null; locationId: string | null; supplierId: string | null; warrantyStart: string | null; warrantyEnd: string | null }, selfId: string | null): ResolvedAsset {
  const cat = db.prepare('SELECT is_active AS a, tracking_mode AS t, serial_required AS sr, serial_unique AS su FROM asset_categories WHERE id = ?').get(input.categoryId) as
    | { a: number; t: string; sr: number; su: number }
    | undefined
  if (!cat) invalid('categoryId', 'Category not found')
  if (!cat.a) invalid('categoryId', 'Category is deactivated')
  if (cat.t !== 'individual') invalid('categoryId', 'This category is quantity-tracked (bulk stock). Bulk stock is recorded through procurement receipts, not as individual assets.')

  let manufacturer = input.manufacturer
  let modelName = input.modelName
  if (input.modelId) {
    const m = db.prepare('SELECT category_id AS c, is_active AS a, manufacturer, model_name AS n FROM asset_models WHERE id = ?').get(input.modelId) as
      | { c: string; a: number; manufacturer: string; n: string }
      | undefined
    if (!m) invalid('modelId', 'Model not found')
    if (m.c !== input.categoryId) invalid('modelId', 'The model belongs to a different category')
    if (!m.a && !selfId) invalid('modelId', 'Model is deactivated')
    // Snapshot from the catalogue so later catalogue edits never rewrite asset history.
    manufacturer = m.manufacturer
    modelName = m.n
  }

  const serialNormalized = input.serialNumber ? normalizeSerial(input.serialNumber) : null
  if (cat.sr && !serialNormalized) invalid('serialNumber', 'This category requires a serial number')
  const uniqueKey = cat.su && serialNormalized ? serialUniqueKey(input.categoryId, manufacturer, serialNormalized) : null
  if (uniqueKey) {
    const clash = db.prepare('SELECT asset_code AS c FROM assets WHERE serial_unique_key = ? AND id <> ?').get(uniqueKey, selfId ?? '') as { c: string } | undefined
    if (clash) throw new AppError('DUPLICATE_RECORD', `Serial number already registered on ${clash.c}.`, { serialNumber: `Already registered on ${clash.c}` })
  }

  if (input.locationId) {
    const l = db.prepare('SELECT is_active AS a FROM locations WHERE id = ?').get(input.locationId) as { a: number } | undefined
    if (!l) invalid('locationId', 'Location not found')
    if (!l.a) invalid('locationId', 'Location is deactivated')
  }
  if (input.supplierId) {
    const s = db.prepare('SELECT is_active AS a FROM suppliers WHERE id = ?').get(input.supplierId) as { a: number } | undefined
    if (!s) invalid('supplierId', 'Supplier not found')
    if (!s.a && !selfId) invalid('supplierId', 'Supplier is deactivated')
  }
  if (input.warrantyStart && input.warrantyEnd && input.warrantyEnd < input.warrantyStart) invalid('warrantyEnd', 'Warranty end is before warranty start')
  return { categoryId: input.categoryId, modelId: input.modelId, manufacturer, modelName, serialNumber: input.serialNumber, serialNormalized, serialUniqueKey: uniqueKey }
}

function parseCost(db: DB, value: string | null, field: string, ctx: OpContext): number | null {
  if (value === null) return null
  if (!canViewCost(ctx)) throw new AppError('PERMISSION_DENIED', 'You do not have permission to record financial values.', { [field]: 'Requires finance permission' })
  const currency = baseCurrency(db)
  const minor = parseMoneyToMinor(value, currency)
  if (minor === null) invalid(field, `Enter an amount like 45000.00 (${currency})`)
  return minor
}

export function createAsset(db: DB, raw: CreateAssetInput, ctx: OpContext): AssetDetail {
  assertPermission(ctx.actor.permissions, 'assets.create')
  const input = createAssetSchema.parse(raw)
  const id = newId()
  let code = ''
  db.transaction(() => {
    const r = resolveAssetRefs(db, input, null)
    const cost = parseCost(db, input.acquisitionCost, 'acquisitionCost', ctx)
    code = issueAssetCode(db)
    const now = nowIso()
    db.prepare(
      `INSERT INTO assets (id, organization_id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, serial_unique_key,
                           specifications, operational_status, condition, location_id, supplier_id, purchase_date, acquisition_cost_minor, currency,
                           invoice_reference, purchase_reference, warranty_start, warranty_end, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, getOrganizationId(db), code, r.categoryId, r.modelId, r.manufacturer, r.modelName, r.serialNumber, r.serialNormalized, r.serialUniqueKey,
      input.specifications, input.operationalStatus, input.condition, input.locationId, input.supplierId, input.purchaseDate, cost, baseCurrency(db),
      input.invoiceReference, input.purchaseReference, input.warrantyStart, input.warrantyEnd, input.notes, now, now
    )
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'asset.created',
      entityType: 'asset',
      entityId: id,
      correlationId: ctx.correlationId,
      // Cost values are left out: asset history is visible to users without finance permission.
      summary: { assetCode: code, categoryId: r.categoryId, modelId: r.modelId, serialNumber: r.serialNumber, locationId: input.locationId, condition: input.condition, costRecorded: cost !== null }
    })
  })()
  return getAsset(db, id, ctx)
}

const AUDITED_FIELDS = ['categoryId', 'modelId', 'manufacturer', 'modelName', 'serialNumber', 'specifications', 'condition', 'operationalStatus', 'locationId', 'supplierId', 'purchaseDate', 'invoiceReference', 'purchaseReference', 'warrantyStart', 'warrantyEnd', 'notes'] as const

export function updateAsset(db: DB, raw: UpdateAssetInput, ctx: OpContext): AssetDetail {
  assertPermission(ctx.actor.permissions, 'assets.update')
  const input = updateAssetSchema.parse(raw)
  db.transaction(() => {
    const before = getAsset(db, input.id, ctx)
    if (before.lifecycleStatus === 'disposed') throw new AppError('STATE_CONFLICT', 'Disposed assets cannot be edited. Their record is kept as history.')
    // Under maintenance is controlled by maintenance tickets (M5); other edits keep that status.
    const operationalStatus = before.operationalStatus === 'under_maintenance' ? before.operationalStatus : input.operationalStatus
    const r = resolveAssetRefs(db, input, input.id)
    // Users without finance permission never see costs, so they cannot set or clear them either.
    const costVisible = canViewCost(ctx)
    let cost = parseCost(db, input.acquisitionCost, 'acquisitionCost', ctx) // rejects a value from non-finance users
    if (!costVisible) cost = (db.prepare('SELECT acquisition_cost_minor AS c FROM assets WHERE id = ?').get(input.id) as { c: number | null }).c
    db.prepare(
      `UPDATE assets SET category_id = ?, model_id = ?, manufacturer = ?, model_name = ?, serial_number = ?, serial_normalized = ?, serial_unique_key = ?,
              specifications = ?, operational_status = ?, condition = ?, location_id = ?, supplier_id = ?, purchase_date = ?, acquisition_cost_minor = ?,
              invoice_reference = ?, purchase_reference = ?, warranty_start = ?, warranty_end = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      r.categoryId, r.modelId, r.manufacturer, r.modelName, r.serialNumber, r.serialNormalized, r.serialUniqueKey, input.specifications,
      operationalStatus, input.condition, input.locationId, input.supplierId, input.purchaseDate, cost, input.invoiceReference,
      input.purchaseReference, input.warrantyStart, input.warrantyEnd, input.notes, nowIso(), input.id
    )
    const after: Record<string, unknown> = { ...input, operationalStatus, manufacturer: r.manufacturer, modelName: r.modelName }
    const changed: Record<string, { from: unknown; to: unknown }> = {}
    for (const f of AUDITED_FIELDS) {
      const prev = (before as unknown as Record<string, unknown>)[f] ?? null
      if (prev !== (after[f] ?? null)) changed[f] = { from: prev, to: after[f] ?? null }
    }
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'asset.updated',
      entityType: 'asset',
      entityId: input.id,
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: { assetCode: before.assetCode, changed, costChanged: costVisible && cost !== before.acquisitionCostMinor }
    })
  })()
  return getAsset(db, input.id, ctx)
}

/**
 * Moves an asset through its lifecycle (TAS §7.1). Reinstated or found assets go to
 * "awaiting inspection" so they are never counted as ready without a check.
 */
export function changeLifecycle(db: DB, raw: ChangeLifecycleInput, ctx: OpContext): AssetDetail {
  const input = changeLifecycleSchema.parse(raw)
  db.transaction(() => {
    const a = db.prepare('SELECT asset_code AS code, lifecycle_status AS s, operational_status AS o FROM assets WHERE id = ?').get(input.id) as
      | { code: string; s: LifecycleStatus; o: string }
      | undefined
    if (!a) throw new AppError('NOT_FOUND', 'Asset not found.')
    const transition = LIFECYCLE_TRANSITIONS[a.s][input.toStatus]
    if (!transition) throw new AppError('STATE_CONFLICT', `An asset that is ${a.s} cannot be changed to ${input.toStatus}.`)
    assertPermission(ctx.actor.permissions, transition.permission)
    if (a.o === 'under_maintenance') throw new AppError('STATE_CONFLICT', 'Close the maintenance ticket before changing the lifecycle status.')
    // M4: reject when the asset has an active assignment.

    const isDisposal = input.toStatus === 'disposed'
    if (isDisposal && !input.disposalMethod) invalid('disposalMethod', 'Choose how the asset was disposed of')
    if (!isDisposal && (input.disposalMethod || input.disposalProceeds)) invalid('disposalMethod', 'Disposal details apply only to disposal')
    const proceeds = isDisposal ? parseCost(db, input.disposalProceeds, 'disposalProceeds', ctx) : null
    const operational = input.toStatus === 'active' ? 'awaiting_inspection' : a.o

    db.prepare(
      `UPDATE assets SET lifecycle_status = ?, operational_status = ?, disposal_date = ?, disposal_method = ?, disposal_proceeds_minor = ?, updated_at = ? WHERE id = ?`
    ).run(input.toStatus, operational, isDisposal ? input.effectiveDate : null, isDisposal ? input.disposalMethod : null, proceeds, nowIso(), input.id)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'asset.lifecycle_changed',
      entityType: 'asset',
      entityId: input.id,
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: { assetCode: a.code, from: a.s, to: input.toStatus, action: transition.label, effectiveDate: input.effectiveDate, disposalMethod: input.disposalMethod, proceedsRecorded: proceeds !== null }
    })
  })()
  return getAsset(db, input.id, ctx)
}

