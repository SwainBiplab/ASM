import type { ErrorCode } from '@shared/errors'

/** Error raised by services; mapped to a stable code at the IPC boundary. */
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

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
