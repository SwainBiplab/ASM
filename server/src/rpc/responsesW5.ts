import { z } from 'zod'
import { AUDIT_ITEM_STATUSES, AUDIT_STATUSES, AUDIT_CLOSURE_TYPES, DISCREPANCY_TYPES } from '@shared/audits'
import type { AuditItemView, MaintenanceEventView, MaintenanceTicketDetail, MaintenanceTicketSummary, PhysicalAuditDetail, PhysicalAuditSummary } from '@shared/api'
import { CONDITIONS } from '@shared/assets'
import { FAULT_CATEGORIES, MAINTENANCE_PRIORITIES, TICKET_EVENT_TYPES, TICKET_STATUSES } from '@shared/maintenance'
import { RETURN_OUTCOMES } from '@shared/allocations'
import { dateOnly, iso, nullable, uuid } from './responses'
import { documentLinkOutput } from './responsesW2'

/** W5 output schemas (D34): checked against the shared DTOs; undeclared fields are stripped. */

const optText = nullable(z.string())
const condition = nullable(z.enum(CONDITIONS))

export const technicianOutput = z.array(z.object({ id: uuid, displayName: z.string() }))
export const reviewerOutput = technicianOutput

const ticketEventOutput: z.ZodType<MaintenanceEventView> = z.object({
  id: uuid, eventType: z.enum(TICKET_EVENT_TYPES), occurredAt: iso, actorName: optText, notes: optText
})

const ticketSummaryShape = {
  id: uuid, ticketNumber: z.string(), assetId: uuid, assetCode: z.string(), assetCategoryName: z.string(),
  faultCategory: z.enum(FAULT_CATEGORIES), priority: z.enum(MAINTENANCE_PRIORITIES), status: z.enum(TICKET_STATUSES), description: z.string(),
  reportedByName: optText, reportedAt: iso, assignedTechnicianName: optText, vendorName: optText, targetResolutionDate: nullable(dateOnly),
  resolvedAt: nullable(iso), closedAt: nullable(iso), overdue: z.boolean()
}
export const ticketSummaryOutput: z.ZodType<MaintenanceTicketSummary> = z.object(ticketSummaryShape)
export const ticketDetailOutput: z.ZodType<MaintenanceTicketDetail> = z.object({
  ...ticketSummaryShape, diagnosis: optText, workPerformed: optText, vendorReference: optText, costVisible: z.boolean(),
  partsCostMinor: nullable(z.number().int()), laborCostMinor: nullable(z.number().int()), currency: z.string(), downtimeMinutes: nullable(z.number().int()),
  closingNotes: optText, cancelReason: optText, resultOutcome: nullable(z.enum(RETURN_OUTCOMES)), justifiedDuplicate: z.boolean(),
  events: z.array(ticketEventOutput), documents: z.array(documentLinkOutput)
})

const auditSummaryShape = {
  id: uuid, auditNumber: z.string(), title: z.string(), scopeLocationPath: optText, scopeCategoryName: optText, scopeCustodianName: optText,
  responsibleUserName: optText, status: z.enum(AUDIT_STATUSES), closureType: nullable(z.enum(AUDIT_CLOSURE_TYPES)), openedAt: iso, openedByName: optText,
  closedAt: nullable(iso), itemCount: z.number().int(), verifiedCount: z.number().int(), unresolvedCount: z.number().int()
}
export const auditSummaryOutput: z.ZodType<PhysicalAuditSummary> = z.object(auditSummaryShape)
export const auditDetailOutput: z.ZodType<PhysicalAuditDetail> = z.object({
  ...auditSummaryShape, notes: optText, closingNotes: optText, closedByName: optText, cancelReason: optText, blockers: z.array(z.string())
})

export const auditItemOutput: z.ZodType<AuditItemView> = z.object({
  id: uuid, auditId: uuid, assetId: uuid, assetCode: z.string(), categoryName: z.string(), makeModel: optText, serialNumber: optText,
  source: z.enum(['expected', 'unexpected']), expectedLocationPath: optText, expectedCondition: condition, expectedCustodianLabel: optText,
  observedAt: nullable(iso), observedByName: optText, observedLocationPath: optText, observedCondition: condition, notes: optText,
  status: z.enum(AUDIT_ITEM_STATUSES), discrepancyType: nullable(z.enum(DISCREPANCY_TYPES)), assignedToName: optText, assignmentNotes: optText,
  resolutionNotes: optText, resolvedByName: optText, resolvedAt: nullable(iso), documents: z.array(documentLinkOutput)
})
