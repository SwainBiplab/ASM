import { createHash } from 'node:crypto'
import { ZodError, type ZodType } from 'zod'
import type { CommandMap, CommandName } from '@shared/api'
import type { ErrorCode, Result } from '@shared/errors'
import { AppError, isAppError, type Actor, type Logger } from '../core'
import { pgErrorCode, scopedDb, type Db } from '../db/sql'

/** Bridge from a command handler to the HTTP layer (cookies, client metadata). */
export interface HttpBridge {
  ip: string | null
  userAgent: string | null
  setSessionCookie(token: string, expires: Date): void
  clearSessionCookie(): void
}

export interface HandlerContext {
  correlationId: string
  actor: Actor | null
  sessionHash: string | null
  http: HttpBridge
  /** Database handle for this call; inside an idempotent call it is bound to that call's transaction. */
  db: Db
}

/** public: no session needed (startup state, login). session: requires a valid session. */
export type AuthMode = 'public' | 'session'

export interface CommandDefinition<K extends CommandName> {
  input: ZodType
  /** Response schema (D34): strips undeclared fields; a mismatch never reaches the client. */
  output: ZodType<CommandMap[K]['output']>
  auth: AuthMode
  /** Idempotency-Key handling (D36). Omitted = not applicable (reads). */
  idempotency?: 'required' | 'optional'
  handler: (input: CommandMap[K]['input'], ctx: HandlerContext) => Promise<CommandMap[K]['output']>
}

export { SERVER_COMMANDS, type ServerCommandName } from './commandNames'
import { SERVER_COMMANDS, type ServerCommandName } from './commandNames'
export type ServerCommandTable = { [K in ServerCommandName]: CommandDefinition<K> }

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  NOT_AUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  PERMISSION_DENIED: 403,
  FORBIDDEN_SENDER: 403,
  ACCOUNT_LOCKED: 423,
  NOT_FOUND: 404,
  UNKNOWN_COMMAND: 404,
  STATE_CONFLICT: 409,
  DUPLICATE_RECORD: 409,
  RATE_LIMITED: 429
}

export interface DispatchOutcome {
  status: number
  body: Result<unknown>
}

export function failure(code: ErrorCode, message: string, correlationId: string, fieldErrors?: Record<string, string>): DispatchOutcome {
  return { status: HTTP_STATUS[code] ?? 500, body: { ok: false, error: { code, message, correlationId, ...(fieldErrors ? { fieldErrors } : {}) } } }
}

/** Maps any thrown value to a safe response: stable code, correlation ID, never a stack trace. */
export function toFailure(err: unknown, correlationId: string, logger: Logger, command: string): DispatchOutcome {
  if (isAppError(err)) return failure(err.code, err.message, correlationId, err.fieldErrors)
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of err.issues) fieldErrors[issue.path.join('.') || '_'] ??= issue.message
    return failure('VALIDATION_ERROR', 'Some fields are invalid.', correlationId, fieldErrors)
  }
  const pg = pgErrorCode(err)
  if (pg === '23505') return failure('DUPLICATE_RECORD', 'A record with the same identifier already exists.', correlationId)
  if (pg === '23503' || pg === '23514' || pg === '23P01') {
    logger.warn({ correlationId, command, pg }, 'Constraint violation')
    return failure('STATE_CONFLICT', 'The change conflicts with existing records.', correlationId)
  }
  if (pg === '40001' || pg === '40P01') return failure('STATE_CONFLICT', 'Another change happened at the same time. Please try again.', correlationId)
  logger.error({ correlationId, command, err }, 'Unhandled error')
  return failure(pg ? 'DATABASE_ERROR' : 'INTERNAL_ERROR', `The operation could not be completed. Reference: ${correlationId}`, correlationId)
}

// ---------------------------------------------------------------- idempotency (D36)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_TTL_HOURS = 24

export const requestHash = (command: string, payload: unknown): string =>
  createHash('sha256').update(`${command}\n${JSON.stringify(payload ?? null)}`, 'utf8').digest('hex')

export interface IdempotencyScope {
  db: Db
  actor: Actor
  key: string
  command: string
  hash: string
}

/**
 * Runs `fn` exactly once per (organization, user, key): the key row, the business writes and
 * the stored response commit together. A concurrent duplicate blocks on the key's primary key
 * and then replays. 5xx outcomes roll back everything so the client can retry with the same key.
 */
