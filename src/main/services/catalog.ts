import type { Database as DB } from 'better-sqlite3'
import type { CategoryView, ModelView, SupplierView } from '@shared/api'
import {
  catalogListSchema,
  catalogSetActiveSchema,
  createCategorySchema,
  createModelSchema,
  createSupplierSchema,
  updateCategorySchema,
  updateModelSchema,
  updateSupplierSchema,
  type CatalogListInput,
  type CreateCategoryInput,
  type CreateModelInput,
  type CreateSupplierInput,
  type UpdateCategoryInput,
  type UpdateModelInput,
  type UpdateSupplierInput
} from '@shared/assetSchemas'
import type { SetActiveInput } from '@shared/orgSchemas'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { assertPermission } from '../auth/permissions'
import { recordAudit } from './audit'
import { assertAnyPermission, assertUnique, likePattern, normalizeKey, normalizeOptional, requireRow } from './common'
import type { OpContext } from './context'
import { getOrganizationId } from './setup'

/** Reading the catalogue is needed by anyone who works with assets or procurement. */
const CATALOG_VIEW = ['assets.view', 'assets.create', 'reference_data.manage', 'procurement.view', 'suppliers.manage'] as const

type Flagged<T, K extends keyof T> = Omit<T, K> & { [P in K]: number }

function audit(db: DB, ctx: OpContext, eventType: string, entityType: string, entityId: string, summary: Record<string, unknown>, reason?: string): void {
  recordAudit(db, { actorUserId: ctx.actor.userId, eventType, entityType, entityId, correlationId: ctx.correlationId, summary, reason: reason ?? null })
}

