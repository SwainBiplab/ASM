import {
  amendOrderSchema,
  approvalQueueSchema,
  cancelOrderSchema,
  cancelRequestSchema,
  createOrderSchema,
  createReceiptSchema,
  decideApprovalSchema,
  orderListSchema,
  orderRefSchema,
  policyListSchema,
  receiptListSchema,
  receiptRefSchema,
  requestListSchema,
  requestRefSchema,
  resolveDiscrepancySchema,
  saveApprovalPolicySchema,
  saveRequestDraftSchema,
  submitRequestSchema
} from '@shared/procurementSchemas'
import { AppError, type OpContext } from '../core'
import * as procurement from '../services/procurement'
import * as purchasing from '../services/purchasing'
import type { DocumentStorage } from '../storage/storage'
import type { W6CommandName } from './commandNames'
import type { CommandDefinition, HandlerContext } from './dispatcher'
import { pageOf } from './responses'
import * as out from './responsesW6'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}

const session = 'session' as const
/** Every W6 business action is retry-safe: a repeated Idempotency-Key replays the first outcome (D36). */
const required = 'required' as const

export function buildW6Commands(storage: DocumentStorage): { [K in W6CommandName]: CommandDefinition<K> } {
  return {
    'procurement.saveDraft': { input: saveRequestDraftSchema, output: out.requestDetailOutput, auth: session, idempotency: required, handler: (i, c) => procurement.saveRequestDraft(c.db, storage, i, op(c)) },
    'procurement.get': { input: requestRefSchema, output: out.requestDetailOutput, auth: session, handler: (i, c) => procurement.getRequest(c.db, storage, i.requestId, op(c)) },
    'procurement.list': { input: requestListSchema, output: pageOf(out.requestSummaryOutput), auth: session, handler: (i, c) => procurement.listRequests(c.db, i, op(c)) },
    'procurement.submit': { input: submitRequestSchema, output: out.requestDetailOutput, auth: session, idempotency: required, handler: (i, c) => procurement.submitRequest(c.db, storage, i, op(c)) },
    'procurement.cancel': { input: cancelRequestSchema, output: out.requestDetailOutput, auth: session, idempotency: required, handler: (i, c) => procurement.cancelRequest(c.db, storage, i, op(c)) },

    'approvals.savePolicy': { input: saveApprovalPolicySchema, output: out.approvalPolicyOutput, auth: session, idempotency: required, handler: (i, c) => procurement.saveApprovalPolicy(c.db, i, op(c)) },
    'approvals.listPolicies': { input: policyListSchema, output: out.approvalPolicyOutput.array(), auth: session, handler: (i, c) => procurement.listApprovalPolicies(c.db, i, op(c)) },
    'approvals.decide': { input: decideApprovalSchema, output: out.requestDetailOutput, auth: session, idempotency: required, handler: (i, c) => procurement.decideApproval(c.db, storage, i, op(c)) },
    'approvals.listQueue': { input: approvalQueueSchema, output: pageOf(out.approvalQueueItemOutput), auth: session, handler: (i, c) => procurement.listApprovalQueue(c.db, i, op(c)) },

    'orders.create': { input: createOrderSchema, output: out.orderDetailOutput, auth: session, idempotency: required, handler: (i, c) => purchasing.createOrder(c.db, storage, i, op(c)) },
    'orders.amend': { input: amendOrderSchema, output: out.orderDetailOutput, auth: session, idempotency: required, handler: (i, c) => purchasing.amendOrder(c.db, storage, i, op(c)) },
    'orders.cancel': { input: cancelOrderSchema, output: out.orderDetailOutput, auth: session, idempotency: required, handler: (i, c) => purchasing.cancelOrder(c.db, storage, i, op(c)) },
    'orders.get': { input: orderRefSchema, output: out.orderDetailOutput, auth: session, handler: (i, c) => purchasing.getOrder(c.db, storage, i.poId, op(c)) },
    'orders.list': { input: orderListSchema, output: pageOf(out.orderSummaryOutput), auth: session, handler: (i, c) => purchasing.listOrders(c.db, i, op(c)) },

    'receipts.create': { input: createReceiptSchema, output: out.receiptDetailOutput, auth: session, idempotency: required, handler: (i, c) => purchasing.createReceipt(c.db, storage, i, op(c)) },
    'receipts.resolveDiscrepancy': { input: resolveDiscrepancySchema, output: out.receiptDetailOutput, auth: session, idempotency: required, handler: (i, c) => purchasing.resolveReceiptDiscrepancy(c.db, storage, i, op(c)) },
    'receipts.get': { input: receiptRefSchema, output: out.receiptDetailOutput, auth: session, handler: (i, c) => purchasing.getReceipt(c.db, storage, i.receiptId, op(c)) },
    'receipts.list': { input: receiptListSchema, output: pageOf(out.receiptSummaryOutput), auth: session, handler: (i, c) => purchasing.listReceipts(c.db, i, op(c)) }
  }
}
