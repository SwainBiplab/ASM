/** Stable application error codes shared across the IPC boundary (TAS §3.3). */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'PERMISSION_DENIED',
  'NOT_AUTHENTICATED',
  'SESSION_LOCKED',
  'NOT_FOUND',
  'STATE_CONFLICT',
  'DUPLICATE_RECORD',
  'DATABASE_ERROR',
  'BACKUP_FAILED',
  'RESTORE_FAILED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN_SENDER',
  'UNKNOWN_COMMAND',
  'RATE_LIMITED',
  'INTERNAL_ERROR'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface AppErrorPayload {
  code: ErrorCode
  message: string
  correlationId: string
  /** Field-level validation messages keyed by dotted field path. */
  fieldErrors?: Record<string, string>
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload }
