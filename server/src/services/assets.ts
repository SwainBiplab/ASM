import type { AssetCodeConfigView, AssetDetail, AssetListItem, AssetLookupResult, AssetMetrics, AuditEventView, Page, WarrantyState } from '@shared/api'
import { LIFECYCLE_TRANSITIONS, formatAssetCode, parseMoneyToMinor, parseQrPayload, qrPayloadFor, QR_PREFIX, type AssetCodeFormat, type LifecycleStatus } from '@shared/assets'
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
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { auditFrom, getSettings, recordAudit } from './foundation'
import { normalizeSerial, serialUniqueKey } from './catalog'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { listDocumentLinks } from './documents'
import { loadLocationPaths } from './organization'

/** Exported for reuse by reports.ts (W7), which needs the same UTC-date arithmetic. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10)
export const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const canViewCost = (ctx: OpContext): boolean => ctx.actor.permissions.has('finance.view_cost')

export async function baseCurrency(c: SqlClient, ctx: OpContext): Promise<string> {
  return (await c.one<{ c: string }>('SELECT base_currency AS c FROM organizations WHERE id = $1', [ctx.actor.organizationId]))!.c
}

// =============================== Asset codes (TAS B1, D20) ===============================

interface CodeConfigRow extends AssetCodeFormat {
  nextNumber: number
}

async function readCodeConfig(c: SqlClient, org: string, lock: boolean): Promise<CodeConfigRow> {
  await c.exec("INSERT INTO asset_code_config (organization_id, prefix, separator, padding, next_number) VALUES ($1, 'AST', '-', 6, 1) ON CONFLICT DO NOTHING", [org])
  return (await c.one<CodeConfigRow>(`SELECT prefix, separator, padding, next_number AS "nextNumber" FROM asset_code_config WHERE organization_id = $1${lock ? ' FOR UPDATE' : ''}`, [org]))!
}

export async function getAssetCodeConfig(c: SqlClient, ctx: OpContext): Promise<AssetCodeConfigView> {
  assertAnyPermission(ctx, ['assets.view', 'assets.configure_codes'])
  const cfg = await readCodeConfig(c, ctx.actor.organizationId, false)
  const issued = (await c.one<{ n: number }>('SELECT count(*) AS n FROM assets WHERE organization_id = $1', [ctx.actor.organizationId]))!.n
  return { ...cfg, nextCodePreview: formatAssetCode(cfg, cfg.nextNumber), issuedCount: issued }
}

/** Super Admin only; existing codes never change and the next number only moves forward. */
export async function updateAssetCodeConfig(db: Db, raw: AssetCodeConfigInput, ctx: OpContext): Promise<AssetCodeConfigView> {
  assertPermission(ctx.actor.permissions, 'assets.configure_codes')
  const input = assetCodeConfigSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const before = await readCodeConfig(t, org, true)
    if (input.nextNumber < before.nextNumber) invalid('nextNumber', `The next number cannot go backwards (currently ${before.nextNumber}); earlier numbers may already be in use.`)
    const preview = formatAssetCode(input, input.nextNumber)
    if (await t.one('SELECT 1 FROM assets WHERE organization_id = $1 AND asset_code = $2', [org, preview])) {
      invalid('nextNumber', `${preview} is already in use. Choose a higher next number or a different prefix.`)
    }
    await t.exec('UPDATE asset_code_config SET prefix = $2, separator = $3, padding = $4, next_number = $5, updated_at = now(), updated_by = $6 WHERE organization_id = $1', [
      org, input.prefix, input.separator, input.padding, input.nextNumber, ctx.actor.userId
    ])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset_code_config.updated', entityType: 'asset_code_config', entityId: org, reason: input.reason, summary: { before, after: { prefix: input.prefix, separator: input.separator, padding: input.padding, nextNumber: input.nextNumber } } })
    return getAssetCodeConfig(t, ctx)
  })
}

/** Issues the next free code under a row lock; call inside the asset-insert transaction. */
export async function issueAssetCode(c: SqlClient, org: string): Promise<string> {
  const cfg = await readCodeConfig(c, org, true)
  let n = cfg.nextNumber
  // Skip numbers already taken (possible only after a prefix was changed back).
  while (await c.one('SELECT 1 FROM assets WHERE organization_id = $1 AND asset_code = $2', [org, formatAssetCode(cfg, n)])) n++
  await c.exec('UPDATE asset_code_config SET next_number = $2 WHERE organization_id = $1', [org, n + 1])
  return formatAssetCode(cfg, n)
}

