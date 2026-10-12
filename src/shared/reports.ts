/** Financial and management reporting constants (W7, TAS §14/§17). Shared by the server and the browser. */

/** Depreciation stays disabled until Finance formally approves a policy (TAS §23 F1). */
export const DEPRECIATION_ENABLED = false

export const WARRANTY_REPORT_FILTERS = ['expiring', 'expired', 'missing'] as const
export type WarrantyReportFilter = (typeof WARRANTY_REPORT_FILTERS)[number]
export const WARRANTY_REPORT_FILTER_LABELS: Record<WarrantyReportFilter, string> = {
  expiring: 'Expiring soon',
  expired: 'Already expired',
  missing: 'No warranty data recorded'
}

export const REPORT_KINDS = ['assetValuation', 'maintenanceCost', 'warranty', 'disposals'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]
export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  assetValuation: 'Asset acquisition and valuation',
  maintenanceCost: 'Maintenance expenditure',
  warranty: 'Warranty and lifecycle',
  disposals: 'Disposals and proceeds'
}

/** One row per currency: amounts are never summed across currencies without an approved exchange-rate policy (TAS §14.2). */
export interface CurrencyTotal {
  currency: string
  totalMinor: number
  count: number
}
