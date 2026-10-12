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
import type { PermissionKey } from '@shared/permissions'
import { AppError, assertAnyPermission, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { auditFrom, recordAudit } from './foundation'
import { assertUnique, likePattern, normalizeKey, normalizeOptional, Params, requireRow } from './common'

/** Reading the catalogue is needed by anyone who works with assets or procurement. */
const CATALOG_VIEW: readonly PermissionKey[] = ['assets.view', 'assets.create', 'reference_data.manage', 'procurement.view', 'suppliers.manage']

const audit = (c: SqlClient, ctx: OpContext, eventType: string, entityType: string, entityId: string, summary: Record<string, unknown>, reason?: string) =>
  recordAudit(c, { ...auditFrom(ctx), eventType, entityType, entityId, summary, reason: reason ?? null })

function listWhere(alias: string, ctx: OpContext, input: { includeInactive: boolean; search?: string | undefined }, cols: string[], p: Params): string[] {
  const where = [`${alias}.organization_id = ${p.add(ctx.actor.organizationId)}`]
  if (!input.includeInactive) where.push(`${alias}.is_active`)
  if (input.search) {
    const s = p.add(likePattern(input.search))
    where.push(`(${cols.map((c) => `${alias}.${c} ILIKE ${s} ESCAPE '\\'`).join(' OR ')})`)
  }
  return where
}

export const normalizeSerial = (s: string): string => s.trim().replace(/\s+/g, '').toUpperCase()
export const serialUniqueKey = (categoryId: string, manufacturer: string | null, serialNormalized: string): string =>
  `${categoryId}|${manufacturer ? normalizeKey(manufacturer) : ''}|${serialNormalized}`

// =============================== Categories ===============================

const CATEGORY_SELECT = `
  SELECT c.id, c.code, c.name, c.description, c.asset_domain AS "assetDomain", c.tracking_mode AS "trackingMode",
         c.serial_required AS "serialRequired", c.serial_unique AS "serialUnique", c.is_active AS "isActive",
         (SELECT count(*) FROM asset_models m WHERE m.category_id = c.id AND m.is_active) AS "activeModelCount",
         (SELECT count(*) FROM assets a WHERE a.category_id = c.id) AS "assetCount"
  FROM asset_categories c`

export async function listCategories(db: Db, raw: CatalogListInput, ctx: OpContext): Promise<CategoryView[]> {
  assertAnyPermission(ctx, CATALOG_VIEW)
  const input = catalogListSchema.parse(raw)
  const p = new Params()
  return db.many<CategoryView>(`${CATEGORY_SELECT} WHERE ${listWhere('c', ctx, input, ['name', 'code'], p).join(' AND ')} ORDER BY lower(c.name)`, p.values)
}

export async function getCategory(c: SqlClient, ctx: OpContext, id: string): Promise<CategoryView> {
  return requireRow(await c.one<CategoryView>(`${CATEGORY_SELECT} WHERE c.id = $1 AND c.organization_id = $2`, [id, ctx.actor.organizationId]), 'Category')
}

async function checkCategoryUnique(c: SqlClient, org: string, code: string, name: string, excludeId: string): Promise<void> {
  await assertUnique(c, 'SELECT 1 FROM asset_categories WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [org, normalizeKey(code), excludeId], 'code', 'A category with this code already exists.')
  await assertUnique(c, 'SELECT 1 FROM asset_categories WHERE organization_id = $1 AND name_normalized = $2 AND id <> $3', [org, normalizeKey(name), excludeId], 'name', 'A category with this name already exists.')
}

function validateSerialPolicy(input: { serialRequired: boolean; serialUnique: boolean }): void {
  if (input.serialUnique && !input.serialRequired) throw new AppError('VALIDATION_ERROR', 'Unique serial numbers require serial numbers to be mandatory.', { serialUnique: 'Turn on "serial number required" first' })
}

export async function createCategory(db: Db, raw: CreateCategoryInput, ctx: OpContext): Promise<CategoryView> {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = createCategorySchema.parse(raw)
  validateSerialPolicy(input)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await checkCategoryUnique(t, org, input.code, input.name, id)
    await t.exec(
      `INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, description, asset_domain, tracking_mode, serial_required, serial_unique)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, org, input.code, normalizeKey(input.code), input.name, normalizeKey(input.name), input.description, input.assetDomain, input.trackingMode, input.serialRequired, input.serialUnique]
    )
    await audit(t, ctx, 'asset_category.created', 'asset_category', id, { code: input.code, name: input.name, assetDomain: input.assetDomain, trackingMode: input.trackingMode, serialRequired: input.serialRequired, serialUnique: input.serialUnique })
    return getCategory(t, ctx, id)
  })
}

/** Recomputes the DB-enforced serial uniqueness keys when a category's policy changes. */
async function rebuildSerialKeys(c: SqlClient, categoryId: string, unique: boolean): Promise<void> {
  if (!unique) {
    await c.exec('UPDATE assets SET serial_unique_key = NULL WHERE category_id = $1', [categoryId])
    return
  }
  const rows = await c.many<{ id: string; code: string; manufacturer: string | null; s: string }>(
    'SELECT id, asset_code AS code, manufacturer, serial_normalized AS s FROM assets WHERE category_id = $1 AND serial_normalized IS NOT NULL',
    [categoryId]
  )
  const seen = new Map<string, string>()
  for (const r of rows) {
    const key = serialUniqueKey(categoryId, r.manufacturer, r.s)
    const clash = seen.get(key)
    if (clash) throw new AppError('STATE_CONFLICT', `Serial numbers are not unique in this category yet (for example ${clash} and ${r.code}). Correct them first.`)
    seen.set(key, r.code)
    await c.exec('UPDATE assets SET serial_unique_key = $2 WHERE id = $1', [r.id, key])
  }
}

export async function updateCategory(db: Db, raw: UpdateCategoryInput, ctx: OpContext): Promise<CategoryView> {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = updateCategorySchema.parse(raw)
  validateSerialPolicy(input)
  return db.tx(async (t) => {
    const before = await getCategory(t, ctx, input.id)
    await checkCategoryUnique(t, ctx.actor.organizationId, input.code, input.name, input.id)
    if (before.assetCount > 0) {
      if (before.trackingMode !== input.trackingMode) throw new AppError('STATE_CONFLICT', 'The tracking mode cannot change once assets exist in this category.')
      if (input.serialRequired && !before.serialRequired) {
        const missing = (await t.one<{ n: number }>('SELECT count(*) AS n FROM assets WHERE category_id = $1 AND serial_normalized IS NULL', [input.id]))!.n
        if (missing > 0) throw new AppError('STATE_CONFLICT', `${missing} asset(s) in this category have no serial number. Add them before making serials mandatory.`)
      }
    }
    if (input.serialUnique !== before.serialUnique) await rebuildSerialKeys(t, input.id, input.serialUnique)
    await t.exec(
      `UPDATE asset_categories SET code = $2, code_normalized = $3, name = $4, name_normalized = $5, description = $6, asset_domain = $7, tracking_mode = $8,
              serial_required = $9, serial_unique = $10, updated_at = now() WHERE id = $1`,
      [input.id, input.code, normalizeKey(input.code), input.name, normalizeKey(input.name), input.description, input.assetDomain, input.trackingMode, input.serialRequired, input.serialUnique]
    )
    await audit(t, ctx, 'asset_category.updated', 'asset_category', input.id, {
      before: { code: before.code, name: before.name, assetDomain: before.assetDomain, serialRequired: before.serialRequired, serialUnique: before.serialUnique },
      after: { code: input.code, name: input.name, assetDomain: input.assetDomain, serialRequired: input.serialRequired, serialUnique: input.serialUnique }
    })
    return getCategory(t, ctx, input.id)
  })
}

export async function setCategoryActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<CategoryView> {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = catalogSetActiveSchema.parse(raw)
  return db.tx(async (t) => {
    const c = await getCategory(t, ctx, input.id)
    if (c.isActive === input.isActive) return c
    if (!input.isActive && c.activeModelCount > 0) throw new AppError('STATE_CONFLICT', `Deactivate the ${c.activeModelCount} active model(s) in this category first.`)
    await t.exec('UPDATE asset_categories SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'asset_category.reactivated' : 'asset_category.deactivated', 'asset_category', input.id, { name: c.name }, input.reason)
    return getCategory(t, ctx, input.id)
  })
}

// =============================== Models ===============================

const MODEL_SELECT = `
  SELECT m.id, m.category_id AS "categoryId", c.name AS "categoryName", m.manufacturer, m.model_name AS "modelName", m.model_number AS "modelNumber",
         m.specifications, m.is_active AS "isActive", (SELECT count(*) FROM assets a WHERE a.model_id = m.id) AS "assetCount"
  FROM asset_models m JOIN asset_categories c ON c.id = m.category_id`

export async function listModels(db: Db, raw: CatalogListInput, ctx: OpContext): Promise<ModelView[]> {
  assertAnyPermission(ctx, CATALOG_VIEW)
  const input = catalogListSchema.parse(raw)
  const p = new Params()
  const where = listWhere('m', ctx, input, ['manufacturer', 'model_name', 'model_number'], p)
  if (input.categoryId) where.push(`m.category_id = ${p.add(input.categoryId)}`)
  return db.many<ModelView>(`${MODEL_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(m.manufacturer), lower(m.model_name)`, p.values)
}

async function getModel(c: SqlClient, ctx: OpContext, id: string): Promise<ModelView> {
  return requireRow(await c.one<ModelView>(`${MODEL_SELECT} WHERE m.id = $1 AND m.organization_id = $2`, [id, ctx.actor.organizationId]), 'Model')
}

async function assertActiveCategory(c: SqlClient, ctx: OpContext, id: string): Promise<void> {
  const cat = await c.one<{ a: boolean }>('SELECT is_active AS a FROM asset_categories WHERE id = $1 AND organization_id = $2', [id, ctx.actor.organizationId])
  if (!cat) throw new AppError('VALIDATION_ERROR', 'Category not found.', { categoryId: 'Category not found' })
  if (!cat.a) throw new AppError('VALIDATION_ERROR', 'The category is deactivated.', { categoryId: 'Category is deactivated' })
}

const checkModelUnique = (c: SqlClient, categoryId: string, manufacturer: string, modelName: string, excludeId: string) =>
  assertUnique(
    c,
    'SELECT 1 FROM asset_models WHERE category_id = $1 AND manufacturer_normalized = $2 AND model_name_normalized = $3 AND id <> $4',
    [categoryId, normalizeKey(manufacturer), normalizeKey(modelName), excludeId],
    'modelName',
    'This manufacturer and model already exist in the category.'
  )

export async function createModel(db: Db, raw: CreateModelInput, ctx: OpContext): Promise<ModelView> {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = createModelSchema.parse(raw)
  const id = newId()
  return db.tx(async (t) => {
    await assertActiveCategory(t, ctx, input.categoryId)
    await checkModelUnique(t, input.categoryId, input.manufacturer, input.modelName, id)
    await t.exec(
      `INSERT INTO asset_models (id, organization_id, category_id, manufacturer, manufacturer_normalized, model_name, model_name_normalized, model_number, specifications)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, ctx.actor.organizationId, input.categoryId, input.manufacturer, normalizeKey(input.manufacturer), input.modelName, normalizeKey(input.modelName), input.modelNumber, input.specifications]
    )
    await audit(t, ctx, 'asset_model.created', 'asset_model', id, { manufacturer: input.manufacturer, modelName: input.modelName, categoryId: input.categoryId })
    return getModel(t, ctx, id)
  })
}