// =============================== Queries ===============================

export const LIST_COLUMNS = `
  a.id, a.asset_code AS "assetCode", c.name AS "categoryName", c.asset_domain AS "assetDomain", a.manufacturer, a.model_name AS "modelName",
  a.serial_number AS "serialNumber", a.lifecycle_status AS "lifecycleStatus", a.operational_status AS "operationalStatus", a.condition,
  a.location_id AS "locationId", a.warranty_end AS "warrantyEnd", a.updated_at AS "updatedAt"`
export const LIST_FROM = 'FROM assets a JOIN asset_categories c ON c.id = a.category_id LEFT JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN locations l ON l.id = a.location_id'
export type ListRow = Omit<AssetListItem, 'locationPath'> & { locationId: string | null }

export async function withPaths(c: SqlClient, ctx: OpContext, rows: ListRow[]): Promise<AssetListItem[]> {
  const paths = await loadLocationPaths(c, ctx.actor.organizationId)
  return rows.map(({ locationId, ...r }) => ({ ...r, locationPath: locationId ? (paths.get(locationId)?.path ?? null) : null }))
}

async function buildSearch(c: SqlClient, ctx: OpContext, input: ReturnType<typeof assetSearchSchema.parse>): Promise<{ whereSql: string; orderSql: string; p: Params }> {
  const p = new Params()
  const where = [`a.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (input.query) {
    const qrId = parseQrPayload(input.query)
    if (qrId) where.push(`a.id = ${p.add(qrId)}`)
    else {
      const q = p.add(likePattern(input.query))
      where.push(`(a.asset_code ILIKE ${q} ESCAPE '\\' OR a.serial_number ILIKE ${q} ESCAPE '\\' OR a.manufacturer ILIKE ${q} ESCAPE '\\' OR a.model_name ILIKE ${q} ESCAPE '\\' OR s.name ILIKE ${q} ESCAPE '\\' OR l.name ILIKE ${q} ESCAPE '\\' OR a.invoice_reference ILIKE ${q} ESCAPE '\\')`)
    }
  }
  if (input.categoryId) where.push(`a.category_id = ${p.add(input.categoryId)}`)
  if (input.lifecycle !== 'all') where.push(`a.lifecycle_status = ${p.add(input.lifecycle)}`)
  if (input.operational) where.push(`a.operational_status = ${p.add(input.operational)}`)
  if (input.condition) where.push(`a.condition = ${p.add(input.condition)}`)
  if (input.supplierId) where.push(`a.supplier_id = ${p.add(input.supplierId)}`)
  if (input.locationId) {
    // Includes every sub-location (a floor filter also finds assets in its bays).
    where.push(`a.location_id IN (WITH RECURSIVE sub(id) AS (SELECT ${p.add(input.locationId)}::uuid UNION ALL SELECT x.id FROM locations x JOIN sub ON x.parent_location_id = sub.id) SELECT id FROM sub)`)
  }
  const today = todayUtc()
  if (input.warranty === 'none') where.push('a.warranty_end IS NULL')
  else if (input.warranty === 'expired') where.push(`a.warranty_end < ${p.add(today)}`)
  else if (input.warranty === 'in_warranty') where.push(`a.warranty_end >= ${p.add(today)}`)
  else if (input.warranty === 'expiring') where.push(`a.warranty_end BETWEEN ${p.add(today)} AND ${p.add(addDays(today, (await getSettings(c, ctx.actor.organizationId)).warrantyExpiryWindowDays))}`)
  const dir = input.direction === 'desc' ? 'DESC' : 'ASC'
  const order = { code: `a.asset_code ${dir}`, created: `a.created_at ${dir}, a.asset_code ${dir}`, warranty: `a.warranty_end ${dir} NULLS LAST, a.asset_code`, category: `lower(c.name) ${dir}, a.asset_code` }[input.sort]
  return { whereSql: where.join(' AND '), orderSql: `ORDER BY ${order}`, p }
}

export async function searchAssets(db: Db, raw: AssetSearchInput, ctx: OpContext): Promise<Page<AssetListItem>> {
  assertPermission(ctx.actor.permissions, 'assets.view')
  const input = assetSearchSchema.parse(raw)
  const { whereSql, orderSql, p } = await buildSearch(db, ctx, input)
  const total = (await db.one<{ n: number }>(`SELECT count(*) AS n ${LIST_FROM} WHERE ${whereSql}`, p.values))!.n
  const rows = await db.many<ListRow>(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE ${whereSql} ${orderSql} LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`, p.values)
  return { items: await withPaths(db, ctx, rows), total, page: input.page, pageSize: input.pageSize }
}

