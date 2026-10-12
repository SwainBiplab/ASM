import type { Page } from '@shared/api'
import type { GoodsReceiptDetail, GoodsReceiptItemView, GoodsReceiptSummary, PurchaseOrderDetail, PurchaseOrderItemView, PurchaseOrderSummary } from '@shared/api'
import {
  amendOrderSchema,
  cancelOrderSchema,
  createOrderSchema,
  createReceiptSchema,
  orderListSchema,
  receiptListSchema,
  resolveDiscrepancySchema,
  type AmendOrderInput,
  type CancelOrderInput,
  type CreateOrderInput,
  type CreateReceiptInput,
  type OrderListInput,
  type ReceiptListInput,
  type ResolveDiscrepancyInput
} from '@shared/procurementSchemas'
import { parseMoneyToMinor } from '@shared/assets'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import { pgErrorCode, type Db, type SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { resolveAssetRefs, issueAssetCode } from './assets'
import { listDocumentLinks } from './documents'
import { auditFrom, recordAudit } from './foundation'
import { nextW6Number } from './procurement'

/**
 * Purchase orders and goods receipt (W6, TAS §12). Receiving is deliberately a separate
 * workflow from approval: an approved request only authorizes ordering, never implies the
 * goods have arrived (TAS §12, "do not equate purchase approval with goods receipt").
 *
 * Over-receipt and over-ordering are both prevented by locking the row that carries the
 * authorized ceiling (the request item for ordering, the PO item for receiving) for the
 * duration of the transaction: a concurrent request touching the same row waits for the first
 * to commit, so the quantity it reads already reflects the first's effect. This is the same
 * "lock, re-read, then compare" pattern `maintenance.ts` uses for `one_open_ticket_per_asset`.
 */

// ---------------------------------------------------------------- purchase orders

const ORDER_SUMMARY_COLUMNS = `o.id, o.po_number AS "poNumber", o.supplier_id AS "supplierId", s.name AS "supplierName", o.request_id AS "requestId",
  r.request_number AS "requestNumber", o.currency, o.status, o.order_date AS "orderDate", o.expected_delivery_date AS "expectedDeliveryDate", o.created_at AS "createdAt"`
const ORDER_SUMMARY_FROM = `FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN purchase_requests r ON r.id = o.request_id`

async function orderItems(c: SqlClient, poId: string): Promise<PurchaseOrderItemView[]> {
  return c.many<PurchaseOrderItemView>(
    `SELECT i.id, i.line_no AS "lineNo", i.description, i.category_id AS "categoryId", cat.name AS "categoryName", i.model_id AS "modelId",
            i.quantity, i.unit_price_minor AS "unitPriceMinor", i.line_total_minor AS "lineTotalMinor",
            COALESCE((SELECT SUM(accepted_quantity + damaged_quantity) FROM goods_receipt_items WHERE po_item_id = i.id), 0)::bigint AS "receivedQuantity",
            (i.quantity - COALESCE((SELECT SUM(accepted_quantity + damaged_quantity) FROM goods_receipt_items WHERE po_item_id = i.id), 0))::bigint AS "outstandingQuantity"
     FROM purchase_order_items i LEFT JOIN asset_categories cat ON cat.id = i.category_id WHERE i.po_id = $1 ORDER BY i.line_no`,
    [poId]
  )
}

async function orderAmendments(c: SqlClient, poId: string): Promise<PurchaseOrderDetail['amendments']> {
  return c.many(
    `SELECT a.field, a.old_value AS "oldValue", a.new_value AS "newValue", a.reason, u.display_name AS "amendedByName", a.amended_at AS "amendedAt"
     FROM purchase_order_amendments a LEFT JOIN users u ON u.id = a.amended_by WHERE a.po_id = $1 ORDER BY a.amended_at`,
    [poId]
  )
}

function orderTotal(items: { lineTotalMinor: number }[]): number {
  return items.reduce((s, i) => s + i.lineTotalMinor, 0)
}

export async function listOrders(c: SqlClient, raw: OrderListInput, ctx: OpContext): Promise<Page<PurchaseOrderSummary>> {
  assertPermission(ctx.actor.permissions, 'procurement.view')
  const input = orderListSchema.parse(raw)
  const org = ctx.actor.organizationId
  const p = new Params()
  const org$ = p.add(org)
  let where = `o.organization_id = ${org$}`
  if (input.status !== 'all') where += ` AND o.status = ${p.add(input.status)}`
  if (input.supplierId) where += ` AND o.supplier_id = ${p.add(input.supplierId)}`
  if (input.query) where += ` AND o.po_number ILIKE ${p.add(likePattern(input.query))} ESCAPE '\\'`
  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${ORDER_SUMMARY_FROM} WHERE ${where}`, p.values))!.n
  const rows = await c.many<PurchaseOrderSummary & { totalMinor: number }>(
    `SELECT ${ORDER_SUMMARY_COLUMNS}, COALESCE((SELECT SUM(line_total_minor) FROM purchase_order_items WHERE po_id = o.id), 0)::bigint AS "totalMinor"
     ${ORDER_SUMMARY_FROM} WHERE ${where} ORDER BY o.created_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  return { items: rows, total: Number(total), page: input.page, pageSize: input.pageSize }
}

export async function getOrder(c: SqlClient, storage: DocumentStorage, poId: string, ctx: OpContext, afterWrite = false): Promise<PurchaseOrderDetail> {
  if (!afterWrite) assertPermission(ctx.actor.permissions, 'procurement.view')
  const row = await c.one<PurchaseOrderSummary & { notes: string | null; cancelReason: string | null }>(
    `SELECT ${ORDER_SUMMARY_COLUMNS}, o.notes, o.cancel_reason AS "cancelReason" ${ORDER_SUMMARY_FROM} WHERE o.id = $1 AND o.organization_id = $2`,
    [poId, ctx.actor.organizationId]
  )
  const found = requireRow(row, 'Purchase order')
  const [items, amendments, documents] = await Promise.all([orderItems(c, poId), orderAmendments(c, poId), listDocumentLinks(c, storage, ctx, 'purchase_order', poId)])
  return { ...found, totalMinor: orderTotal(items), items, amendments, documents }
}

export async function createOrder(db: Db, storage: DocumentStorage, raw: CreateOrderInput, ctx: OpContext): Promise<PurchaseOrderDetail> {
  assertPermission(ctx.actor.permissions, 'procurement.manage_orders')
  const input = createOrderSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const req = await t.one<{ status: string; currency: string }>('SELECT status, currency FROM purchase_requests WHERE id = $1 AND organization_id = $2', [input.requestId, org])
    if (!req) invalid('requestId', 'Purchase request not found')
    if (req.status !== 'approved') conflict('Only an approved purchase request can become a purchase order.')
    if (input.currency !== req.currency) invalid('currency', `The approved request was costed in ${req.currency}; order the same currency, or amend the request.`)
    const supplier = await t.one<{ a: boolean }>('SELECT is_active AS a FROM suppliers WHERE id = $1 AND organization_id = $2', [input.supplierId, org])
    if (!supplier) invalid('supplierId', 'Supplier not found')
    if (!supplier.a) invalid('supplierId', 'Supplier is deactivated')
    const poId = newId()
    const number = await nextW6Number(t, org, 'po')
    await t.exec(
      `INSERT INTO purchase_orders (id, organization_id, po_number, supplier_id, request_id, currency, order_date, expected_delivery_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [poId, org, number, input.supplierId, input.requestId, input.currency, input.orderDate, input.expectedDeliveryDate, input.notes, ctx.actor.userId]
    )
    let lineNo = 1
    for (const it of input.items) {
      if (!it.requestItemId) invalid('items', 'Each order line must reference the approved request line it comes from')
      const reqItem = await t.one<{ requestId: string; quantity: number; categoryId: string | null; estimatedUnitCostMinor: number }>(
        'SELECT request_id AS "requestId", quantity, category_id AS "categoryId", estimated_unit_cost_minor AS "estimatedUnitCostMinor" FROM purchase_request_items WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [it.requestItemId, org]
      )
      if (!reqItem || reqItem.requestId !== input.requestId) invalid('items', 'Request line not found on this request')
      if (reqItem.categoryId && reqItem.categoryId !== it.categoryId) invalid('categoryId', 'Must match the category specified on the approved request line')
      const cat = await t.one<{ a: boolean }>('SELECT is_active AS a FROM asset_categories WHERE id = $1 AND organization_id = $2', [it.categoryId, org])
      if (!cat) invalid('categoryId', 'Category not found')
      const alreadyOrdered = (await t.one<{ n: string; amt: string }>(
        `SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS n, COALESCE(SUM(oi.line_total_minor), 0)::bigint AS amt
         FROM purchase_order_items oi JOIN purchase_orders po ON po.id = oi.po_id
         WHERE oi.request_item_id = $1 AND po.status <> 'cancelled'`,
        [it.requestItemId]
      ))!
      if (Number(alreadyOrdered.n) + it.quantity > reqItem.quantity) {
        conflict(`Ordering ${it.quantity} would exceed the ${reqItem.quantity} authorized on the approved request (already ordered: ${alreadyOrdered.n}). A documented amendment and re-approval is required to order more.`)
      }
      const unitPriceMinor = parseMoneyToMinor(it.unitPrice, input.currency)
      if (unitPriceMinor === null) invalid('unitPrice', `Enter an amount valid for ${input.currency}`)
      const lineTotalMinor = it.quantity * unitPriceMinor!
      if (!Number.isSafeInteger(lineTotalMinor)) invalid('quantity', 'Quantity and price combine to an amount too large to record')
      const authorizedAmount = reqItem.quantity * reqItem.estimatedUnitCostMinor
      if (Number(alreadyOrdered.amt) + lineTotalMinor > authorizedAmount) {
        conflict(`Ordering at this price would exceed the approved amount for this line. A documented amendment and re-approval is required to order above the approved estimate.`)
      }
      await t.exec(
        `INSERT INTO purchase_order_items (id, organization_id, po_id, request_item_id, line_no, description, category_id, model_id, quantity, unit_price_minor, line_total_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [newId(), org, poId, it.requestItemId, lineNo++, it.description, it.categoryId, it.modelId, it.quantity, unitPriceMinor, lineTotalMinor]
      )
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'procurement.order_created', entityType: 'purchase_order', entityId: poId, summary: { requestId: input.requestId, supplierId: input.supplierId, itemCount: input.items.length } })
    return getOrder(t, storage, poId, ctx, true)
  })
}