export async function updateModel(db: Db, raw: UpdateModelInput, ctx: OpContext): Promise<ModelView> {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = updateModelSchema.parse(raw)
  return db.tx(async (t) => {
    const before = await getModel(t, ctx, input.id)
    if (before.categoryId !== input.categoryId) {
      if (before.assetCount > 0) throw new AppError('STATE_CONFLICT', 'The category of a model cannot change once assets use it.')
      await assertActiveCategory(t, ctx, input.categoryId)
    }
    await checkModelUnique(t, input.categoryId, input.manufacturer, input.modelName, input.id)
    await t.exec(
      `UPDATE asset_models SET category_id = $2, manufacturer = $3, manufacturer_normalized = $4, model_name = $5, model_name_normalized = $6, model_number = $7, specifications = $8, updated_at = now() WHERE id = $1`,
      [input.id, input.categoryId, input.manufacturer, normalizeKey(input.manufacturer), input.modelName, normalizeKey(input.modelName), input.modelNumber, input.specifications]
    )
    // Existing assets keep their manufacturer/model snapshot; catalogue edits are not retroactive.
    await audit(t, ctx, 'asset_model.updated', 'asset_model', input.id, {
      before: { manufacturer: before.manufacturer, modelName: before.modelName, modelNumber: before.modelNumber },
      after: { manufacturer: input.manufacturer, modelName: input.modelName, modelNumber: input.modelNumber }
    })
    return getModel(t, ctx, input.id)
  })
}

