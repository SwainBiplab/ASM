/** Procurement, approvals, purchase orders, and goods receipt constants (W6, TAS §12). Shared by the server and the browser. */

export const REQUEST_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted, pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
}

export const APPROVAL_INSTANCE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type ApprovalInstanceStatus = (typeof APPROVAL_INSTANCE_STATUSES)[number]

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const
export type ApprovalDecisionValue = (typeof APPROVAL_DECISIONS)[number]

export const ORDER_STATUSES = ['open', 'partially_received', 'received', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  open: 'Open',
  partially_received: 'Partially received',
  received: 'Fully received',
  cancelled: 'Cancelled'
}

export const RECEIPT_DISCREPANCY_STATUSES = ['none', 'open', 'resolved'] as const
export type ReceiptDiscrepancyStatus = (typeof RECEIPT_DISCREPANCY_STATUSES)[number]
export const RECEIPT_DISCREPANCY_LABELS: Record<ReceiptDiscrepancyStatus, string> = {
  none: 'No discrepancy',
  open: 'Discrepancy open',
  resolved: 'Discrepancy resolved'
}

/** Per-unit outcome for an individually tracked receipt line (TAS §5/§6). */
export const UNIT_DISPOSITIONS = ['accepted', 'damaged', 'rejected'] as const
export type UnitDisposition = (typeof UNIT_DISPOSITIONS)[number]
export const UNIT_DISPOSITION_LABELS: Record<UnitDisposition, string> = {
  accepted: 'Accepted, good condition',
  damaged: 'Accepted, damaged',
  rejected: 'Rejected, returned to supplier'
}

export const APPROVAL_TRANSACTION_TYPES = ['purchase_request'] as const
export type ApprovalTransactionType = (typeof APPROVAL_TRANSACTION_TYPES)[number]
