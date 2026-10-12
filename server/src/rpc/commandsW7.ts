import {
  assetValuationReportSchema,
  disposalReportSchema,
  maintenanceCostReportSchema,
  procurementSummaryReportSchema,
  warrantyReportSchema
} from '@shared/reportsSchemas'
import { AppError, type OpContext } from '../core'
import * as reports from '../services/reports'
import type { W7CommandName } from './commandNames'
import type { CommandDefinition, HandlerContext } from './dispatcher'
import * as out from './responsesW7'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}

const session = 'session' as const

export function buildW7Commands(): { [K in W7CommandName]: CommandDefinition<K> } {
  return {
    'reports.assetValuation': { input: assetValuationReportSchema, output: out.assetValuationReportOutput, auth: session, handler: (i, c) => reports.assetValuationReport(c.db, i, op(c)) },
    'reports.maintenanceCost': { input: maintenanceCostReportSchema, output: out.maintenanceCostReportOutput, auth: session, handler: (i, c) => reports.maintenanceCostReport(c.db, i, op(c)) },
    'reports.procurementSummary': { input: procurementSummaryReportSchema, output: out.procurementSummaryReportOutput, auth: session, handler: (i, c) => reports.procurementSummaryReport(c.db, i, op(c)) },
    'reports.warranty': { input: warrantyReportSchema, output: out.warrantyReportOutput, auth: session, handler: (i, c) => reports.warrantyReport(c.db, i, op(c)) },
    'reports.disposals': { input: disposalReportSchema, output: out.disposalReportOutput, auth: session, handler: (i, c) => reports.disposalReport(c.db, i, op(c)) }
  }
}