export async function withIdempotency(scope: IdempotencyScope, correlationId: string, fn: (db: Db) => Promise<DispatchOutcome>): Promise<DispatchOutcome> {
  if (!UUID_RE.test(scope.key)) return failure('VALIDATION_ERROR', 'Idempotency-Key must be a UUID.', correlationId)
  const { organizationId, userId } = scope.actor
  const client = await scope.db.pool.connect()
  try {
    await client.query('BEGIN')
    if (Math.random() < 0.02) await client.query('DELETE FROM idempotency_keys WHERE expires_at < now()')
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (organization_id, user_id, key, command, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) ON CONFLICT DO NOTHING RETURNING 1`,
      [organizationId, userId, scope.key, scope.command, scope.hash, IDEMPOTENCY_TTL_HOURS]
    )
    if (inserted.rowCount === 0) {
      const prior = (
        await client.query<{ command: string; request_hash: string; response_status: number | null; response_body: Result<unknown> | null }>(
          'SELECT command, request_hash, response_status, response_body FROM idempotency_keys WHERE organization_id = $1 AND user_id = $2 AND key = $3',
          [organizationId, userId, scope.key]
        )
      ).rows[0]
      await client.query('COMMIT')
      if (!prior || prior.command !== scope.command || prior.request_hash !== scope.hash) {
        return failure('STATE_CONFLICT', 'This Idempotency-Key was already used for a different request.', correlationId)
      }
      if (prior.response_status === null || !prior.response_body) return failure('STATE_CONFLICT', 'The original request is still being processed.', correlationId)
      return { status: prior.response_status, body: prior.response_body }
    }
    const outcome = await fn(scopedDb(client, scope.db))
    if (outcome.status >= 500) {
      await client.query('ROLLBACK')
      return outcome
    }
    await client.query('UPDATE idempotency_keys SET response_status = $4, response_body = $5 WHERE organization_id = $1 AND user_id = $2 AND key = $3', [
      organizationId, userId, scope.key, outcome.status, JSON.stringify(outcome.body)
    ])
    await client.query('COMMIT')
    return outcome
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------- dispatcher

export interface DispatcherDeps {
  db: Db
  commands: ServerCommandTable
  resolveSession: (token: string | undefined) => Promise<{ actor: Actor; sessionHash: string } | null>
  logger: Logger
}

export interface DispatchContext {
  token: string | undefined
  http: HttpBridge
  correlationId: string
  idempotencyKey?: string | undefined
}

/** allow-list → session → input schema → handler (services authorize) → output schema. */
export function createDispatcher(deps: DispatcherDeps) {
  const known = new Set<string>(SERVER_COMMANDS)
  return async function dispatch(command: string, payload: unknown, ctx: DispatchContext): Promise<DispatchOutcome> {
    const { correlationId } = ctx
    try {
      if (!known.has(command)) throw new AppError('UNKNOWN_COMMAND', 'Unknown command.')
      const def = deps.commands[command as ServerCommandName] as unknown as CommandDefinition<CommandName>
      const session = await deps.resolveSession(ctx.token)
      if (def.auth === 'session' && !session) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
      const input = def.input.parse(payload) as never

      const run = async (db: Db): Promise<DispatchOutcome> => {
        try {
          const data = await def.handler(input, { correlationId, actor: session?.actor ?? null, sessionHash: session?.sessionHash ?? null, http: ctx.http, db })
          const parsed = def.output.safeParse(data)
          if (!parsed.success) {
            deps.logger.error({ correlationId, command, issues: parsed.error.issues.slice(0, 5) }, 'Response failed its output schema')
            return failure('INTERNAL_ERROR', `The operation could not be completed. Reference: ${correlationId}`, correlationId)
          }
          return { status: 200, body: { ok: true, data: parsed.data } }
        } catch (err) {
          return toFailure(err, correlationId, deps.logger, command)
        }
      }

      if (def.idempotency && session) {
        if (!ctx.idempotencyKey) {
          if (def.idempotency === 'required') throw new AppError('VALIDATION_ERROR', 'This request needs an Idempotency-Key header so retries cannot run it twice.')
        } else {
          return await withIdempotency({ db: deps.db, actor: session.actor, key: ctx.idempotencyKey, command, hash: requestHash(command, payload) }, correlationId, run)
        }
      }
      return await run(deps.db)
    } catch (err) {
      return toFailure(err, correlationId, deps.logger, command)
    }
  }
}
