import type { CurrencyTotal } from '@shared/reports'
import type { OrderStatus, RequestStatus } from '@shared/procurement'
import type {
  AssetValuationReport,
  AssetValuationRow,
  DisposalReport,
  DisposalRow,
  MaintenanceCostReport,
  MaintenanceCostRow,
  ProcurementSummaryReport,
  WarrantyReport,
  WarrantyRow
} from '@shared/api'
import {
  assetValuationReportSchema,
  disposalReportSchema,
  maintenanceCostReportSchema,
  procurementSummaryReportSchema,
  warrantyReportSchema,
  type AssetValuationReportInput,
  type DisposalReportInput,
  type MaintenanceCostReportInput,
  type ProcurementSummaryReportInput,
  type WarrantyReportInput
} from '@shared/reportsSchemas'
import { assertPermission, type OpContext } from '../core'
import type { SqlClient } from '../db/sql'
import { addDays, todayUtc } from './assets'
import { likePattern, Params } from './common'
import { getSettings } from './foundation'

/**
 * Financial and management reports (W7, TAS §14/§17). Every monetary total is grouped by
 * currency and never summed across currencies without an approved exchange-rate policy — there
 * is no such policy, so cross-currency totals are never computed anywhere in this file.
 * Depreciation is intentionally absent: F1 (depreciation policy) remains unresolved (DECISIONS.md).
 */

const canViewCost = (ctx: OpContext): boolean => ctx.actor.permissions.has('finance.view_cost')

// ---------------------------------------------------------------- asset acquisition and valuation

const VALUATION_COLUMNS = `a.id, a.asset_code AS "assetCode", cat.name AS "categoryName", a.manufacturer, a.model_name AS "modelName",
  l.name AS "locationName", d.name AS "departmentName", a.lifecycle_status AS "lifecycleStatus", a.operational_status AS "operationalStatus",
  a.purchase_date AS "purchaseDate", a.acquisition_cost_minor AS "acquisitionCostMinor", a.currency, s.name AS "supplierName",
  a.invoice_reference AS "invoiceReference", a.purchase_reference AS "purchaseReference",
  (a.acquisition_cost_minor IS NULL OR a.purchase_date IS NULL) AS "missingFinancialMetadata"`
/** Current custodian's department, when the asset is actively assigned to an employee or a department directly (TAS §17: best available dimension — workstation/team/pool custody has no single resolvable department). */
const VALUATION_FROM = `FROM assets a
  JOIN asset_categories cat ON cat.id = a.category_id
  LEFT JOIN locations l ON l.id = a.location_id
  LEFT JOIN suppliers s ON s.id = a.supplier_id
  LEFT JOIN asset_assignments asg ON asg.asset_id = a.id AND asg.status = 'active'
  LEFT JOIN employees emp ON emp.id = asg.employee_id
  LEFT JOIN departments d ON d.id = COALESCE(asg.department_id, emp.department_id)`