export async function amendOrder(db: Db, storage: DocumentStorage, raw: AmendOrderInput, ctx: OpContext): Promise<PurchaseOrderDetail> {
  assertPermission(ctx.actor.permissions, 'procurement.manage_orders')
  const input = amendOrderSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const po = await t.one<{ status: string; expectedDeliveryDate: string | null; notes: string | null }>(
      'SELECT status, expected_delivery_date AS "expectedDeliveryDate", notes FROM purchase_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.poId, org]
    )
    const found = requireRow(po, 'Purchase order')
    if (found.status === 'cancelled') conflict('A cancelled purchase order cannot be amended.')
    if (input.expectedDeliveryDate !== found.expectedDeliveryDate) {
      await t.exec('INSERT INTO purchase_order_amendments (id, organization_id, po_id, field, old_value, new_value, reason, amended_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        newId(), org, input.poId, 'expectedDeliveryDate', found.expectedDeliveryDate, input.expectedDeliveryDate, input.reason, ctx.actor.userId
      ])
    }
    if (input.notes !== found.notes) {
      await t.exec('INSERT INTO purchase_order_amendments (id, organization_id, po_id, field, old_value, new_value, reason, amended_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        newId(), org, input.poId, 'notes', found.notes, input.notes, input.reason, ctx.actor.userId
      ])
    }
    await t.exec('UPDATE purchase_orders SET expected_delivery_date = $2, notes = $3, updated_at = now() WHERE id = $1', [input.poId, input.expectedDeliveryDate, input.notes])
    for (const change of input.items) {
      const item = await t.one<{ quantity: number; unitPriceMinor: number; requestItemId: string | null }>(
        `SELECT i.quantity, i.unit_price_minor AS "unitPriceMinor", i.request_item_id AS "requestItemId"
         FROM purchase_order_items i WHERE i.id = $1 AND i.po_id = $2 AND i.organization_id = $3 FOR UPDATE`,
        [change.poItemId, input.poId, org]
      )
      const foundItem = requireRow(item, 'Purchase order line')
      // Locked separately: a plain FOR UPDATE cannot apply across a LEFT JOIN's nullable side, and
      // this row carries the authorization ceiling, so it must be locked before re-reading it (D44).
      const reqRow = foundItem.requestItemId
        ? await t.one<{ quantity: number; estimatedUnitCostMinor: number }>(
            'SELECT quantity, estimated_unit_cost_minor AS "estimatedUnitCostMinor" FROM purchase_request_items WHERE id = $1 AND organization_id = $2 FOR UPDATE',
            [foundItem.requestItemId, org]
          )
        : null
      const requestQuantity = reqRow?.quantity ?? 0
      const estimatedUnitCostMinor = reqRow?.estimatedUnitCostMinor ?? 0
      const receivedSoFar = (await t.one<{ n: number }>('SELECT COALESCE(SUM(accepted_quantity + damaged_quantity), 0)::bigint AS n FROM goods_receipt_items WHERE po_item_id = $1', [change.poItemId]))!.n
      if (change.quantity < receivedSoFar) invalid('quantity', `Cannot amend below the ${receivedSoFar} units already received on this line`)
      const unitPriceMinor = parseMoneyToMinor(change.unitPrice, (await t.one<{ c: string }>('SELECT currency AS c FROM purchase_orders WHERE id = $1', [input.poId]))!.c)
      if (unitPriceMinor === null) invalid('unitPrice', 'Invalid amount')
      if (foundItem.requestItemId) {
        const alreadyOrderedElsewhere = (await t.one<{ n: number; amt: number }>(
          `SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS n, COALESCE(SUM(oi.line_total_minor), 0)::bigint AS amt
           FROM purchase_order_items oi JOIN purchase_orders po ON po.id = oi.po_id
           WHERE oi.request_item_id = $1 AND po.status <> 'cancelled' AND oi.id <> $2`,
          [foundItem.requestItemId, change.poItemId]
        ))!
        if (alreadyOrderedElsewhere.n + change.quantity > requestQuantity) {
          conflict(`Amending to ${change.quantity} would exceed the ${requestQuantity} authorized on the approved request.`)
        }
        const authorizedAmount = requestQuantity * estimatedUnitCostMinor
        const newLineTotal = change.quantity * unitPriceMinor
        if (alreadyOrderedElsewhere.amt + newLineTotal > authorizedAmount) {
          conflict('Amending to this price and quantity would exceed the approved amount for this line. A documented re-approval is required to go above the approved estimate.')
        }
      }
      if (change.quantity !== foundItem.quantity) {
        await t.exec('INSERT INTO purchase_order_amendments (id, organization_id, po_id, po_item_id, field, old_value, new_value, reason, amended_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          newId(), org, input.poId, change.poItemId, 'quantity', String(foundItem.quantity), String(change.quantity), input.reason, ctx.actor.userId
        ])
      }
      if (unitPriceMinor !== foundItem.unitPriceMinor) {
        await t.exec('INSERT INTO purchase_order_amendments (id, organization_id, po_id, po_item_id, field, old_value, new_value, reason, amended_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          newId(), org, input.poId, change.poItemId, 'unitPrice', String(foundItem.unitPriceMinor), String(unitPriceMinor), input.reason, ctx.actor.userId
        ])
      }
      const lineTotalMinor = change.quantity * unitPriceMinor
      if (!Number.isSafeInteger(lineTotalMinor)) invalid('quantity', 'Amount too large to record')
      await t.exec('UPDATE purchase_order_items SET quantity = $2, unit_price_minor = $3, line_total_minor = $4, updated_at = now() WHERE id = $1', [change.poItemId, change.quantity, unitPriceMinor, lineTotalMinor])
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'procurement.order_amended', entityType: 'purchase_order', entityId: input.poId, reason: input.reason, summary: { itemsChanged: input.items.length } })
    return getOrder(t, storage, input.poId, ctx, true)
  })
}