function listFilters(alias: string, input: { includeInactive: boolean; search?: string | undefined }, searchCols: string[]): { where: string[]; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (!input.includeInactive) where.push(`${alias}.is_active = 1`)
  if (input.search) {
    where.push(`(${searchCols.map((c) => `${alias}.${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    for (let i = 0; i < searchCols.length; i++) params.push(likePattern(input.search))
  }
  return { where, params }
}

// =============================== Categories ===============================

const CATEGORY_SELECT = `
  SELECT c.id, c.code, c.name, c.description, c.asset_domain AS assetDomain, c.tracking_mode AS trackingMode,
         c.serial_required AS serialRequired, c.serial_unique AS serialUnique, c.is_active AS isActive,
         (SELECT count(*) FROM asset_models m WHERE m.category_id = c.id AND m.is_active = 1) AS activeModelCount,
         (SELECT count(*) FROM assets a WHERE a.category_id = c.id) AS assetCount
  FROM asset_categories c`

type CategoryRow = Flagged<CategoryView, 'isActive' | 'serialRequired' | 'serialUnique'>
const toCategory = (r: CategoryRow): CategoryView => ({ ...r, isActive: !!r.isActive, serialRequired: !!r.serialRequired, serialUnique: !!r.serialUnique })

export function listCategories(db: DB, raw: CatalogListInput, ctx: OpContext): CategoryView[] {
  assertAnyPermission(ctx, CATALOG_VIEW)
  const input = catalogListSchema.parse(raw)
  const { where, params } = listFilters('c', input, ['name', 'code'])
  return (db.prepare(`${CATEGORY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name COLLATE NOCASE`).all(...params) as CategoryRow[]).map(toCategory)
}

export function getCategory(db: DB, id: string): CategoryView {
  return toCategory(requireRow(db.prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id) as CategoryRow | undefined, 'Category'))
}

function checkCategoryUnique(db: DB, orgId: string, code: string, name: string, excludeId: string): void {
  assertUnique(db, 'SELECT 1 FROM asset_categories WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [orgId, normalizeKey(code), excludeId], 'code', 'A category with this code already exists.')
  assertUnique(db, 'SELECT 1 FROM asset_categories WHERE organization_id = ? AND name_normalized = ? AND id <> ?', [orgId, normalizeKey(name), excludeId], 'name', 'A category with this name already exists.')
}

function validateSerialPolicy(input: { serialRequired: boolean; serialUnique: boolean }): void {
  if (input.serialUnique && !input.serialRequired) {
    throw new AppError('VALIDATION_ERROR', 'Unique serial numbers require serial numbers to be mandatory.', { serialUnique: 'Turn on "serial number required" first' })
  }
}

export function createCategory(db: DB, raw: CreateCategoryInput, ctx: OpContext): CategoryView {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = createCategorySchema.parse(raw)
  validateSerialPolicy(input)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    checkCategoryUnique(db, orgId, input.code, input.name, id)
    const now = nowIso()
    db.prepare(
      `INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, description, asset_domain, tracking_mode,
                                     serial_required, serial_unique, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.code, normalizeKey(input.code), input.name, normalizeKey(input.name), input.description, input.assetDomain, input.trackingMode,
      input.serialRequired ? 1 : 0, input.serialUnique ? 1 : 0, now, now)
    audit(db, ctx, 'asset_category.created', 'asset_category', id, { code: input.code, name: input.name, assetDomain: input.assetDomain, trackingMode: input.trackingMode, serialRequired: input.serialRequired, serialUnique: input.serialUnique })
  })()
  return getCategory(db, id)
}

export function updateCategory(db: DB, raw: UpdateCategoryInput, ctx: OpContext): CategoryView {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = updateCategorySchema.parse(raw)
  validateSerialPolicy(input)
  db.transaction(() => {
    const before = getCategory(db, input.id)
    checkCategoryUnique(db, getOrganizationId(db), input.code, input.name, input.id)
    if (before.assetCount > 0) {
      if (before.trackingMode !== input.trackingMode) throw new AppError('STATE_CONFLICT', 'The tracking mode cannot change once assets exist in this category.')
      if (input.serialRequired && !before.serialRequired) {
        const missing = (db.prepare("SELECT count(*) AS n FROM assets WHERE category_id = ? AND serial_normalized IS NULL").get(input.id) as { n: number }).n
        if (missing > 0) throw new AppError('STATE_CONFLICT', `${missing} asset(s) in this category have no serial number. Add them before making serials mandatory.`)
      }
    }
    if (input.serialUnique !== before.serialUnique) rebuildSerialKeys(db, input.id, input.serialUnique)
    db.prepare(
      `UPDATE asset_categories SET code = ?, code_normalized = ?, name = ?, name_normalized = ?, description = ?, asset_domain = ?, tracking_mode = ?,
              serial_required = ?, serial_unique = ?, updated_at = ? WHERE id = ?`
    ).run(input.code, normalizeKey(input.code), input.name, normalizeKey(input.name), input.description, input.assetDomain, input.trackingMode,
      input.serialRequired ? 1 : 0, input.serialUnique ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, 'asset_category.updated', 'asset_category', input.id, {
      before: { code: before.code, name: before.name, assetDomain: before.assetDomain, serialRequired: before.serialRequired, serialUnique: before.serialUnique },
      after: { code: input.code, name: input.name, assetDomain: input.assetDomain, serialRequired: input.serialRequired, serialUnique: input.serialUnique }
    })
  })()
  return getCategory(db, input.id)
}

/** Recomputes the DB-enforced serial uniqueness keys when a category's policy changes. */
function rebuildSerialKeys(db: DB, categoryId: string, unique: boolean): void {
  if (!unique) {
    db.prepare('UPDATE assets SET serial_unique_key = NULL WHERE category_id = ?').run(categoryId)
    return
  }
  const rows = db.prepare('SELECT id, asset_code AS code, manufacturer, serial_normalized AS s FROM assets WHERE category_id = ? AND serial_normalized IS NOT NULL').all(categoryId) as Array<{ id: string; code: string; manufacturer: string | null; s: string }>
  const seen = new Map<string, string>()
  const set = db.prepare('UPDATE assets SET serial_unique_key = ? WHERE id = ?')
  for (const r of rows) {
    const key = serialUniqueKey(categoryId, r.manufacturer, r.s)
    const clash = seen.get(key)
    if (clash) throw new AppError('STATE_CONFLICT', `Serial numbers are not unique in this category yet (for example ${clash} and ${r.code}). Correct them first.`)
    seen.set(key, r.code)
    set.run(key, r.id)
  }
}

export const normalizeSerial = (s: string): string => s.trim().replace(/\s+/g, '').toUpperCase()
export const serialUniqueKey = (categoryId: string, manufacturer: string | null, serialNormalized: string): string =>
  `${categoryId}|${manufacturer ? normalizeKey(manufacturer) : ''}|${serialNormalized}`

export function setCategoryActive(db: DB, raw: SetActiveInput, ctx: OpContext): CategoryView {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = catalogSetActiveSchema.parse(raw)
  db.transaction(() => {
    const c = getCategory(db, input.id)
    if (c.isActive === input.isActive) return
    if (!input.isActive && c.activeModelCount > 0) throw new AppError('STATE_CONFLICT', `Deactivate the ${c.activeModelCount} active model(s) in this category first.`)
    db.prepare('UPDATE asset_categories SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'asset_category.reactivated' : 'asset_category.deactivated', 'asset_category', input.id, { name: c.name }, input.reason)
  })()
  return getCategory(db, input.id)
}

// =============================== Models ===============================

const MODEL_SELECT = `
  SELECT m.id, m.category_id AS categoryId, c.name AS categoryName, m.manufacturer, m.model_name AS modelName, m.model_number AS modelNumber,
         m.specifications, m.is_active AS isActive, (SELECT count(*) FROM assets a WHERE a.model_id = m.id) AS assetCount
  FROM asset_models m JOIN asset_categories c ON c.id = m.category_id`

type ModelRow = Flagged<ModelView, 'isActive'>
const toModel = (r: ModelRow): ModelView => ({ ...r, isActive: !!r.isActive })

export function listModels(db: DB, raw: CatalogListInput, ctx: OpContext): ModelView[] {
  assertAnyPermission(ctx, CATALOG_VIEW)
  const input = catalogListSchema.parse(raw)
  const { where, params } = listFilters('m', input, ['manufacturer', 'model_name', 'model_number'])
  if (input.categoryId) {
    where.push('m.category_id = ?')
    params.push(input.categoryId)
  }
  const sql = `${MODEL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.manufacturer COLLATE NOCASE, m.model_name COLLATE NOCASE`
  return (db.prepare(sql).all(...params) as ModelRow[]).map(toModel)
}

export function getModel(db: DB, id: string): ModelView {
  return toModel(requireRow(db.prepare(`${MODEL_SELECT} WHERE m.id = ?`).get(id) as ModelRow | undefined, 'Model'))
}

function assertActiveCategory(db: DB, id: string): CategoryView {
  const c = db.prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id) as CategoryRow | undefined
  if (!c) throw new AppError('VALIDATION_ERROR', 'Category not found.', { categoryId: 'Category not found' })
  if (!c.isActive) throw new AppError('VALIDATION_ERROR', 'The category is deactivated.', { categoryId: 'Category is deactivated' })
  return toCategory(c)
}

function checkModelUnique(db: DB, categoryId: string, manufacturer: string, modelName: string, excludeId: string): void {
  assertUnique(
    db,
    'SELECT 1 FROM asset_models WHERE category_id = ? AND manufacturer_normalized = ? AND model_name_normalized = ? AND id <> ?',
    [categoryId, normalizeKey(manufacturer), normalizeKey(modelName), excludeId],
    'modelName',
    'This manufacturer and model already exist in the category.'
  )
}

export function createModel(db: DB, raw: CreateModelInput, ctx: OpContext): ModelView {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = createModelSchema.parse(raw)
  const id = newId()
  db.transaction(() => {
    assertActiveCategory(db, input.categoryId)
    checkModelUnique(db, input.categoryId, input.manufacturer, input.modelName, id)
    const now = nowIso()
    db.prepare(
      `INSERT INTO asset_models (id, organization_id, category_id, manufacturer, manufacturer_normalized, model_name, model_name_normalized, model_number, specifications, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, getOrganizationId(db), input.categoryId, input.manufacturer, normalizeKey(input.manufacturer), input.modelName, normalizeKey(input.modelName), input.modelNumber, input.specifications, now, now)
    audit(db, ctx, 'asset_model.created', 'asset_model', id, { manufacturer: input.manufacturer, modelName: input.modelName, categoryId: input.categoryId })
  })()
  return getModel(db, id)
}

export function updateModel(db: DB, raw: UpdateModelInput, ctx: OpContext): ModelView {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = updateModelSchema.parse(raw)
  db.transaction(() => {
    const before = getModel(db, input.id)
    if (before.categoryId !== input.categoryId) {
      if (before.assetCount > 0) throw new AppError('STATE_CONFLICT', 'The category of a model cannot change once assets use it.')
      assertActiveCategory(db, input.categoryId)
    }
    checkModelUnique(db, input.categoryId, input.manufacturer, input.modelName, input.id)
    db.prepare(
      `UPDATE asset_models SET category_id = ?, manufacturer = ?, manufacturer_normalized = ?, model_name = ?, model_name_normalized = ?, model_number = ?, specifications = ?, updated_at = ? WHERE id = ?`
    ).run(input.categoryId, input.manufacturer, normalizeKey(input.manufacturer), input.modelName, normalizeKey(input.modelName), input.modelNumber, input.specifications, nowIso(), input.id)
    // Existing assets keep their manufacturer/model snapshot; the catalogue change is not retroactive.
    audit(db, ctx, 'asset_model.updated', 'asset_model', input.id, {
      before: { manufacturer: before.manufacturer, modelName: before.modelName, modelNumber: before.modelNumber },
      after: { manufacturer: input.manufacturer, modelName: input.modelName, modelNumber: input.modelNumber }
    })
  })()
  return getModel(db, input.id)
}

export function setModelActive(db: DB, raw: SetActiveInput, ctx: OpContext): ModelView {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = catalogSetActiveSchema.parse(raw)
  db.transaction(() => {
    const m = getModel(db, input.id)
    if (m.isActive === input.isActive) return
    if (input.isActive) assertActiveCategory(db, m.categoryId)
    db.prepare('UPDATE asset_models SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'asset_model.reactivated' : 'asset_model.deactivated', 'asset_model', input.id, { manufacturer: m.manufacturer, modelName: m.modelName }, input.reason)
  })()
  return getModel(db, input.id)
}

// =============================== Suppliers ===============================

const SUPPLIER_SELECT = `
  SELECT s.id, s.code, s.name, s.contact_name AS contactName, s.email, s.phone, s.address, s.tax_reference AS taxReference, s.notes,
         s.is_active AS isActive, (SELECT count(*) FROM assets a WHERE a.supplier_id = s.id) AS assetCount
  FROM suppliers s`

type SupplierRow = Flagged<SupplierView, 'isActive'>
const toSupplier = (r: SupplierRow): SupplierView => ({ ...r, isActive: !!r.isActive })

export function listSuppliers(db: DB, raw: CatalogListInput, ctx: OpContext): SupplierView[] {
  assertAnyPermission(ctx, CATALOG_VIEW)
  const input = catalogListSchema.parse(raw)
  const { where, params } = listFilters('s', input, ['name', 'code', 'contact_name'])
  return (db.prepare(`${SUPPLIER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.name COLLATE NOCASE`).all(...params) as SupplierRow[]).map(toSupplier)
}

export function getSupplier(db: DB, id: string): SupplierView {
  return toSupplier(requireRow(db.prepare(`${SUPPLIER_SELECT} WHERE s.id = ?`).get(id) as SupplierRow | undefined, 'Supplier'))
}

function checkSupplierUnique(db: DB, orgId: string, name: string, code: string | null, excludeId: string): void {
  assertUnique(db, 'SELECT 1 FROM suppliers WHERE organization_id = ? AND name_normalized = ? AND id <> ?', [orgId, normalizeKey(name), excludeId], 'name', 'A supplier with this name already exists.')
  if (code) assertUnique(db, 'SELECT 1 FROM suppliers WHERE organization_id = ? AND code_normalized = ? AND id <> ?', [orgId, normalizeKey(code), excludeId], 'code', 'A supplier with this code already exists.')
}

export function createSupplier(db: DB, raw: CreateSupplierInput, ctx: OpContext): SupplierView {
  assertPermission(ctx.actor.permissions, 'suppliers.manage')
  const input = createSupplierSchema.parse(raw)
  const orgId = getOrganizationId(db)
  const id = newId()
  db.transaction(() => {
    checkSupplierUnique(db, orgId, input.name, input.code, id)
    const now = nowIso()
    db.prepare(
      `INSERT INTO suppliers (id, organization_id, code, code_normalized, name, name_normalized, contact_name, email, phone, address, tax_reference, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.contactName, input.email, input.phone, input.address, input.taxReference, input.notes, now, now)
    audit(db, ctx, 'supplier.created', 'supplier', id, { name: input.name, code: input.code })
  })()
  return getSupplier(db, id)
}

export function updateSupplier(db: DB, raw: UpdateSupplierInput, ctx: OpContext): SupplierView {
  assertPermission(ctx.actor.permissions, 'suppliers.manage')
  const input = updateSupplierSchema.parse(raw)
  db.transaction(() => {
    const before = getSupplier(db, input.id)
    checkSupplierUnique(db, getOrganizationId(db), input.name, input.code, input.id)
    db.prepare(
      `UPDATE suppliers SET code = ?, code_normalized = ?, name = ?, name_normalized = ?, contact_name = ?, email = ?, phone = ?, address = ?, tax_reference = ?, notes = ?, updated_at = ? WHERE id = ?`
    ).run(input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.contactName, input.email, input.phone, input.address, input.taxReference, input.notes, nowIso(), input.id)
    audit(db, ctx, 'supplier.updated', 'supplier', input.id, { before: { name: before.name, code: before.code }, after: { name: input.name, code: input.code } })
  })()
  return getSupplier(db, input.id)
}

export function setSupplierActive(db: DB, raw: SetActiveInput, ctx: OpContext): SupplierView {
  assertPermission(ctx.actor.permissions, 'suppliers.manage')
  const input = catalogSetActiveSchema.parse(raw)
  db.transaction(() => {
    const s = getSupplier(db, input.id)
    if (s.isActive === input.isActive) return
    db.prepare('UPDATE suppliers SET is_active = ?, updated_at = ? WHERE id = ?').run(input.isActive ? 1 : 0, nowIso(), input.id)
    audit(db, ctx, input.isActive ? 'supplier.reactivated' : 'supplier.deactivated', 'supplier', input.id, { name: s.name }, input.reason)
  })()
  return getSupplier(db, input.id)
}