export async function assetValuationReport(c: SqlClient, raw: AssetValuationReportInput, ctx: OpContext): Promise<AssetValuationReport> {
  assertPermission(ctx.actor.permissions, 'reports.view')
  const input = assetValuationReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p = new Params()
  let where = `a.organization_id = ${p.add(org)}`
  if (input.lifecycle !== 'all') where += ` AND a.lifecycle_status = ${p.add(input.lifecycle)}`
  if (input.categoryId) where += ` AND a.category_id = ${p.add(input.categoryId)}`
  if (input.locationId) where += ` AND a.location_id = ${p.add(input.locationId)}`
  if (input.departmentId) where += ` AND COALESCE(asg.department_id, emp.department_id) = ${p.add(input.departmentId)}`
  if (input.supplierId) where += ` AND a.supplier_id = ${p.add(input.supplierId)}`
  if (input.fromDate) where += ` AND a.purchase_date >= ${p.add(input.fromDate)}`
  if (input.toDate) where += ` AND a.purchase_date <= ${p.add(input.toDate)}`
  if (input.onlyMissingFinancialMetadata) where += ` AND (a.acquisition_cost_minor IS NULL OR a.purchase_date IS NULL)`

  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${VALUATION_FROM} WHERE ${where}`, p.values))!.n
  const totalsByCurrency = costVisible
    ? await c.many<{ currency: string; totalMinor: number; count: number }>(
        `SELECT a.currency, COALESCE(SUM(a.acquisition_cost_minor), 0)::bigint AS "totalMinor", COUNT(*)::int AS count
         ${VALUATION_FROM} WHERE ${where} AND a.acquisition_cost_minor IS NOT NULL GROUP BY a.currency ORDER BY a.currency`,
        p.values
      )
    : []
  const rows = await c.many<AssetValuationRow>(
    `SELECT ${VALUATION_COLUMNS} ${VALUATION_FROM} WHERE ${where} ORDER BY a.purchase_date DESC NULLS LAST, a.asset_code
     LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  const items = rows.map((r) => (costVisible ? r : { ...r, acquisitionCostMinor: null }))
  return { items, total: Number(total), page: input.page, pageSize: input.pageSize, totalsByCurrency, costVisible }
}

export async function exportAssetValuationRows(c: SqlClient, raw: AssetValuationReportInput, ctx: OpContext): Promise<{ headers: string[]; rows: Array<Array<string | number | null>>; includesCost: boolean }> {
  assertPermission(ctx.actor.permissions, 'reports.export')
  const input = assetValuationReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p = new Params()
  let where = `a.organization_id = ${p.add(org)}`
  if (input.lifecycle !== 'all') where += ` AND a.lifecycle_status = ${p.add(input.lifecycle)}`
  if (input.categoryId) where += ` AND a.category_id = ${p.add(input.categoryId)}`
  if (input.locationId) where += ` AND a.location_id = ${p.add(input.locationId)}`
  if (input.departmentId) where += ` AND COALESCE(asg.department_id, emp.department_id) = ${p.add(input.departmentId)}`
  if (input.supplierId) where += ` AND a.supplier_id = ${p.add(input.supplierId)}`
  if (input.fromDate) where += ` AND a.purchase_date >= ${p.add(input.fromDate)}`
  if (input.toDate) where += ` AND a.purchase_date <= ${p.add(input.toDate)}`
  if (input.onlyMissingFinancialMetadata) where += ` AND (a.acquisition_cost_minor IS NULL OR a.purchase_date IS NULL)`
  const rows = await c.many<AssetValuationRow>(`SELECT ${VALUATION_COLUMNS} ${VALUATION_FROM} WHERE ${where} ORDER BY a.purchase_date DESC NULLS LAST, a.asset_code LIMIT 20000`, p.values)
  const headers = ['Asset code', 'Category', 'Manufacturer', 'Model', 'Location', 'Department', 'Lifecycle', 'Operational status', 'Purchase date', 'Acquisition cost (minor)', 'Currency', 'Supplier', 'Invoice reference', 'PO reference', 'Missing financial metadata']
  return {
    headers,
    rows: rows.map((r) => [
      r.assetCode, r.categoryName, r.manufacturer, r.modelName, r.locationName, r.departmentName, r.lifecycleStatus, r.operationalStatus,
      r.purchaseDate, costVisible ? r.acquisitionCostMinor : null, r.currency, r.supplierName, r.invoiceReference, r.purchaseReference,
      r.missingFinancialMetadata ? 'yes' : 'no'
    ]),
    includesCost: costVisible
  }
}

// ---------------------------------------------------------------- maintenance expenditure

const MAINT_COLUMNS = `t.id, t.ticket_number AS "ticketNumber", t.asset_id AS "assetId", a.asset_code AS "assetCode", cat.name AS "categoryName",
  l.name AS "locationName", t.vendor_name AS "vendorName", t.status, t.reported_at AS "reportedAt", t.closed_at AS "closedAt",
  t.parts_cost_minor AS "partsCostMinor", t.labor_cost_minor AS "laborCostMinor", t.currency, t.downtime_minutes AS "downtimeMinutes"`