export async function cancelOrder(db: Db, storage: DocumentStorage, raw: CancelOrderInput, ctx: OpContext): Promise<PurchaseOrderDetail> {
  assertPermission(ctx.actor.permissions, 'procurement.manage_orders')
  const input = cancelOrderSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const po = await t.one<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.poId, org])
    const found = requireRow(po, 'Purchase order')
    if (found.status !== 'open') conflict('Only an order with no recorded receipts can be cancelled.')
    await t.exec('UPDATE purchase_orders SET status = \'cancelled\', cancel_reason = $2, updated_at = now() WHERE id = $1', [input.poId, input.reason])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'procurement.order_cancelled', entityType: 'purchase_order', entityId: input.poId, reason: input.reason })
    return getOrder(t, storage, input.poId, ctx, true)
  })
}

// ---------------------------------------------------------------- goods receipt

async function receiptItems(c: SqlClient, receiptId: string): Promise<GoodsReceiptItemView[]> {
  const rows = await c.many<Omit<GoodsReceiptItemView, 'units'> & { id: string }>(
    `SELECT ri.id, ri.po_item_id AS "poItemId", poi.description, ri.received_quantity AS "receivedQuantity", ri.accepted_quantity AS "acceptedQuantity",
            ri.damaged_quantity AS "damagedQuantity", ri.rejected_quantity AS "rejectedQuantity", ri.discrepancy_status AS "discrepancyStatus",
            ri.discrepancy_notes AS "discrepancyNotes", ri.resolution_notes AS "resolutionNotes"
     FROM goods_receipt_items ri JOIN purchase_order_items poi ON poi.id = ri.po_item_id WHERE ri.receipt_id = $1`,
    [receiptId]
  )
  const out: GoodsReceiptItemView[] = []
  for (const r of rows) {
    const units = await c.many<GoodsReceiptItemView['units'][number]>(
      `SELECT u.unit_no AS "unitNo", u.serial_number AS "serialNumber", u.disposition, u.asset_id AS "assetId", a.asset_code AS "assetCode"
       FROM goods_receipt_units u LEFT JOIN assets a ON a.id = u.asset_id WHERE u.receipt_item_id = $1 ORDER BY u.unit_no`,
      [r.id]
    )
    out.push({ ...r, units })
  }
  return out
}