/** Unpaginated (capped) rows for CSV export; cost columns only for finance viewers. */
export async function exportAssetRows(db: Db, raw: AssetSearchInput, ctx: OpContext): Promise<{ headers: string[]; rows: Array<Array<string | number | null>>; includesCost: boolean }> {
  assertPermission(ctx.actor.permissions, 'assets.view')
  assertPermission(ctx.actor.permissions, 'reports.export')
  const input = assetSearchSchema.parse({ ...raw, page: 1, pageSize: 200 })
  const { whereSql, orderSql, p } = await buildSearch(db, ctx, input)
  const includesCost = canViewCost(ctx)
  const rows = await db.many<ListRow & { supplierName: string | null; purchaseDate: string | null; invoiceReference: string | null; warrantyStart: string | null; cost: number | null; currency: string | null }>(
    `SELECT ${LIST_COLUMNS}, s.name AS "supplierName", a.purchase_date AS "purchaseDate", a.invoice_reference AS "invoiceReference",
            a.warranty_start AS "warrantyStart", a.acquisition_cost_minor AS cost, a.currency
     ${LIST_FROM} WHERE ${whereSql} ${orderSql} LIMIT 50000`,
    p.values
  )
  const paths = await loadLocationPaths(db, ctx.actor.organizationId)
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

async function warrantyState(c: SqlClient, ctx: OpContext, end: string | null): Promise<WarrantyState> {
  if (!end) return 'none'
  const today = todayUtc()
  if (end < today) return 'expired'
  return end <= addDays(today, (await getSettings(c, ctx.actor.organizationId)).warrantyExpiryWindowDays) ? 'expiring' : 'active'
}

type DetailRow = Omit<AssetDetail, 'qrPayload' | 'locationPath' | 'costVisible' | 'warrantyState' | 'documents' | 'history' | 'currency'> & { currency: string | null }

export async function getAsset(c: SqlClient, storage: DocumentStorage, id: string, ctx: OpContext): Promise<AssetDetail> {
  assertPermission(ctx.actor.permissions, 'assets.view')
  const row = requireRow(
    await c.one<DetailRow>(
      `SELECT a.id, a.asset_code AS "assetCode", a.category_id AS "categoryId", c.name AS "categoryName", c.asset_domain AS "assetDomain",
              c.serial_required AS "serialRequired", a.model_id AS "modelId", a.manufacturer, a.model_name AS "modelName", a.serial_number AS "serialNumber",
              a.specifications, a.lifecycle_status AS "lifecycleStatus", a.operational_status AS "operationalStatus", a.condition,
              a.location_id AS "locationId", a.supplier_id AS "supplierId", s.name AS "supplierName", a.purchase_date AS "purchaseDate",
              a.acquisition_cost_minor AS "acquisitionCostMinor", a.disposal_proceeds_minor AS "disposalProceedsMinor", a.currency,
              a.invoice_reference AS "invoiceReference", a.purchase_reference AS "purchaseReference", a.warranty_start AS "warrantyStart",
              a.warranty_end AS "warrantyEnd", a.disposal_date AS "disposalDate", a.disposal_method AS "disposalMethod", a.notes,
              a.created_at AS "createdAt", a.updated_at AS "updatedAt"
       FROM assets a JOIN asset_categories c ON c.id = a.category_id LEFT JOIN suppliers s ON s.id = a.supplier_id
       WHERE a.id = $1 AND a.organization_id = $2`,
      [id, ctx.actor.organizationId]
    ),
    'Asset'
  )
  const costVisible = canViewCost(ctx)
  return {
    ...row,
    qrPayload: qrPayloadFor(row.id),
    currency: row.currency ?? (await baseCurrency(c, ctx)),
    locationPath: row.locationId ? ((await loadLocationPaths(c, ctx.actor.organizationId)).get(row.locationId)?.path ?? null) : null,
    costVisible,
    // Field-level restriction (TAS 4.2): costs are removed for callers without finance permission.
    acquisitionCostMinor: costVisible ? row.acquisitionCostMinor : null,
    disposalProceedsMinor: costVisible ? row.disposalProceedsMinor : null,
    warrantyState: await warrantyState(c, ctx, row.warrantyEnd),
    documents: await listDocumentLinks(c, storage, ctx, 'asset', id),
    history: await assetHistory(c, ctx, id)
  }
}

async function assetHistory(c: SqlClient, ctx: OpContext, assetId: string): Promise<AuditEventView[]> {
  return c.many<AuditEventView>(
    `SELECT a.id, a.occurred_at AS "occurredAt", a.actor_user_id AS "actorUserId", u.display_name AS "actorName", a.event_type AS "eventType",
            a.entity_type AS "entityType", a.entity_id AS "entityId", a.reason, a.correlation_id AS "correlationId", a.summary
     FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.organization_id = $1 AND a.entity_type = 'asset' AND a.entity_id = $2
     ORDER BY a.occurred_at DESC, a.seq DESC LIMIT 200`,
    [ctx.actor.organizationId, assetId]
  )
}

/** Exact identification for scanners and manual entry: QR payload, asset code or serial. Never fuzzy. */
export async function lookupAsset(db: Db, raw: AssetLookupInput, ctx: OpContext): Promise<AssetLookupResult> {
  assertPermission(ctx.actor.permissions, 'assets.view')
  // Scanners may append CR/LF/TAB or other control characters.
  const query = assetLookupSchema.parse(raw).query.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const org = ctx.actor.organizationId
  const find = async (where: string, value: string) =>
    withPaths(db, ctx, await db.many<ListRow>(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE a.organization_id = $1 AND ${where} ORDER BY a.asset_code LIMIT 50`, [org, value]))
  if (query.toUpperCase().startsWith(QR_PREFIX)) {
    const id = parseQrPayload(query)
    if (!id) return { matchType: 'none', matches: [], message: 'This QR code is not a valid asset label.' }
    const matches = await find('a.id = $2', id)
    return matches.length ? { matchType: 'qr', matches, message: `Found ${matches[0]!.assetCode} from its QR label.` } : { matchType: 'none', matches: [], message: 'This label belongs to an asset that is not in this organization.' }
  }
  const byCode = await find('a.asset_code = $2', query.toUpperCase())
  if (byCode.length) return { matchType: 'asset_code', matches: byCode, message: `Found ${byCode[0]!.assetCode}.` }
  const bySerial = await find('a.serial_normalized = $2', normalizeSerial(query))
  if (bySerial.length) {
    return { matchType: 'serial', matches: bySerial, message: bySerial.length === 1 ? `Found ${bySerial[0]!.assetCode} by serial number.` : `${bySerial.length} assets share this serial number. Choose the right one.` }
  }
  return { matchType: 'none', matches: [], message: `No asset has the code or serial number "${query}".` }
}

export async function getAssetMetrics(c: SqlClient, ctx: OpContext): Promise<AssetMetrics | null> {
  if (!ctx.actor.permissions.has('assets.view')) return null
  const org = ctx.actor.organizationId
  const r = (await c.one<Record<string, number>>(
    `SELECT count(*) FILTER (WHERE lifecycle_status = 'active') AS "totalActive",
            count(*) FILTER (WHERE lifecycle_status = 'active' AND operational_status = 'ready') AS ready,
            count(*) FILTER (WHERE lifecycle_status = 'active' AND operational_status = 'under_maintenance') AS "underMaintenance",
            count(*) FILTER (WHERE lifecycle_status = 'active' AND operational_status = 'awaiting_inspection') AS "awaitingInspection",
            count(*) FILTER (WHERE lifecycle_status = 'active' AND operational_status = 'non_operational') AS "nonOperational",
            count(*) FILTER (WHERE lifecycle_status = 'lost') AS lost,
            count(*) FILTER (WHERE lifecycle_status = 'retired') AS retired,
            count(*) FILTER (WHERE lifecycle_status = 'disposed') AS disposed,
            count(*) FILTER (WHERE lifecycle_status = 'active' AND EXISTS (SELECT 1 FROM asset_assignments s WHERE s.asset_id = assets.id AND s.status = 'active')) AS assigned,
            count(*) FILTER (WHERE lifecycle_status = 'active' AND operational_status = 'ready' AND NOT EXISTS (SELECT 1 FROM asset_assignments s WHERE s.asset_id = assets.id AND s.status = 'active')) AS available
     FROM assets WHERE organization_id = $1`,
    [org]
  ))!
  const window = (await getSettings(c, org)).warrantyExpiryWindowDays
  const today = todayUtc()
  const expiring = (await c.one<{ n: number }>("SELECT count(*) AS n FROM assets WHERE organization_id = $1 AND lifecycle_status = 'active' AND warranty_end BETWEEN $2 AND $3", [org, today, addDays(today, window)]))!.n
  return {
    totalActive: r['totalActive']!, ready: r['ready']!, underMaintenance: r['underMaintenance']!, awaitingInspection: r['awaitingInspection']!,
    nonOperational: r['nonOperational']!, lost: r['lost']!, retired: r['retired']!, disposed: r['disposed']!, warrantyExpiringSoon: expiring, warrantyWindowDays: window,
    assigned: Number(r['assigned']), available: Number(r['available'])
  }
}

// =============================== Mutations ===============================

export interface ResolvedAsset {
  modelId: string | null
  manufacturer: string | null
  modelName: string | null
  serialNormalized: string | null
  serialUniqueKey: string | null
}

/** Exported for the procurement receiving flow (W6), which registers assets inline within its own transaction. */
export async function resolveAssetRefs(
  c: SqlClient,
  ctx: OpContext,
  input: { categoryId: string; modelId: string | null; manufacturer: string | null; modelName: string | null; serialNumber: string | null; locationId: string | null; supplierId: string | null; warrantyStart: string | null; warrantyEnd: string | null },
  selfId: string | null
): Promise<ResolvedAsset> {
  const org = ctx.actor.organizationId
  const cat = await c.one<{ a: boolean; t: string; sr: boolean; su: boolean }>(
    'SELECT is_active AS a, tracking_mode AS t, serial_required AS sr, serial_unique AS su FROM asset_categories WHERE id = $1 AND organization_id = $2',
    [input.categoryId, org]
  )
  if (!cat) invalid('categoryId', 'Category not found')
  if (!cat.a) invalid('categoryId', 'Category is deactivated')
  if (cat.t !== 'individual') invalid('categoryId', 'This category is quantity-tracked (bulk stock). Bulk stock is recorded through procurement receipts, not as individual assets.')
  let manufacturer = input.manufacturer
  let modelName = input.modelName
  if (input.modelId) {
    const m = await c.one<{ c: string; a: boolean; manufacturer: string; n: string }>('SELECT category_id AS c, is_active AS a, manufacturer, model_name AS n FROM asset_models WHERE id = $1 AND organization_id = $2', [input.modelId, org])
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
    const clash = await c.one<{ c: string }>('SELECT asset_code AS c FROM assets WHERE organization_id = $1 AND serial_unique_key = $2 AND id <> $3', [org, uniqueKey, selfId ?? '00000000-0000-0000-0000-000000000000'])
    if (clash) throw new AppError('DUPLICATE_RECORD', `Serial number already registered on ${clash.c}.`, { serialNumber: `Already registered on ${clash.c}` })
  }
  if (input.locationId) {
    const l = await c.one<{ a: boolean }>('SELECT is_active AS a FROM locations WHERE id = $1 AND organization_id = $2', [input.locationId, org])
    if (!l) invalid('locationId', 'Location not found')
    if (!l.a) invalid('locationId', 'Location is deactivated')
  }
  if (input.supplierId) {
    const s = await c.one<{ a: boolean }>('SELECT is_active AS a FROM suppliers WHERE id = $1 AND organization_id = $2', [input.supplierId, org])
    if (!s) invalid('supplierId', 'Supplier not found')
    if (!s.a && !selfId) invalid('supplierId', 'Supplier is deactivated')
  }
  if (input.warrantyStart && input.warrantyEnd && input.warrantyEnd < input.warrantyStart) invalid('warrantyEnd', 'Warranty end is before warranty start')
  return { modelId: input.modelId, manufacturer, modelName, serialNormalized, serialUniqueKey: uniqueKey }
}

export async function parseCost(c: SqlClient, ctx: OpContext, value: string | null, field: string): Promise<number | null> {
  if (value === null) return null
  if (!canViewCost(ctx)) throw new AppError('PERMISSION_DENIED', 'You do not have permission to record financial values.', { [field]: 'Requires finance permission' })
  const currency = await baseCurrency(c, ctx)
  const minor = parseMoneyToMinor(value, currency)
  if (minor === null) invalid(field, `Enter an amount like 45000.00 (${currency})`)
  return minor
}

export async function createAsset(db: Db, storage: DocumentStorage, raw: CreateAssetInput, ctx: OpContext): Promise<AssetDetail> {
  assertPermission(ctx.actor.permissions, 'assets.create')
  const input = createAssetSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    const r = await resolveAssetRefs(t, ctx, input, null)
    const cost = await parseCost(t, ctx, input.acquisitionCost, 'acquisitionCost')
    const code = await issueAssetCode(t, org)
    await t.exec(
      `INSERT INTO assets (id, organization_id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, serial_unique_key,
                           specifications, operational_status, condition, location_id, supplier_id, purchase_date, acquisition_cost_minor, currency,
                           invoice_reference, purchase_reference, warranty_start, warranty_end, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [id, org, code, input.categoryId, r.modelId, r.manufacturer, r.modelName, input.serialNumber, r.serialNormalized, r.serialUniqueKey, input.specifications,
        input.operationalStatus, input.condition, input.locationId, input.supplierId, input.purchaseDate, cost, await baseCurrency(t, ctx),
        input.invoiceReference, input.purchaseReference, input.warrantyStart, input.warrantyEnd, input.notes]
    )
    // Cost amounts stay out of audit summaries: asset history is visible without finance permission.
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset.created', entityType: 'asset', entityId: id, summary: { assetCode: code, categoryId: input.categoryId, modelId: r.modelId, serialNumber: input.serialNumber, locationId: input.locationId, condition: input.condition, costRecorded: cost !== null } })
    return getAsset(t, storage, id, ctx)
  })
}

const AUDITED_FIELDS = ['categoryId', 'modelId', 'manufacturer', 'modelName', 'serialNumber', 'specifications', 'condition', 'operationalStatus', 'locationId', 'supplierId', 'purchaseDate', 'invoiceReference', 'purchaseReference', 'warrantyStart', 'warrantyEnd', 'notes'] as const

export async function updateAsset(db: Db, storage: DocumentStorage, raw: UpdateAssetInput, ctx: OpContext): Promise<AssetDetail> {
  assertPermission(ctx.actor.permissions, 'assets.update')
  const input = updateAssetSchema.parse(raw)
  return db.tx(async (t) => {
    const locked = await t.one<{ id: string }>('SELECT id FROM assets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.id, ctx.actor.organizationId])
    if (!locked) throw new AppError('NOT_FOUND', 'Asset not found.')
    const before = await getAsset(t, storage, input.id, ctx)
    if (before.lifecycleStatus === 'disposed') throw new AppError('STATE_CONFLICT', 'Disposed assets cannot be edited. Their record is kept as history.')
    // Under maintenance is controlled by maintenance tickets (W5); other edits keep that status.
    const operationalStatus = before.operationalStatus === 'under_maintenance' ? before.operationalStatus : input.operationalStatus
    // Releasing an asset that awaits inspection is an inspection result, not a field edit (W4).
    if (before.operationalStatus === 'awaiting_inspection' && operationalStatus === 'ready') {
      throw new AppError('STATE_CONFLICT', 'This asset is awaiting inspection. Record the inspection to release it for reuse.', { operationalStatus: 'Record an inspection instead' })
    }
    const r = await resolveAssetRefs(t, ctx, input, input.id)
    const costVisible = canViewCost(ctx)
    let cost = await parseCost(t, ctx, input.acquisitionCost, 'acquisitionCost') // rejects a value from non-finance users
    if (!costVisible) cost = (await t.one<{ c: number | null }>('SELECT acquisition_cost_minor AS c FROM assets WHERE id = $1', [input.id]))!.c
    await t.exec(
      `UPDATE assets SET category_id = $2, model_id = $3, manufacturer = $4, model_name = $5, serial_number = $6, serial_normalized = $7, serial_unique_key = $8,
              specifications = $9, operational_status = $10, condition = $11, location_id = $12, supplier_id = $13, purchase_date = $14, acquisition_cost_minor = $15,
              invoice_reference = $16, purchase_reference = $17, warranty_start = $18, warranty_end = $19, notes = $20, updated_at = now() WHERE id = $1`,
      [input.id, input.categoryId, r.modelId, r.manufacturer, r.modelName, input.serialNumber, r.serialNormalized, r.serialUniqueKey, input.specifications,
        operationalStatus, input.condition, input.locationId, input.supplierId, input.purchaseDate, cost, input.invoiceReference, input.purchaseReference,
        input.warrantyStart, input.warrantyEnd, input.notes]
    )
    const after: Record<string, unknown> = { ...input, operationalStatus, manufacturer: r.manufacturer, modelName: r.modelName }
    const changed: Record<string, { from: unknown; to: unknown }> = {}
    for (const f of AUDITED_FIELDS) {
      const prev = (before as unknown as Record<string, unknown>)[f] ?? null
      if (prev !== (after[f] ?? null)) changed[f] = { from: prev, to: after[f] ?? null }
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset.updated', entityType: 'asset', entityId: input.id, reason: input.reason, summary: { assetCode: before.assetCode, changed, costChanged: costVisible && cost !== before.acquisitionCostMinor } })
    return getAsset(t, storage, input.id, ctx)
  })
}

/** Lifecycle transitions (TAS 6.4). Reinstated or found assets return as awaiting inspection. */
export async function changeLifecycle(db: Db, storage: DocumentStorage, raw: ChangeLifecycleInput, ctx: OpContext): Promise<AssetDetail> {
  const input = changeLifecycleSchema.parse(raw)
  return db.tx(async (t) => {
    const a = await t.one<{ code: string; s: LifecycleStatus; o: string }>(
      'SELECT asset_code AS code, lifecycle_status AS s, operational_status AS o FROM assets WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.id, ctx.actor.organizationId]
    )
    if (!a) throw new AppError('NOT_FOUND', 'Asset not found.')
    const transition = LIFECYCLE_TRANSITIONS[a.s][input.toStatus]
    if (!transition) throw new AppError('STATE_CONFLICT', `An asset that is ${a.s} cannot be changed to ${input.toStatus}.`)
    assertPermission(ctx.actor.permissions, transition.permission)
    if (a.o === 'under_maintenance') throw new AppError('STATE_CONFLICT', 'Close the maintenance ticket before changing the lifecycle status.')
    // TAS §6.4 / W4: an assigned asset is never retired, disposed or marked lost silently. Loss of an
    // assigned asset goes through the explicit loss report (allocations.reportLost / exit clearance).
    const assignment = await t.one<{ label: string }>(
      `SELECT CASE s.target_type WHEN 'employee' THEN e.full_name WHEN 'workstation' THEN w.code WHEN 'department' THEN d.name WHEN 'team' THEN tm.name ELSE p.name END AS label
       FROM asset_assignments s LEFT JOIN employees e ON e.id = s.employee_id LEFT JOIN workstations w ON w.id = s.workstation_id
       LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN teams tm ON tm.id = s.team_id LEFT JOIN asset_pools p ON p.id = s.pool_id
       WHERE s.asset_id = $1 AND s.status = 'active'`,
      [input.id]
    )
    if (assignment) {
      throw new AppError(
        'STATE_CONFLICT',
        input.toStatus === 'lost'
          ? `${a.code} is assigned to ${assignment.label}. Use "Report lost" on the asset's custody panel so the assignment is ended explicitly.`
          : `${a.code} is assigned to ${assignment.label}. Return it before changing its lifecycle status.`
      )
    }
    const isDisposal = input.toStatus === 'disposed'
    if (isDisposal && !input.disposalMethod) invalid('disposalMethod', 'Choose how the asset was disposed of')
    if (!isDisposal && (input.disposalMethod || input.disposalProceeds)) invalid('disposalMethod', 'Disposal details apply only to disposal')
    const proceeds = isDisposal ? await parseCost(t, ctx, input.disposalProceeds, 'disposalProceeds') : null
    const operational = input.toStatus === 'active' ? 'awaiting_inspection' : a.o
    await t.exec('UPDATE assets SET lifecycle_status = $2, operational_status = $3, disposal_date = $4, disposal_method = $5, disposal_proceeds_minor = $6, updated_at = now() WHERE id = $1', [
      input.id, input.toStatus, operational, isDisposal ? input.effectiveDate : null, isDisposal ? input.disposalMethod : null, proceeds
    ])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset.lifecycle_changed', entityType: 'asset', entityId: input.id, reason: input.reason, summary: { assetCode: a.code, from: a.s, to: input.toStatus, action: transition.label, effectiveDate: input.effectiveDate, disposalMethod: input.disposalMethod, proceedsRecorded: proceeds !== null } })
    return getAsset(t, storage, input.id, ctx)
  })
}