const MAINT_FROM = `FROM maintenance_tickets t JOIN assets a ON a.id = t.asset_id JOIN asset_categories cat ON cat.id = a.category_id LEFT JOIN locations l ON l.id = a.location_id`

export async function maintenanceCostReport(c: SqlClient, raw: MaintenanceCostReportInput, ctx: OpContext): Promise<MaintenanceCostReport> {
  assertPermission(ctx.actor.permissions, 'reports.view')
  const input = maintenanceCostReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p = new Params()
  let where = `t.organization_id = ${p.add(org)}`
  if (input.assetId) where += ` AND t.asset_id = ${p.add(input.assetId)}`
  if (input.categoryId) where += ` AND a.category_id = ${p.add(input.categoryId)}`
  if (input.locationId) where += ` AND a.location_id = ${p.add(input.locationId)}`
  if (input.vendorQuery) where += ` AND t.vendor_name ILIKE ${p.add(likePattern(input.vendorQuery))} ESCAPE '\\'`
  if (input.fromDate) where += ` AND t.reported_at >= ${p.add(input.fromDate)}`
  if (input.toDate) where += ` AND t.reported_at <= ${p.add(input.toDate)}::date + interval '1 day'`

  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${MAINT_FROM} WHERE ${where}`, p.values))!.n
  const totalsByCurrency = costVisible
    ? await c.many<{ currency: string; totalMinor: number; count: number }>(
        `SELECT t.currency, COALESCE(SUM(COALESCE(t.parts_cost_minor, 0) + COALESCE(t.labor_cost_minor, 0)), 0)::bigint AS "totalMinor", COUNT(*)::int AS count
         ${MAINT_FROM} WHERE ${where} AND t.currency IS NOT NULL GROUP BY t.currency ORDER BY t.currency`,
        p.values
      )
    : []
  const topAssets = costVisible
    ? await c.many<{ assetId: string; assetCode: string; currency: string; ticketCount: number; totalCostMinor: number }>(
        `SELECT t.asset_id AS "assetId", a.asset_code AS "assetCode", t.currency, COUNT(*)::int AS "ticketCount",
                COALESCE(SUM(COALESCE(t.parts_cost_minor, 0) + COALESCE(t.labor_cost_minor, 0)), 0)::bigint AS "totalCostMinor"
         ${MAINT_FROM} WHERE ${where} AND t.currency IS NOT NULL GROUP BY t.asset_id, a.asset_code, t.currency
         ORDER BY "totalCostMinor" DESC, "ticketCount" DESC LIMIT 10`,
        p.values
      )
    : []
  const rows = await c.many<MaintenanceCostRow>(
    `SELECT ${MAINT_COLUMNS} ${MAINT_FROM} WHERE ${where} ORDER BY t.reported_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  const items = rows.map((r) => (costVisible ? r : { ...r, partsCostMinor: null, laborCostMinor: null }))
  return { items, total: Number(total), page: input.page, pageSize: input.pageSize, totalsByCurrency, topAssets, costVisible }
}