const RECEIPT_SUMMARY_COLUMNS = `gr.id, gr.receipt_number AS "receiptNumber", gr.po_id AS "poId", po.po_number AS "poNumber",
  u.display_name AS "receivedByName", gr.received_at AS "receivedAt", gr.supplier_reference AS "supplierReference",
  (SELECT COUNT(*) FROM goods_receipt_items WHERE receipt_id = gr.id)::int AS "itemCount"`
const RECEIPT_SUMMARY_FROM = `FROM goods_receipts gr JOIN purchase_orders po ON po.id = gr.po_id LEFT JOIN users u ON u.id = gr.received_by`

export async function listReceipts(c: SqlClient, raw: ReceiptListInput, ctx: OpContext): Promise<Page<GoodsReceiptSummary>> {
  assertPermission(ctx.actor.permissions, 'procurement.view')
  const input = receiptListSchema.parse(raw)
  const org = ctx.actor.organizationId
  const p = new Params()
  const org$ = p.add(org)
  let where = `gr.organization_id = ${org$}`
  if (input.poId) where += ` AND gr.po_id = ${p.add(input.poId)}`
  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${RECEIPT_SUMMARY_FROM} WHERE ${where}`, p.values))!.n
  const rows = await c.many<GoodsReceiptSummary>(
    `SELECT ${RECEIPT_SUMMARY_COLUMNS} ${RECEIPT_SUMMARY_FROM} WHERE ${where} ORDER BY gr.received_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  return { items: rows, total: Number(total), page: input.page, pageSize: input.pageSize }
}

