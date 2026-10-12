import { randomBytes, randomUUID } from 'node:crypto'
import type { ErrorCode } from '@shared/errors'
import type { PermissionKey } from '@shared/permissions'

/** Error raised by services; mapped to a stable code and HTTP status at the API boundary. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly fieldErrors?: Record<string, string>
  constructor(code: ErrorCode, message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (fieldErrors) this.fieldErrors = fieldErrors
  }
}
export const isAppError = (v: unknown): v is AppError => v instanceof AppError

export const newId = (): string => randomUUID()
export const newCorrelationId = (): string => randomBytes(6).toString('hex')

/** Authenticated caller. The organization always comes from the session, never from input. */
export interface Actor {
  userId: string
  organizationId: string
  permissions: ReadonlySet<PermissionKey>
}

export interface OpContext {
  correlationId: string
  actor: Actor
  ip: string | null
}

export function assertPermission(granted: ReadonlySet<PermissionKey>, required: PermissionKey): void {
  if (!granted.has(required)) throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
}

export function assertAnyPermission(ctx: OpContext, keys: readonly PermissionKey[]): void {
  if (!keys.some((k) => ctx.actor.permissions.has(k))) throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
}

export interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}
export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

const SENSITIVE_KEY = /pass(word)?|secret|token|hash|credential|cookie/i
/** Redacts secrets before audit summaries or logs are written. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
    return out
  }
  return value
}
