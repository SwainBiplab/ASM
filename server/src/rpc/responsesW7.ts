import { z } from 'zod'
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
import { LIFECYCLE_STATUSES, OPERATIONAL_STATUSES } from '@shared/assets'
import { TICKET_STATUSES } from '@shared/maintenance'
import { ORDER_STATUSES, REQUEST_STATUSES } from '@shared/procurement'
import { WARRANTY_REPORT_FILTERS } from '@shared/reports'
import { dateOnly, iso, nullable, uuid } from './responses'

/** W7 output schemas (D34): checked against the shared DTOs; undeclared fields are stripped. */

const optText = nullable(z.string())
const optInt = nullable(z.number().int())
const currencyTotalOutput = z.object({ currency: z.string(), totalMinor: z.number().int(), count: z.number().int() })

const valuationRowOutput: z.ZodType<AssetValuationRow> = z.object({
  id: uuid, assetCode: z.string(), categoryName: z.string(), manufacturer: optText, modelName: optText, locationName: optText, departmentName: optText,
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES), operationalStatus: z.enum(OPERATIONAL_STATUSES), purchaseDate: nullable(dateOnly),
  acquisitionCostMinor: optInt, currency: optText, supplierName: optText, invoiceReference: optText, purchaseReference: optText, missingFinancialMetadata: z.boolean()
})
export const assetValuationReportOutput: z.ZodType<AssetValuationReport> = z.object({
  items: z.array(valuationRowOutput), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
  totalsByCurrency: z.array(currencyTotalOutput), costVisible: z.boolean()
})

const maintCostRowOutput: z.ZodType<MaintenanceCostRow> = z.object({
  id: uuid, ticketNumber: z.string(), assetId: uuid, assetCode: z.string(), categoryName: z.string(), locationName: optText, vendorName: optText,
  status: z.enum(TICKET_STATUSES), reportedAt: iso, closedAt: nullable(iso), partsCostMinor: optInt, laborCostMinor: optInt, currency: optText, downtimeMinutes: optInt
})
export const maintenanceCostReportOutput: z.ZodType<MaintenanceCostReport> = z.object({
  items: z.array(maintCostRowOutput), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
  totalsByCurrency: z.array(currencyTotalOutput),
  topAssets: z.array(z.object({ assetId: uuid, assetCode: z.string(), currency: z.string(), ticketCount: z.number().int(), totalCostMinor: z.number().int() })),
  costVisible: z.boolean()
})

export const procurementSummaryReportOutput: z.ZodType<ProcurementSummaryReport> = z.object({
  requestTotals: z.array(z.object({ status: z.enum(REQUEST_STATUSES), currency: z.string(), totalMinor: z.number().int(), count: z.number().int() })),
  orderTotals: z.array(z.object({ status: z.enum(ORDER_STATUSES), currency: z.string(), totalMinor: z.number().int(), count: z.number().int() })),
  receivedTotals: z.array(z.object({ currency: z.string(), receivedMinor: z.number().int(), outstandingMinor: z.number().int() })),
  openDiscrepancies: z.array(z.object({
    id: uuid, receiptId: uuid, receiptNumber: z.string(), poNumber: z.string(), description: z.string(), damagedQuantity: z.number().int(), rejectedQuantity: z.number().int(),
    discrepancyNotes: optText, receivedAt: iso
  })),
  openDiscrepancyTotal: z.number().int(), page: z.number().int(), pageSize: z.number().int(), costVisible: z.boolean()
})

const warrantyRowOutput: z.ZodType<WarrantyRow> = z.object({ id: uuid, assetCode: z.string(), categoryName: z.string(), locationName: optText, warrantyEnd: nullable(dateOnly) })
export const warrantyReportOutput: z.ZodType<WarrantyReport> = z.object({
  items: z.array(warrantyRowOutput), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(), windowDays: z.number().int(), filter: z.enum(WARRANTY_REPORT_FILTERS)
})

const disposalRowOutput: z.ZodType<DisposalRow> = z.object({
  id: uuid, assetCode: z.string(), categoryName: z.string(), disposalDate: nullable(dateOnly), disposalMethod: optText, disposalProceedsMinor: optInt, currency: optText
})
export const disposalReportOutput: z.ZodType<DisposalReport> = z.object({
  items: z.array(disposalRowOutput), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
  totalsByCurrency: z.array(currencyTotalOutput), costVisible: z.boolean()
})