export async function setModelActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<ModelView> {
  assertPermission(ctx.actor.permissions, 'reference_data.manage')
  const input = catalogSetActiveSchema.parse(raw)
  return db.tx(async (t) => {
    const m = await getModel(t, ctx, input.id)
    if (m.isActive === input.isActive) return m
    if (input.isActive) await assertActiveCategory(t, ctx, m.categoryId)
    await t.exec('UPDATE asset_models SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'asset_model.reactivated' : 'asset_model.deactivated', 'asset_model', input.id, { manufacturer: m.manufacturer, modelName: m.modelName }, input.reason)
    return getModel(t, ctx, input.id)
  })
}

// =============================== Suppliers ===============================

const SUPPLIER_SELECT = `
  SELECT s.id, s.code, s.name, s.contact_name AS "contactName", s.email, s.phone, s.address, s.tax_reference AS "taxReference", s.notes,
         s.is_active AS "isActive", (SELECT count(*) FROM assets a WHERE a.supplier_id = s.id) AS "assetCount"
  FROM suppliers s`

export async function listSuppliers(db: Db, raw: CatalogListInput, ctx: OpContext): Promise<SupplierView[]> {
  assertAnyPermission(ctx, CATALOG_VIEW)
  const input = catalogListSchema.parse(raw)
  const p = new Params()
  return db.many<SupplierView>(`${SUPPLIER_SELECT} WHERE ${listWhere('s', ctx, input, ['name', 'code', 'contact_name'], p).join(' AND ')} ORDER BY lower(s.name)`, p.values)
}

async function getSupplier(c: SqlClient, ctx: OpContext, id: string): Promise<SupplierView> {
  return requireRow(await c.one<SupplierView>(`${SUPPLIER_SELECT} WHERE s.id = $1 AND s.organization_id = $2`, [id, ctx.actor.organizationId]), 'Supplier')
}

async function checkSupplierUnique(c: SqlClient, org: string, name: string, code: string | null, excludeId: string): Promise<void> {
  await assertUnique(c, 'SELECT 1 FROM suppliers WHERE organization_id = $1 AND name_normalized = $2 AND id <> $3', [org, normalizeKey(name), excludeId], 'name', 'A supplier with this name already exists.')
  if (code) await assertUnique(c, 'SELECT 1 FROM suppliers WHERE organization_id = $1 AND code_normalized = $2 AND id <> $3', [org, normalizeKey(code), excludeId], 'code', 'A supplier with this code already exists.')
}

export async function createSupplier(db: Db, raw: CreateSupplierInput, ctx: OpContext): Promise<SupplierView> {
  assertPermission(ctx.actor.permissions, 'suppliers.manage')
  const input = createSupplierSchema.parse(raw)
  const org = ctx.actor.organizationId
  const id = newId()
  return db.tx(async (t) => {
    await checkSupplierUnique(t, org, input.name, input.code, id)
    await t.exec(
      `INSERT INTO suppliers (id, organization_id, code, code_normalized, name, name_normalized, contact_name, email, phone, address, tax_reference, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, org, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.contactName, input.email, input.phone, input.address, input.taxReference, input.notes]
    )
    await audit(t, ctx, 'supplier.created', 'supplier', id, { name: input.name, code: input.code })
    return getSupplier(t, ctx, id)
  })
}

export async function updateSupplier(db: Db, raw: UpdateSupplierInput, ctx: OpContext): Promise<SupplierView> {
  assertPermission(ctx.actor.permissions, 'suppliers.manage')
  const input = updateSupplierSchema.parse(raw)
  return db.tx(async (t) => {
    const before = await getSupplier(t, ctx, input.id)
    await checkSupplierUnique(t, ctx.actor.organizationId, input.name, input.code, input.id)
    await t.exec(
      `UPDATE suppliers SET code = $2, code_normalized = $3, name = $4, name_normalized = $5, contact_name = $6, email = $7, phone = $8, address = $9, tax_reference = $10, notes = $11, updated_at = now() WHERE id = $1`,
      [input.id, input.code, normalizeOptional(input.code), input.name, normalizeKey(input.name), input.contactName, input.email, input.phone, input.address, input.taxReference, input.notes]
    )
    await audit(t, ctx, 'supplier.updated', 'supplier', input.id, { before: { name: before.name, code: before.code }, after: { name: input.name, code: input.code } })
    return getSupplier(t, ctx, input.id)
  })
}

export async function setSupplierActive(db: Db, raw: SetActiveInput, ctx: OpContext): Promise<SupplierView> {
  assertPermission(ctx.actor.permissions, 'suppliers.manage')
  const input = catalogSetActiveSchema.parse(raw)
  return db.tx(async (t) => {
    const s = await getSupplier(t, ctx, input.id)
    if (s.isActive === input.isActive) return s
    await t.exec('UPDATE suppliers SET is_active = $2, updated_at = now() WHERE id = $1', [input.id, input.isActive])
    await audit(t, ctx, input.isActive ? 'supplier.reactivated' : 'supplier.deactivated', 'supplier', input.id, { name: s.name }, input.reason)
    return getSupplier(t, ctx, input.id)
  })
}
