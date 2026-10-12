import {
  acknowledgeInputSchema,
  approveExceptionSchema,
  assetRefSchema,
  assignmentListSchema,
  cancelClearanceSchema,
  clearanceListSchema,
  clearanceRefSchema,
  closeClearanceSchema,
  flagClearanceItemSchema,
  handoverRefSchema,
  inspectInputSchema,
  issueInputSchema,
  openClearanceSchema,
  recordClearanceReturnSchema,
  reportLostInputSchema,
  returnInputSchema,
  transferInputSchema
} from '@shared/allocationSchemas'
import { AppError, type OpContext } from '../core'
import * as alloc from '../services/allocations'
import * as clearance from '../services/clearances'
import type { DocumentStorage } from '../storage/storage'
import type { W4CommandName } from './commandNames'
import type { CommandDefinition, HandlerContext } from './dispatcher'
import { pageOf } from './responses'
import * as out from './responsesW4'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}

const session = 'session' as const
/** Every W4 business action is retry-safe: a repeated Idempotency-Key replays the first outcome (D36). */
const required = 'required' as const

export function buildW4Commands(storage: DocumentStorage): { [K in W4CommandName]: CommandDefinition<K> } {
  return {
    'allocations.list': { input: assignmentListSchema, output: pageOf(out.assignmentOutput), auth: session, handler: (i, c) => alloc.listAssignments(c.db, i, op(c)) },
    'allocations.custody': { input: assetRefSchema, output: out.custodyOutput, auth: session, handler: (i, c) => alloc.getCustody(c.db, i.assetId, op(c)) },
    'allocations.getHandover': { input: handoverRefSchema, output: out.handoverOutput, auth: session, handler: (i, c) => alloc.getHandover(c.db, storage, i.handoverId, op(c)) },
    'allocations.issue': { input: issueInputSchema, output: out.handoverOutput, auth: session, idempotency: required, handler: (i, c) => alloc.issueAssets(c.db, storage, i, op(c)) },
    'allocations.transfer': { input: transferInputSchema, output: out.handoverOutput, auth: session, idempotency: required, handler: (i, c) => alloc.transferAssets(c.db, storage, i, op(c)) },
    'allocations.return': { input: returnInputSchema, output: out.handoverOutput, auth: session, idempotency: required, handler: (i, c) => alloc.returnAssets(c.db, storage, i, op(c)) },
    'allocations.acknowledge': { input: acknowledgeInputSchema, output: out.handoverOutput, auth: session, idempotency: required, handler: (i, c) => alloc.acknowledgeHandover(c.db, storage, i, op(c)) },
    'allocations.inspect': { input: inspectInputSchema, output: out.custodyOutput, auth: session, idempotency: required, handler: (i, c) => alloc.inspectAsset(c.db, i, op(c)) },
    'allocations.reportLost': { input: reportLostInputSchema, output: out.custodyOutput, auth: session, idempotency: required, handler: (i, c) => alloc.reportLost(c.db, i, op(c)) },

    'exitClearance.list': { input: clearanceListSchema, output: pageOf(out.clearanceSummaryOutput), auth: session, handler: (i, c) => clearance.listClearances(c.db, i, op(c)) },
    'exitClearance.get': { input: clearanceRefSchema, output: out.clearanceDetailOutput, auth: session, handler: (i, c) => clearance.getClearance(c.db, storage, i.clearanceId, op(c)) },
    'exitClearance.open': { input: openClearanceSchema, output: out.clearanceDetailOutput, auth: session, idempotency: required, handler: (i, c) => clearance.openClearance(c.db, storage, i, op(c)) },
    'exitClearance.recordReturn': { input: recordClearanceReturnSchema, output: out.clearanceDetailOutput, auth: session, idempotency: required, handler: (i, c) => clearance.recordClearanceReturn(c.db, storage, i, op(c)) },
    'exitClearance.flagItem': { input: flagClearanceItemSchema, output: out.clearanceDetailOutput, auth: session, idempotency: required, handler: (i, c) => clearance.flagClearanceItem(c.db, storage, i, op(c)) },
    'exitClearance.approveException': { input: approveExceptionSchema, output: out.clearanceDetailOutput, auth: session, idempotency: required, handler: (i, c) => clearance.approveClearanceException(c.db, storage, i, op(c)) },
    'exitClearance.close': { input: closeClearanceSchema, output: out.clearanceDetailOutput, auth: session, idempotency: required, handler: (i, c) => clearance.closeClearance(c.db, storage, i, op(c)) },
    'exitClearance.cancel': { input: cancelClearanceSchema, output: out.clearanceDetailOutput, auth: session, idempotency: required, handler: (i, c) => clearance.cancelClearance(c.db, storage, i, op(c)) }
  }
}
