import { ZodError, type ZodType } from 'zod'
import type { CommandMap, CommandName, DesktopCommandName } from '@shared/api'
import type { Result } from '@shared/errors'
import { AppError, isAppError } from '../app/errors'
import { newCorrelationId } from '../app/ids'
import type { Logger } from '../logging/logger'
import type { Actor, OpContext } from '../services/context'

/**
 * public  — callable without a session (startup state, first-run setup, login)
 * session — requires an unlocked session
 * locked  — requires a session, which may be idle-locked (unlock/logout/getCurrent)
 */
export type AuthMode = 'public' | 'session' | 'locked'

export interface HandlerContext {
  correlationId: string
  actor: Actor | null
}

export interface CommandDefinition<K extends CommandName> {
  input: ZodType
  auth: AuthMode
  /** Whether a successful call counts as user activity for idle locking. Default true. */
  touch?: boolean
  handler: (input: CommandMap[K]['input'], ctx: HandlerContext) => Promise<CommandMap[K]['output']> | CommandMap[K]['output']
}

export type CommandTable = { [K in DesktopCommandName]: CommandDefinition<K> }

export type SessionResolution =
  | { state: 'none' }
  | { state: 'locked'; actor: Actor }
  | { state: 'active'; actor: Actor }

export interface DispatcherDeps {
  commands: CommandTable
  resolveSession: () => SessionResolution
  touchSession: () => void
  logger: Logger
}

/** Converts a handler context into a service context; only valid after auth checks. */
export function requireOp(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor }
}

export function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_'
    out[key] ??= issue.message
  }
  return out
}

function toFailure(err: unknown, correlationId: string, logger: Logger, command: string): Result<never> {
  if (isAppError(err)) {
    if (err.code === 'DATABASE_ERROR' || err.code === 'BACKUP_FAILED' || err.code === 'RESTORE_FAILED') {
      logger.error('ipc', err.message, { correlationId, command, code: err.code })
    }
    return {
      ok: false,
      error: { code: err.code, message: err.message, correlationId, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) }
    }
  }
  if (err instanceof ZodError) {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid.', correlationId, fieldErrors: zodFieldErrors(err) }
    }
  }
  const sqliteCode = (err as { code?: unknown })?.code
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    logger.warn('ipc', 'Constraint violation', { correlationId, command, sqliteCode, error: err })
    const duplicate = sqliteCode === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteCode === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    return {
      ok: false,
      error: {
        code: duplicate ? 'DUPLICATE_RECORD' : 'STATE_CONFLICT',
        message: duplicate ? 'A record with the same identifier already exists.' : 'The change conflicts with existing records.',
        correlationId
      }
    }
  }
  logger.error('ipc', 'Unhandled error', { correlationId, command, error: err })
  const isDb = typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE')
  return {
    ok: false,
    error: {
      code: isDb ? 'DATABASE_ERROR' : 'INTERNAL_ERROR',
      message: `The operation could not be completed. Reference: ${correlationId}`,
      correlationId
    }
  }
}

/**
 * Central command dispatcher: allow-list → payload validation → session/permission
 * gate → handler. Never returns raw exceptions to the renderer.
 */
export function createDispatcher(deps: DispatcherDeps) {
  const known = new Set(Object.keys(deps.commands))
  return async function dispatch(command: string, payload: unknown): Promise<Result<unknown>> {
    const correlationId = newCorrelationId()
    try {
      if (!known.has(command)) throw new AppError('UNKNOWN_COMMAND', 'Unknown command.')
      const def = deps.commands[command as DesktopCommandName] as CommandDefinition<CommandName>

      let actor: Actor | null = null
      if (def.auth !== 'public') {
        const session = deps.resolveSession()
        if (session.state === 'none') throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
        if (session.state === 'locked' && def.auth === 'session') {
          throw new AppError('SESSION_LOCKED', 'The session is locked. Enter your password to continue.')
        }
        actor = session.actor
      }

      const input = def.input.parse(payload) as never
      const data = await def.handler(input, { correlationId, actor })
      if (def.auth === 'session' && def.touch !== false) deps.touchSession()
      return { ok: true, data }
    } catch (err) {
      return toFailure(err, correlationId, deps.logger, command)
    }
  }
}