export async function exportMaintenanceCostRows(c: SqlClient, raw: MaintenanceCostReportInput, ctx: OpContext): Promise<{ headers: string[]; rows: Array<Array<string | number | null>>; includesCost: boolean }> {
  assertPermission(ctx.actor.permissions, 'reports.export')
  const input = maintenanceCostReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p = new Params()
  let where = `t.organization_id = ${p.add(org)}`
  if (input.assetId) where += ` AND t.asset_id = ${p.add(input.assetId)}`
  if (input.categoryId) where += ` AND a.category_id = ${p.add(input.categoryId)}`
  if (input.locationId) where += ` AND a.location_id = ${p.add(input.locationId)}`
  if (input.vendorQuery) where += ` AND t.vendor_name ILIKE ${p.add(likePattern(input.vendorQuery))} ESCAPE '\\'`
  if (input.fromDate) where += ` AND t.reported_at >= ${p.add(input.fromDate)}`
  if (input.toDate) where += ` AND t.reported_at <= ${p.add(input.toDate)}::date + interval '1 day'`
  const rows = await c.many<MaintenanceCostRow>(`SELECT ${MAINT_COLUMNS} ${MAINT_FROM} WHERE ${where} ORDER BY t.reported_at DESC LIMIT 20000`, p.values)
  const headers = ['Ticket', 'Asset code', 'Category', 'Location', 'Vendor', 'Status', 'Reported at', 'Closed at', 'Parts cost (minor)', 'Labor cost (minor)', 'Currency', 'Downtime (minutes)']
  return {
    headers,
    rows: rows.map((r) => [r.ticketNumber, r.assetCode, r.categoryName, r.locationName, r.vendorName, r.status, r.reportedAt, r.closedAt, costVisible ? r.partsCostMinor : null, costVisible ? r.laborCostMinor : null, r.currency, r.downtimeMinutes]),
    includesCost: costVisible
  }
}

// ---------------------------------------------------------------- procurement and receiving

