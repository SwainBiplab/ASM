import { z } from 'zod'
import {
  ACKNOWLEDGMENT_METHODS,
  ACKNOWLEDGMENT_POLICIES,
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TARGET_TYPES,
  CLEARANCE_RESOLUTIONS,
  CLEARANCE_STATUSES,
  HANDOVER_TYPES,
  MOVEMENT_TYPES,
  RETURN_OUTCOMES
} from '@shared/allocations'
import type { AssetCustody, AssignmentView, ClearanceDetail, ClearanceItemView, ClearanceSummary, HandoverItemView, HandoverView, MovementView } from '@shared/api'
import { CONDITIONS, LIFECYCLE_STATUSES, OPERATIONAL_STATUSES } from '@shared/assets'
import { EMPLOYMENT_STATUSES } from '@shared/organization'
import { dateOnly, iso, nullable, uuid } from './responses'
import { documentLinkOutput } from './responsesW2'

/** W4 output schemas (D34): checked against the shared DTOs; undeclared fields are stripped. */

const optText = nullable(z.string())
const condition = z.enum(CONDITIONS)
const outcome = nullable(z.enum(RETURN_OUTCOMES))
const ackStatus = z.enum(['not_required', 'pending', 'acknowledged'])

export const assignmentOutput: z.ZodType<AssignmentView> = z.object({
  id: uuid, assetId: uuid, assetCode: z.string(), categoryName: z.string(), makeModel: optText, serialNumber: optText,
  targetType: z.enum(ASSIGNMENT_TARGET_TYPES), targetId: uuid, targetLabel: z.string(), locationId: nullable(uuid), locationPath: optText,
  status: z.enum(ASSIGNMENT_STATUSES), assignedAt: iso, expectedReturnDate: nullable(dateOnly), overdue: z.boolean(), issuedByName: optText,
  conditionAtIssue: condition, accessories: optText, endedAt: nullable(iso), endedByName: optText, conditionAtReturn: nullable(condition),
  returnOutcome: outcome, endReason: optText, issueHandoverId: uuid, issueHandoverNumber: z.string(), endHandoverId: nullable(uuid), acknowledgmentStatus: ackStatus
})

const movementOutput: z.ZodType<MovementView> = z.object({
  id: uuid, movementType: z.enum(MOVEMENT_TYPES), occurredAt: iso, actorName: optText, assignmentId: nullable(uuid), handoverId: nullable(uuid),
  handoverNumber: optText, targetLabel: optText, locationPath: optText, notes: optText
})

export const custodyOutput: z.ZodType<AssetCustody> = z.object({
  assetId: uuid, assetCode: z.string(), lifecycleStatus: z.enum(LIFECYCLE_STATUSES), operationalStatus: z.enum(OPERATIONAL_STATUSES),
  eligibleForIssue: z.boolean(), ineligibleReason: optText, currentAssignment: nullable(assignmentOutput), assignments: z.array(assignmentOutput), movements: z.array(movementOutput)
})

const handoverItemOutput: z.ZodType<HandoverItemView> = z.object({
  assetId: uuid, assetCode: z.string(), categoryName: z.string(), makeModel: optText, serialNumber: optText, condition, accessories: optText, outcome
})

export const handoverOutput: z.ZodType<HandoverView> = z.object({
  id: uuid, handoverNumber: z.string(), handoverType: z.enum(HANDOVER_TYPES), organizationName: z.string(),
  targetType: nullable(z.enum(ASSIGNMENT_TARGET_TYPES)), targetLabel: optText, locationPath: optText, performedAt: iso, performedByName: z.string(),
  reason: optText, notes: optText, acknowledgmentPolicy: z.enum(ACKNOWLEDGMENT_POLICIES), acknowledgmentStatus: ackStatus,
  acknowledgmentMethod: nullable(z.enum(ACKNOWLEDGMENT_METHODS)), acknowledgedByName: optText, acknowledgedAt: nullable(iso),
  acknowledgmentRecordedByName: optText, acknowledgmentDocumentId: nullable(uuid), items: z.array(handoverItemOutput), documents: z.array(documentLinkOutput)
})

const clearanceItemOutput: z.ZodType<ClearanceItemView> = z.object({
  id: uuid, assetId: uuid, assetCode: z.string(), categoryName: z.string(), makeModel: optText, serialNumber: optText, assignmentId: uuid, assignedAt: iso,
  resolution: z.enum(CLEARANCE_RESOLUTIONS), receivedCondition: nullable(condition), returnOutcome: outcome, exceptionReason: optText,
  reportedByName: optText, reportedAt: nullable(iso), decisionNotes: optText, reviewedByName: optText, reviewedAt: nullable(iso),
  returnHandoverId: nullable(uuid), documents: z.array(documentLinkOutput)
})

const clearanceSummaryShape = {
  id: uuid, clearanceNumber: z.string(), employeeId: uuid, employeeCode: z.string(), employeeName: z.string(), employmentStatus: z.enum(EMPLOYMENT_STATUSES),
  exitDate: dateOnly, ownerName: optText, status: z.enum(CLEARANCE_STATUSES), closureType: nullable(z.enum(['cleared', 'with_exceptions'])),
  openedAt: iso, openedByName: optText, closedAt: nullable(iso), itemCount: z.number().int(), unresolvedCount: z.number().int()
}
export const clearanceSummaryOutput: z.ZodType<ClearanceSummary> = z.object(clearanceSummaryShape)
export const clearanceDetailOutput: z.ZodType<ClearanceDetail> = z.object({
  ...clearanceSummaryShape, notes: optText, closingNotes: optText, closedByName: optText, cancelReason: optText,
  items: z.array(clearanceItemOutput), blockers: z.array(z.string())
})
