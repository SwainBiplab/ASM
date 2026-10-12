import {
  acceptExceptionSchema,
  assignDiscrepancySchema,
  auditItemListSchema,
  auditListSchema,
  auditRefSchema,
  cancelAuditSchema,
  closeAuditSchema,
  correctLocationSchema,
  createAuditSchema,
  flagMissingSchema,
  resolveDiscrepancySchema,
  verifyItemSchema
} from '@shared/auditSchemas'
import {
  assignTicketSchema,
  cancelTicketSchema,
  closeTicketSchema,
  createTicketSchema,
  resolveTicketSchema,
  ticketListSchema,
  ticketRefSchema,
  updateTicketSchema
} from '@shared/maintenanceSchemas'
import { voidInputSchema } from '@shared/schemas'
import { AppError, type OpContext } from '../core'
import * as audits from '../services/audits'
import * as maintenance from '../services/maintenance'
import type { DocumentStorage } from '../storage/storage'
import type { W5CommandName } from './commandNames'
import type { CommandDefinition, HandlerContext } from './dispatcher'
import { pageOf } from './responses'
import * as out from './responsesW5'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}

const session = 'session' as const
/** Every W5 business action is retry-safe: a repeated Idempotency-Key replays the first outcome (D36). */
const required = 'required' as const

export function buildW5Commands(storage: DocumentStorage): { [K in W5CommandName]: CommandDefinition<K> } {
  return {
    'maintenance.list': { input: ticketListSchema, output: pageOf(out.ticketSummaryOutput), auth: session, handler: (i, c) => maintenance.listTickets(c.db, i, op(c)) },
    'maintenance.get': { input: ticketRefSchema, output: out.ticketDetailOutput, auth: session, handler: (i, c) => maintenance.getTicket(c.db, storage, i.ticketId, op(c)) },
    'maintenance.listTechnicians': { input: voidInputSchema, output: out.technicianOutput, auth: session, handler: (_i, c) => maintenance.listTechnicians(c.db, op(c)) },
    'maintenance.create': { input: createTicketSchema, output: out.ticketDetailOutput, auth: session, idempotency: required, handler: (i, c) => maintenance.createTicket(c.db, storage, i, op(c)) },
    'maintenance.assign': { input: assignTicketSchema, output: out.ticketDetailOutput, auth: session, idempotency: required, handler: (i, c) => maintenance.assignTicket(c.db, storage, i, op(c)) },
    'maintenance.update': { input: updateTicketSchema, output: out.ticketDetailOutput, auth: session, idempotency: required, handler: (i, c) => maintenance.updateTicket(c.db, storage, i, op(c)) },
    'maintenance.resolve': { input: resolveTicketSchema, output: out.ticketDetailOutput, auth: session, idempotency: required, handler: (i, c) => maintenance.resolveTicket(c.db, storage, i, op(c)) },
    'maintenance.close': { input: closeTicketSchema, output: out.ticketDetailOutput, auth: session, idempotency: required, handler: (i, c) => maintenance.closeTicket(c.db, storage, i, op(c)) },
    'maintenance.cancel': { input: cancelTicketSchema, output: out.ticketDetailOutput, auth: session, idempotency: required, handler: (i, c) => maintenance.cancelTicket(c.db, storage, i, op(c)) },

    'audits.list': { input: auditListSchema, output: pageOf(out.auditSummaryOutput), auth: session, handler: (i, c) => audits.listAudits(c.db, i, op(c)) },
    'audits.get': { input: auditRefSchema, output: out.auditDetailOutput, auth: session, handler: (i, c) => audits.getAudit(c.db, i.auditId, op(c)) },
    'audits.getItems': { input: auditItemListSchema, output: pageOf(out.auditItemOutput), auth: session, handler: (i, c) => audits.listAuditItems(c.db, storage, i, op(c)) },
    'audits.listReviewers': { input: voidInputSchema, output: out.reviewerOutput, auth: session, handler: (_i, c) => audits.listReviewers(c.db, op(c)) },
    'audits.create': { input: createAuditSchema, output: out.auditDetailOutput, auth: session, idempotency: required, handler: (i, c) => audits.createAudit(c.db, storage, i, op(c)) },
    'audits.verifyItem': { input: verifyItemSchema, output: out.auditItemOutput, auth: session, idempotency: required, handler: (i, c) => audits.verifyItem(c.db, storage, i, op(c)) },
    'audits.flagMissing': { input: flagMissingSchema, output: out.auditItemOutput, auth: session, idempotency: required, handler: (i, c) => audits.flagMissing(c.db, storage, i, op(c)) },
    'audits.assignDiscrepancy': { input: assignDiscrepancySchema, output: out.auditItemOutput, auth: session, idempotency: required, handler: (i, c) => audits.assignDiscrepancy(c.db, storage, i, op(c)) },
    'audits.resolveDiscrepancy': { input: resolveDiscrepancySchema, output: out.auditItemOutput, auth: session, idempotency: required, handler: (i, c) => audits.resolveDiscrepancy(c.db, storage, i, op(c)) },
    'audits.correctLocation': { input: correctLocationSchema, output: out.auditItemOutput, auth: session, idempotency: required, handler: (i, c) => audits.correctLocation(c.db, storage, i, op(c)) },
    'audits.acceptException': { input: acceptExceptionSchema, output: out.auditItemOutput, auth: session, idempotency: required, handler: (i, c) => audits.acceptException(c.db, storage, i, op(c)) },
    'audits.close': { input: closeAuditSchema, output: out.auditDetailOutput, auth: session, idempotency: required, handler: (i, c) => audits.closeAudit(c.db, i, op(c)) },
    'audits.cancel': { input: cancelAuditSchema, output: out.auditDetailOutput, auth: session, idempotency: required, handler: (i, c) => audits.cancelAudit(c.db, i, op(c)) }
  }
}