export async function getReceipt(c: SqlClient, storage: DocumentStorage, receiptId: string, ctx: OpContext, afterWrite = false): Promise<GoodsReceiptDetail> {
  if (!afterWrite) assertPermission(ctx.actor.permissions, 'procurement.view')
  const row = await c.one<GoodsReceiptSummary & { notes: string | null }>(`SELECT ${RECEIPT_SUMMARY_COLUMNS}, gr.notes ${RECEIPT_SUMMARY_FROM} WHERE gr.id = $1 AND gr.organization_id = $2`, [receiptId, ctx.actor.organizationId])
  const found = requireRow(row, 'Goods receipt')
  const [items, documents] = await Promise.all([receiptItems(c, receiptId), listDocumentLinks(c, storage, ctx, 'goods_receipt', receiptId)])
  return { ...found, items, documents }
}

async function updateOrderStatus(t: SqlClient, poId: string): Promise<void> {
  const row = await t.one<{ outstanding: number; everReceived: boolean }>(
    `SELECT COALESCE(SUM(i.quantity - COALESCE(r.accepted, 0) - COALESCE(r.damaged, 0)), 0)::bigint AS outstanding,
            COALESCE(SUM(COALESCE(r.accepted, 0) + COALESCE(r.damaged, 0)), 0) > 0 AS "everReceived"
     FROM purchase_order_items i LEFT JOIN (
       SELECT po_item_id, SUM(accepted_quantity) AS accepted, SUM(damaged_quantity) AS damaged FROM goods_receipt_items GROUP BY po_item_id
     ) r ON r.po_item_id = i.id WHERE i.po_id = $1`,
    [poId]
  )
  const status = row!.outstanding <= 0 ? 'received' : row!.everReceived ? 'partially_received' : 'open'
  await t.exec('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1 AND status <> \'cancelled\'', [poId, status])
}