export async function procurementSummaryReport(c: SqlClient, raw: ProcurementSummaryReportInput, ctx: OpContext): Promise<ProcurementSummaryReport> {
  assertPermission(ctx.actor.permissions, 'reports.view')
  const input = procurementSummaryReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p1 = new Params()
  let reqWhere = `r.organization_id = ${p1.add(org)}`
  if (input.fromDate) reqWhere += ` AND r.created_at >= ${p1.add(input.fromDate)}`
  if (input.toDate) reqWhere += ` AND r.created_at <= ${p1.add(input.toDate)}::date + interval '1 day'`
  const requestTotals = costVisible
    ? await c.many<{ status: RequestStatus; currency: string; totalMinor: number; count: number }>(
        `SELECT r.status, r.currency, COALESCE(SUM(sub.lt), 0)::bigint AS "totalMinor", COUNT(*)::int AS count
         FROM purchase_requests r
         LEFT JOIN (SELECT request_id, SUM(line_total_minor) AS lt FROM purchase_request_items GROUP BY request_id) sub ON sub.request_id = r.id
         WHERE ${reqWhere} GROUP BY r.status, r.currency ORDER BY r.status, r.currency`,
        p1.values
      )
    : []

  const p2 = new Params()
  let orderWhere = `o.organization_id = ${p2.add(org)}`
  if (input.fromDate) orderWhere += ` AND o.created_at >= ${p2.add(input.fromDate)}`
  if (input.toDate) orderWhere += ` AND o.created_at <= ${p2.add(input.toDate)}::date + interval '1 day'`
  const orderTotals = costVisible
    ? await c.many<{ status: OrderStatus; currency: string; totalMinor: number; count: number }>(
        `SELECT o.status, o.currency, COALESCE(SUM(sub.lt), 0)::bigint AS "totalMinor", COUNT(*)::int AS count
         FROM purchase_orders o
         LEFT JOIN (SELECT po_id, SUM(line_total_minor) AS lt FROM purchase_order_items GROUP BY po_id) sub ON sub.po_id = o.id
         WHERE ${orderWhere} GROUP BY o.status, o.currency ORDER BY o.status, o.currency`,
        p2.values
      )
    : []
  const receivedTotals = costVisible
    ? await c.many<{ currency: string; receivedMinor: number; outstandingMinor: number }>(
        `SELECT o.currency,
                COALESCE(SUM(i.unit_price_minor * COALESCE(recv.accepted, 0)), 0)::bigint AS "receivedMinor",
                COALESCE(SUM(i.unit_price_minor * (i.quantity - COALESCE(recv.accepted, 0) - COALESCE(recv.damaged, 0))), 0)::bigint AS "outstandingMinor"
         FROM purchase_orders o JOIN purchase_order_items i ON i.po_id = o.id
         LEFT JOIN (SELECT po_item_id, SUM(accepted_quantity) AS accepted, SUM(damaged_quantity) AS damaged FROM goods_receipt_items GROUP BY po_item_id) recv ON recv.po_item_id = i.id
         WHERE ${orderWhere} AND o.status <> 'cancelled' GROUP BY o.currency ORDER BY o.currency`,
        p2.values
      )
    : []

  const p3 = new Params()
  const org3 = p3.add(org)
  const discWhere = `gri.organization_id = ${org3} AND gri.discrepancy_status = 'open'`
  const discTotal = (await c.one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM goods_receipt_items gri WHERE ${discWhere}`,
    p3.values
  ))!.n
  const openDiscrepancies = await c.many<ProcurementSummaryReport['openDiscrepancies'][number]>(
    `SELECT gri.id, gr.id AS "receiptId", gr.receipt_number AS "receiptNumber", po.po_number AS "poNumber", poi.description,
            gri.damaged_quantity AS "damagedQuantity", gri.rejected_quantity AS "rejectedQuantity", gri.discrepancy_notes AS "discrepancyNotes", gr.received_at AS "receivedAt"
     FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.receipt_id JOIN purchase_orders po ON po.id = gr.po_id JOIN purchase_order_items poi ON poi.id = gri.po_item_id
     WHERE ${discWhere} ORDER BY gr.received_at DESC LIMIT ${p3.add(input.pageSize)} OFFSET ${p3.add((input.page - 1) * input.pageSize)}`,
    p3.values
  )
  return {
    requestTotals, orderTotals,
    receivedTotals: receivedTotals.map((r) => ({ currency: r.currency, receivedMinor: r.receivedMinor, outstandingMinor: r.outstandingMinor })),
    openDiscrepancies, openDiscrepancyTotal: Number(discTotal), page: input.page, pageSize: input.pageSize, costVisible
  }
}

// ---------------------------------------------------------------- warranty and lifecycle

const WARRANTY_COLUMNS = `a.id, a.asset_code AS "assetCode", cat.name AS "categoryName", l.name AS "locationName", a.warranty_end AS "warrantyEnd"`
const WARRANTY_FROM = `FROM assets a JOIN asset_categories cat ON cat.id = a.category_id LEFT JOIN locations l ON l.id = a.location_id`

export async function warrantyReport(c: SqlClient, raw: WarrantyReportInput, ctx: OpContext): Promise<WarrantyReport> {
  assertPermission(ctx.actor.permissions, 'reports.view')
  const input = warrantyReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const windowDays = input.windowDays ?? (await getSettings(c, org)).warrantyExpiryWindowDays
  const today = todayUtc()
  const p = new Params()
  let where = `a.organization_id = ${p.add(org)} AND a.lifecycle_status = 'active'`
  if (input.filter === 'expiring') where += ` AND a.warranty_end BETWEEN ${p.add(today)} AND ${p.add(addDays(today, windowDays))}`
  else if (input.filter === 'expired') where += ` AND a.warranty_end IS NOT NULL AND a.warranty_end < ${p.add(today)}`
  else where += ` AND a.warranty_end IS NULL`

  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${WARRANTY_FROM} WHERE ${where}`, p.values))!.n
  const rows = await c.many<WarrantyRow>(
    `SELECT ${WARRANTY_COLUMNS} ${WARRANTY_FROM} WHERE ${where} ORDER BY a.warranty_end NULLS LAST, a.asset_code
     LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  return { items: rows, total: Number(total), page: input.page, pageSize: input.pageSize, windowDays, filter: input.filter }
}

// ---------------------------------------------------------------- disposals

const DISPOSAL_COLUMNS = `a.id, a.asset_code AS "assetCode", cat.name AS "categoryName", a.disposal_date AS "disposalDate",
  a.disposal_method AS "disposalMethod", a.disposal_proceeds_minor AS "disposalProceedsMinor", a.currency`
const DISPOSAL_FROM = `FROM assets a JOIN asset_categories cat ON cat.id = a.category_id`

export async function disposalReport(c: SqlClient, raw: DisposalReportInput, ctx: OpContext): Promise<DisposalReport> {
  assertPermission(ctx.actor.permissions, 'reports.view')
  const input = disposalReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p = new Params()
  let where = `a.organization_id = ${p.add(org)} AND a.lifecycle_status = 'disposed'`
  if (input.fromDate) where += ` AND a.disposal_date >= ${p.add(input.fromDate)}`
  if (input.toDate) where += ` AND a.disposal_date <= ${p.add(input.toDate)}`

  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${DISPOSAL_FROM} WHERE ${where}`, p.values))!.n
  const totalsByCurrency = costVisible
    ? await c.many<{ currency: string; totalMinor: number; count: number }>(
        `SELECT a.currency, COALESCE(SUM(a.disposal_proceeds_minor), 0)::bigint AS "totalMinor", COUNT(*)::int AS count
         ${DISPOSAL_FROM} WHERE ${where} AND a.disposal_proceeds_minor IS NOT NULL GROUP BY a.currency ORDER BY a.currency`,
        p.values
      )
    : []
  const rows = await c.many<DisposalRow>(
    `SELECT ${DISPOSAL_COLUMNS} ${DISPOSAL_FROM} WHERE ${where} ORDER BY a.disposal_date DESC
     LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  const items = rows.map((r) => (costVisible ? r : { ...r, disposalProceedsMinor: null }))
  return { items, total: Number(total), page: input.page, pageSize: input.pageSize, totalsByCurrency, costVisible }
}

export async function exportWarrantyRows(c: SqlClient, raw: WarrantyReportInput, ctx: OpContext): Promise<{ headers: string[]; rows: Array<Array<string | number | null>> }> {
  assertPermission(ctx.actor.permissions, 'reports.export')
  const input = warrantyReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const windowDays = input.windowDays ?? (await getSettings(c, org)).warrantyExpiryWindowDays
  const today = todayUtc()
  const p = new Params()
  let where = `a.organization_id = ${p.add(org)} AND a.lifecycle_status = 'active'`
  if (input.filter === 'expiring') where += ` AND a.warranty_end BETWEEN ${p.add(today)} AND ${p.add(addDays(today, windowDays))}`
  else if (input.filter === 'expired') where += ` AND a.warranty_end IS NOT NULL AND a.warranty_end < ${p.add(today)}`
  else where += ` AND a.warranty_end IS NULL`
  const rows = await c.many<WarrantyRow>(`SELECT ${WARRANTY_COLUMNS} ${WARRANTY_FROM} WHERE ${where} ORDER BY a.warranty_end NULLS LAST, a.asset_code LIMIT 20000`, p.values)
  return { headers: ['Asset code', 'Category', 'Location', 'Warranty end'], rows: rows.map((r) => [r.assetCode, r.categoryName, r.locationName, r.warrantyEnd]) }
}

export async function exportDisposalRows(c: SqlClient, raw: DisposalReportInput, ctx: OpContext): Promise<{ headers: string[]; rows: Array<Array<string | number | null>>; includesCost: boolean }> {
  assertPermission(ctx.actor.permissions, 'reports.export')
  const input = disposalReportSchema.parse(raw)
  const org = ctx.actor.organizationId
  const costVisible = canViewCost(ctx)
  const p = new Params()
  let where = `a.organization_id = ${p.add(org)} AND a.lifecycle_status = 'disposed'`
  if (input.fromDate) where += ` AND a.disposal_date >= ${p.add(input.fromDate)}`
  if (input.toDate) where += ` AND a.disposal_date <= ${p.add(input.toDate)}`
  const rows = await c.many<DisposalRow>(`SELECT ${DISPOSAL_COLUMNS} ${DISPOSAL_FROM} WHERE ${where} ORDER BY a.disposal_date DESC LIMIT 20000`, p.values)
  return {
    headers: ['Asset code', 'Category', 'Disposal date', 'Method', 'Proceeds (minor)', 'Currency'],
    rows: rows.map((r) => [r.assetCode, r.categoryName, r.disposalDate, r.disposalMethod, costVisible ? r.disposalProceedsMinor : null, r.currency]),
    includesCost: costVisible
  }
}

export async function exportProcurementDiscrepancyRows(c: SqlClient, ctx: OpContext): Promise<{ headers: string[]; rows: Array<Array<string | number | null>> }> {
  assertPermission(ctx.actor.permissions, 'reports.export')
  const org = ctx.actor.organizationId
  const rows = await c.many<{ receiptNumber: string; poNumber: string; description: string; damagedQuantity: number; rejectedQuantity: number; discrepancyNotes: string | null; receivedAt: string }>(
    `SELECT gr.receipt_number AS "receiptNumber", po.po_number AS "poNumber", poi.description,
            gri.damaged_quantity AS "damagedQuantity", gri.rejected_quantity AS "rejectedQuantity", gri.discrepancy_notes AS "discrepancyNotes", gr.received_at AS "receivedAt"
     FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.receipt_id JOIN purchase_orders po ON po.id = gr.po_id JOIN purchase_order_items poi ON poi.id = gri.po_item_id
     WHERE gri.organization_id = $1 AND gri.discrepancy_status = 'open' ORDER BY gr.received_at DESC LIMIT 20000`,
    [org]
  )
  return {
    headers: ['Receipt', 'Purchase order', 'Line', 'Damaged qty', 'Rejected qty', 'Notes', 'Received at'],
    rows: rows.map((r) => [r.receiptNumber, r.poNumber, r.description, r.damagedQuantity, r.rejectedQuantity, r.discrepancyNotes, r.receivedAt])
  }
}

// ---------------------------------------------------------------- dashboard metrics

export interface ProcurementDashboardMetrics {
  draftRequests: number
  pendingApprovals: number
  openDiscrepancies: number
}

export async function procurementMetrics(c: SqlClient, ctx: OpContext): Promise<ProcurementDashboardMetrics | null> {
  if (!ctx.actor.permissions.has('procurement.view')) return null
  const org = ctx.actor.organizationId
  const r = (await c.one<{ draft: number; pending: number; disc: number }>(
    `SELECT
       (SELECT COUNT(*) FROM purchase_requests WHERE organization_id = $1 AND status = 'draft') AS draft,
       (SELECT COUNT(*) FROM approval_instances WHERE organization_id = $1 AND status = 'pending') AS pending,
       (SELECT COUNT(*) FROM goods_receipt_items WHERE organization_id = $1 AND discrepancy_status = 'open') AS disc`,
    [org]
  ))!
  return { draftRequests: Number(r.draft), pendingApprovals: Number(r.pending), openDiscrepancies: Number(r.disc) }
}

export interface FinanceDashboardMetrics {
  acquisitionValueByCurrency: CurrencyTotal[]
}

export async function financeMetrics(c: SqlClient, ctx: OpContext): Promise<FinanceDashboardMetrics | null> {
  if (!canViewCost(ctx)) return null
  const org = ctx.actor.organizationId
  const rows = await c.many<{ currency: string; totalMinor: number; count: number }>(
    `SELECT currency, COALESCE(SUM(acquisition_cost_minor), 0)::bigint AS "totalMinor", COUNT(*)::int AS count FROM assets
     WHERE organization_id = $1 AND lifecycle_status = 'active' AND acquisition_cost_minor IS NOT NULL GROUP BY currency ORDER BY currency`,
    [org]
  )
  return { acquisitionValueByCurrency: rows }
}
