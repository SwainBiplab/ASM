/** Allocation and exit-clearance constants (W4, TAS §9–§10). Shared by the server and the browser. */

/** Exactly one target per assignment; physical location is recorded separately (TAS §9.1). */
export const ASSIGNMENT_TARGET_TYPES = ['employee', 'workstation', 'department', 'team', 'pool'] as const
export type AssignmentTargetType = (typeof ASSIGNMENT_TARGET_TYPES)[number]
export const TARGET_TYPE_LABELS: Record<AssignmentTargetType, string> = {
  employee: 'Employee',
  workstation: 'Workstation / seat',
  department: 'Department',
  team: 'Team / process',
  pool: 'Shared pool'
}

/** `lost` ends an assignment only through an explicit, authorized loss decision (never silently). */
export const ASSIGNMENT_STATUSES = ['active', 'returned', 'transferred', 'lost'] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]
export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  active: 'Active',
  returned: 'Returned',
  transferred: 'Transferred',
  lost: 'Ended: reported lost'
}

/**
 * Where a returned asset goes next (TAS §9.5). Closing an assignment never makes an asset
 * available by itself: `ready` needs the inspection permission and a non-damaged condition.
 */
export const RETURN_OUTCOMES = ['ready', 'awaiting_inspection', 'non_operational'] as const
export type ReturnOutcome = (typeof RETURN_OUTCOMES)[number]
export const RETURN_OUTCOME_LABELS: Record<ReturnOutcome, string> = {
  ready: 'Inspected: ready for reuse',
  awaiting_inspection: 'Needs inspection',
  non_operational: 'Faulty / not working'
}
export const INSPECTION_OUTCOMES = ['ready', 'non_operational'] as const
export type InspectionOutcome = (typeof INSPECTION_OUTCOMES)[number]

/**
 * Handover acknowledgment policy (TAS B3, D39). Default: explicit in-app acknowledgment.
 *  in_app           — the recipient (or the responsible person for a non-employee target) confirms on
 *                     the operator's screen at handover; the operator is recorded as the attestor.
 *  signed_receipt   — print the receipt; the handover stays pending until the signed copy is attached.
 *  in_app_or_signed — either; handovers without on-screen confirmation stay pending.
 */
export const ACKNOWLEDGMENT_POLICIES = ['in_app', 'signed_receipt', 'in_app_or_signed'] as const
export type AcknowledgmentPolicy = (typeof ACKNOWLEDGMENT_POLICIES)[number]
export const ACKNOWLEDGMENT_POLICY_LABELS: Record<AcknowledgmentPolicy, string> = {
  in_app: 'On-screen confirmation at handover (default)',
  signed_receipt: 'Printed receipt, signed and attached afterwards',
  in_app_or_signed: 'Either on-screen confirmation or a signed receipt'
}
export const ACKNOWLEDGMENT_METHODS = ['in_app', 'signed_receipt'] as const
export type AcknowledgmentMethod = (typeof ACKNOWLEDGMENT_METHODS)[number]
export const ACKNOWLEDGMENT_METHOD_LABELS: Record<AcknowledgmentMethod, string> = {
  in_app: 'Confirmed on screen',
  signed_receipt: 'Signed receipt attached'
}

export const HANDOVER_TYPES = ['issue', 'transfer', 'return'] as const
export type HandoverType = (typeof HANDOVER_TYPES)[number]
export type AcknowledgmentStatus = 'not_required' | 'pending' | 'acknowledged'

export const MOVEMENT_TYPES = ['issued', 'transferred', 'returned', 'inspected', 'reported_lost'] as const
export type MovementType = (typeof MOVEMENT_TYPES)[number]
export const MOVEMENT_LABELS: Record<MovementType, string> = {
  issued: 'Issued',
  transferred: 'Transferred',
  returned: 'Returned',
  inspected: 'Inspected',
  reported_lost: 'Reported lost'
}

export const CLEARANCE_STATUSES = ['open', 'closed', 'cancelled'] as const
export type ClearanceStatus = (typeof CLEARANCE_STATUSES)[number]
export const CLEARANCE_RESOLUTIONS = ['outstanding', 'returned', 'damaged', 'missing', 'disputed', 'exception_approved'] as const
export type ClearanceResolution = (typeof CLEARANCE_RESOLUTIONS)[number]
export const CLEARANCE_RESOLUTION_LABELS: Record<ClearanceResolution, string> = {
  outstanding: 'Outstanding',
  returned: 'Returned',
  damaged: 'Returned damaged',
  missing: 'Missing',
  disputed: 'Disputed',
  exception_approved: 'Exception approved'
}
/** Resolutions that block closure until an authorized exception decision is recorded. */
export const EXCEPTION_RESOLUTIONS: readonly ClearanceResolution[] = ['damaged', 'missing', 'disputed']
/** Resolutions that still block closure. */
export const UNRESOLVED_RESOLUTIONS: readonly ClearanceResolution[] = ['outstanding', 'damaged', 'missing', 'disputed']
