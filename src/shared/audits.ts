/** Physical audit constants (W5, TAS §13). Shared by the server and the browser. */

/** How the expected inventory for an audit was selected at creation time. */
export const AUDIT_SCOPE_MODES = ['criteria', 'selected'] as const
export type AuditScopeMode = (typeof AUDIT_SCOPE_MODES)[number]

export const AUDIT_STATUSES = ['open', 'closed', 'cancelled'] as const
export type AuditStatus = (typeof AUDIT_STATUSES)[number]
export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled'
}
export const AUDIT_CLOSURE_TYPES = ['fully_verified', 'with_exceptions'] as const
export type AuditClosureType = (typeof AUDIT_CLOSURE_TYPES)[number]

/**
 * Item lifecycle. `pending` is the frozen baseline before any scan. A scan either verifies the
 * item or opens a discrepancy; a discrepancy is `resolved` (corrected) or formally `accepted`
 * (kept as a known exception) — never silently dropped (TAS §13).
 */
export const AUDIT_ITEM_STATUSES = ['pending', 'verified', 'discrepancy_open', 'investigating', 'resolved', 'accepted'] as const
export type AuditItemStatus = (typeof AUDIT_ITEM_STATUSES)[number]
export const AUDIT_ITEM_STATUS_LABELS: Record<AuditItemStatus, string> = {
  pending: 'Not yet verified',
  verified: 'Verified',
  discrepancy_open: 'Discrepancy',
  investigating: 'Investigating',
  resolved: 'Resolved',
  accepted: 'Accepted exception'
}
/** Statuses that block audit closure. */
export const UNRESOLVED_AUDIT_ITEM_STATUSES: readonly AuditItemStatus[] = ['pending', 'discrepancy_open', 'investigating']

export const DISCREPANCY_TYPES = ['missing', 'unexpected', 'location_mismatch', 'condition_mismatch', 'identification_mismatch'] as const
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number]
export const DISCREPANCY_TYPE_LABELS: Record<DiscrepancyType, string> = {
  missing: 'Missing — not found',
  unexpected: 'Unexpected asset found',
  location_mismatch: 'Wrong location',
  condition_mismatch: 'Condition mismatch',
  identification_mismatch: 'Identification mismatch'
}