export async function createReceipt(db: Db, storage: DocumentStorage, raw: CreateReceiptInput, ctx: OpContext): Promise<GoodsReceiptDetail> {
  assertPermission(ctx.actor.permissions, 'receipts.record')
  const input = createReceiptSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const po = await t.one<{ status: string; supplierId: string; poNumber: string; currency: string }>(
      'SELECT status, supplier_id AS "supplierId", po_number AS "poNumber", currency FROM purchase_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.poId, org]
    )
    const foundPo = requireRow(po, 'Purchase order')
    if (foundPo.status === 'cancelled') conflict('A cancelled purchase order cannot receive goods.')
    const receiptId = newId()
    const number = await nextW6Number(t, org, 'receipt')
    await t.exec('INSERT INTO goods_receipts (id, organization_id, receipt_number, po_id, received_by, supplier_reference, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      receiptId, org, number, input.poId, ctx.actor.userId, input.supplierReference, input.notes
    ])
    let createdAssets = 0
    let bulkMovements = 0
    for (const line of input.items) {
      // Locking the PO item serializes any concurrent receipt against this exact line, so the
      // outstanding quantity read here already reflects every receipt committed before this one.
      const poItem = await t.one<{ quantity: number; categoryId: string; modelId: string | null; unitPriceMinor: number; description: string; trackingMode: string }>(
        `SELECT i.quantity, i.category_id AS "categoryId", i.model_id AS "modelId", i.unit_price_minor AS "unitPriceMinor", i.description, c.tracking_mode AS "trackingMode"
         FROM purchase_order_items i JOIN asset_categories c ON c.id = i.category_id WHERE i.id = $1 AND i.po_id = $2 AND i.organization_id = $3 FOR UPDATE OF i`,
        [line.poItemId, input.poId, org]
      )
      const foundItem = requireRow(poItem, 'Purchase order line')
      const acceptedSoFar = (await t.one<{ n: number }>('SELECT COALESCE(SUM(accepted_quantity + damaged_quantity), 0)::bigint AS n FROM goods_receipt_items WHERE po_item_id = $1', [line.poItemId]))!.n
      const outstanding = foundItem.quantity - acceptedSoFar

      let accepted: number, damaged: number, rejected: number
      if (foundItem.trackingMode === 'individual') {
        if (!line.units) invalid('items', 'Individually tracked lines require a per-unit entry for each item received')
        accepted = line.units.filter((u) => u.disposition === 'accepted').length
        damaged = line.units.filter((u) => u.disposition === 'damaged').length
        rejected = line.units.filter((u) => u.disposition === 'rejected').length
      } else {
        if (line.units) invalid('items', 'Bulk-tracked lines use quantities, not per-unit entries')
        accepted = line.bulkAcceptedQuantity ?? 0
        damaged = line.bulkDamagedQuantity ?? 0
        rejected = line.bulkRejectedQuantity ?? 0
        if (accepted + damaged + rejected === 0) invalid('items', 'Enter at least one received quantity')
      }
      if (accepted + damaged > outstanding) {
        conflict(`Accepting ${accepted + damaged} would exceed the ${outstanding} units still outstanding on "${foundItem.description}".`)
      }
      const receivedQuantity = accepted + damaged + rejected
      const discrepancyStatus = damaged > 0 || rejected > 0 ? 'open' : 'none'
      const receiptItemId = newId()
      await t.exec(
        `INSERT INTO goods_receipt_items (id, organization_id, receipt_id, po_item_id, received_quantity, accepted_quantity, damaged_quantity, rejected_quantity, discrepancy_status, discrepancy_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [receiptItemId, org, receiptId, line.poItemId, receivedQuantity, accepted, damaged, rejected, discrepancyStatus, line.discrepancyNotes]
      )

      if (foundItem.trackingMode === 'individual') {
        let unitNo = 1
        for (const unit of line.units!) {
          let assetId: string | null = null
          if (unit.disposition !== 'rejected') {
            if (!line.locationId) invalid('items', 'Choose a location for received items')
            const r = await resolveAssetRefs(t, ctx, {
              categoryId: foundItem.categoryId, modelId: foundItem.modelId, manufacturer: null, modelName: null,
              serialNumber: unit.serialNumber, locationId: line.locationId, supplierId: foundPo.supplierId, warrantyStart: null, warrantyEnd: null
            }, null)
            assetId = newId()
            const code = await issueAssetCode(t, org)
            const operationalStatus = unit.disposition === 'accepted' ? 'ready' : 'non_operational'
            const condition = unit.disposition === 'accepted' ? 'new' : 'damaged'
            await t.exec(
              `INSERT INTO assets (id, organization_id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, serial_unique_key,
                                   operational_status, condition, location_id, supplier_id, purchase_date, acquisition_cost_minor, currency, purchase_reference)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, current_date, $15, $16, $17)`,
              [assetId, org, code, foundItem.categoryId, r.modelId, r.manufacturer, r.modelName, unit.serialNumber, r.serialNormalized, r.serialUniqueKey,
                operationalStatus, condition, line.locationId, foundPo.supplierId, foundItem.unitPriceMinor, foundPo.currency, foundPo.poNumber]
            )
            createdAssets++
            await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset.created', entityType: 'asset', entityId: assetId, summary: { assetCode: code, viaReceipt: number, disposition: unit.disposition } })
          }
          await t.exec('INSERT INTO goods_receipt_units (id, organization_id, receipt_item_id, unit_no, serial_number, disposition, asset_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
            newId(), org, receiptItemId, unitNo++, unit.serialNumber, unit.disposition, assetId
          ])
        }
      } else if (accepted > 0) {
        if (!line.locationId) invalid('items', 'Choose a location for received stock')
        try {
          await t.exec('INSERT INTO stock_movements (id, organization_id, category_id, location_id, movement_type, quantity, receipt_item_id, actor_user_id) VALUES ($1, $2, $3, $4, \'received\', $5, $6, $7)', [
            newId(), org, foundItem.categoryId, line.locationId, accepted, receiptItemId, ctx.actor.userId
          ])
        } catch (err) {
          if (pgErrorCode(err) !== '23505') throw err
        }
        await t.exec(
          `INSERT INTO bulk_stock_balances (organization_id, category_id, location_id, quantity_on_hand) VALUES ($1, $2, $3, $4)
           ON CONFLICT (organization_id, category_id, location_id) DO UPDATE SET quantity_on_hand = bulk_stock_balances.quantity_on_hand + $4, updated_at = now()`,
          [org, foundItem.categoryId, line.locationId, accepted]
        )
        bulkMovements++
      }
    }
    await updateOrderStatus(t, input.poId)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'receipts.recorded', entityType: 'goods_receipt', entityId: receiptId, summary: { poId: input.poId, lineCount: input.items.length, createdAssets, bulkMovements } })
    return getReceipt(t, storage, receiptId, ctx, true)
  })
}

export async function resolveReceiptDiscrepancy(db: Db, storage: DocumentStorage, raw: ResolveDiscrepancyInput, ctx: OpContext): Promise<GoodsReceiptDetail> {
  assertPermission(ctx.actor.permissions, 'receipts.record')
  const input = resolveDiscrepancySchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const row = await t.one<{ receiptId: string; status: string }>(
      'SELECT receipt_id AS "receiptId", discrepancy_status AS status FROM goods_receipt_items WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.receiptItemId, org]
    )
    const found = requireRow(row, 'Receipt line')
    if (found.status !== 'open') conflict('This line has no open discrepancy to resolve.')
    await t.exec('UPDATE goods_receipt_items SET discrepancy_status = \'resolved\', resolution_notes = $2, resolved_by = $3, resolved_at = now() WHERE id = $1', [
      input.receiptItemId, input.resolutionNotes, ctx.actor.userId
    ])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'receipts.discrepancy_resolved', entityType: 'goods_receipt', entityId: found.receiptId, summary: { receiptItemId: input.receiptItemId } })
    return getReceipt(t, storage, found.receiptId, ctx, true)
  })
}
