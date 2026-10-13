import type { DashboardSummary } from '@shared/api'
import {
  auditListInputSchema,
  changePasswordInputSchema,
  createUserInputSchema,
  loginInputSchema,
  resetPasswordInputSchema,
  settingsUpdateInputSchema,
  updateRolePermissionsInputSchema,
  updateUserInputSchema,
  voidInputSchema
} from '@shared/schemas'
import type { ServerConfig } from '../config'
import { AppError, type OpContext } from '../core'
import { touchSession } from '../auth/sessions'
import { schemaVersion } from '../db/migrator'
import { getSettings, listAuditEvents, updateSettings } from '../services/foundation'
import {
  changePassword,
  createUser,
  listRoles,
  listUsers,
  login,
  logout,
  organizationCount,
  resetUserPassword,
  sessionInfo,
  updateRolePermissions,
  updateUser
} from '../services/identity'
import type { HandlerContext, ServerCommandTable } from './dispatcher'
import { buildW2Commands } from './commandsW2'
import { buildW4Commands } from './commandsW4'
import { buildW5Commands } from './commandsW5'
import { buildW6Commands } from './commandsW6'
import { buildW7Commands } from './commandsW7'
import type { DocumentStorage } from '../storage/storage'
import { getAssetMetrics } from '../services/assets'
import { allocationsMetrics } from '../services/allocations'
import { auditMetrics } from '../services/audits'
import { clearanceMetrics } from '../services/clearances'
import { maintenanceMetrics } from '../services/maintenance'
import { financeMetrics, procurementMetrics } from '../services/reports'
import {
  auditEventOutput,
  dashboardOutput,
  nullOutput,
  pageOf,
  roleSummaryOutput,
  sessionInfoOutput,
  settingsOutput,
  startupStateOutput,
  userSummaryOutput
} from './responses'
import { z } from 'zod'

const APP_VERSION = process.env['npm_package_version'] ?? '0.1.0'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}
const meta = (ctx: HandlerContext) => ({ correlationId: ctx.correlationId, ip: ctx.http.ip, userAgent: ctx.http.userAgent })

export function buildCommands(config: ServerConfig, storage: DocumentStorage): ServerCommandTable {
  return {
    ...buildW2Commands(storage),
    ...buildW4Commands(storage),
    ...buildW5Commands(storage),
    ...buildW6Commands(storage),
    ...buildW7Commands(),
    'system.getStartupState': {
      output: startupStateOutput, input: voidInputSchema,
      auth: 'public',
      handler: async (_i, ctx) => ({
        // Setup happens through the bootstrap CLI, never through a public endpoint.
        status: (await organizationCount(ctx.db)) > 0 ? 'ready' : 'setup_required',
        appVersion: APP_VERSION,
        environment: config.APP_ENV
      })
    },
    'session.login': {
      output: sessionInfoOutput, input: loginInputSchema,
      auth: 'public',
      handler: async (input, ctx) => {
        const { session, info } = await login(ctx.db, input, meta(ctx), config.SESSION_ABSOLUTE_HOURS)
        ctx.http.setSessionCookie(session.token, session.absoluteExpiresAt)
        return info
      }
    },
    'session.logout': {
      output: nullOutput, input: voidInputSchema,
      auth: 'public',
      handler: async (_i, ctx) => {
        if (ctx.actor && ctx.sessionHash) await logout(ctx.db, ctx.sessionHash, ctx.actor.organizationId, ctx.actor.userId, meta(ctx))
        ctx.http.clearSessionCookie()
        return null
      }
    },
    'session.getCurrent': {
      output: sessionInfoOutput.nullable(), input: voidInputSchema,
      auth: 'public',
      handler: async (_i, ctx) => (ctx.actor ? sessionInfo(ctx.db, ctx.actor.organizationId, ctx.actor.userId) : null)
    },
    'session.touch': {
      output: nullOutput, input: voidInputSchema,
      auth: 'session',
      handler: async (_i, ctx) => {
        await touchSession(ctx.db, ctx.sessionHash!)
        return null
      }
    },
    'session.changePassword': {
      output: sessionInfoOutput, input: changePasswordInputSchema,
      auth: 'session',
      handler: (input, ctx) => changePassword(ctx.db, input, op(ctx), ctx.sessionHash!)
    },
    'users.list': { output: z.array(userSummaryOutput), input: voidInputSchema, auth: 'session', handler: (_i, ctx) => listUsers(ctx.db, op(ctx)) },
    'users.create': { output: userSummaryOutput, idempotency: 'optional', input: createUserInputSchema, auth: 'session', handler: (i, ctx) => createUser(ctx.db, i, op(ctx)) },
    'users.update': { output: userSummaryOutput, idempotency: 'optional', input: updateUserInputSchema, auth: 'session', handler: (i, ctx) => updateUser(ctx.db, i, op(ctx)) },
    'users.resetPassword': {
      output: nullOutput, idempotency: 'optional', input: resetPasswordInputSchema,
      auth: 'session',
      handler: async (i, ctx) => {
        await resetUserPassword(ctx.db, i, op(ctx))
        return null
      }
    },
    'roles.list': { output: z.array(roleSummaryOutput), input: voidInputSchema, auth: 'session', handler: (_i, ctx) => listRoles(ctx.db, op(ctx)) },
    'roles.updatePermissions': { output: roleSummaryOutput, idempotency: 'optional', input: updateRolePermissionsInputSchema, auth: 'session', handler: (i, ctx) => updateRolePermissions(ctx.db, i, op(ctx)) },
    'audit.list': { output: pageOf(auditEventOutput), input: auditListInputSchema, auth: 'session', handler: (i, ctx) => listAuditEvents(ctx.db, i, op(ctx)) },
    'settings.get': { output: settingsOutput, input: voidInputSchema, auth: 'session', handler: (_i, ctx) => getSettings(ctx.db, op(ctx).actor.organizationId) },
    'settings.update': { output: settingsOutput, idempotency: 'optional', input: settingsUpdateInputSchema, auth: 'session', handler: (i, ctx) => updateSettings(ctx.db, i, op(ctx)) },
    'dashboard.getSummary': {
      output: dashboardOutput, input: voidInputSchema,
      auth: 'session',
      handler: async (_i, ctx): Promise<DashboardSummary> => {
        const o = op(ctx).actor.organizationId
        const db = ctx.db
        const org = await db.one<{ name: string }>('SELECT display_name AS name FROM organizations WHERE id = $1', [o])
        return {
          organizationName: org?.name ?? '',
          activeUsers: (await db.one<{ n: number }>('SELECT count(*) AS n FROM users WHERE organization_id = $1 AND is_active', [o]))!.n,
          auditEventsLast7Days: (await db.one<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE organization_id = $1 AND occurred_at >= now() - interval '7 days'", [o]))!.n,
          // Backups are managed by the database platform in the web architecture (D30).
          lastBackup: null,
          schemaVersion: await schemaVersion(db),
          assets: await getAssetMetrics(db, op(ctx)),
          allocations: await allocationsMetrics(db, op(ctx)),
          exitClearances: await clearanceMetrics(db, op(ctx)),
          maintenance: await maintenanceMetrics(db, op(ctx)),
          audits: await auditMetrics(db, op(ctx)),
          procurement: await procurementMetrics(db, op(ctx)),
          finance: await financeMetrics(db, op(ctx))
        }
      }
    }
  }
}
