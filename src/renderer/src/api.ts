import type { CommandMap, CommandName } from '@shared/api'
import type { AppErrorPayload, Result } from '@shared/errors'

/** Error thrown by `call` so components can show code-specific messages. */
export class ApiError extends Error {
  readonly code: AppErrorPayload['code']
  readonly correlationId: string
  readonly fieldErrors: Record<string, string>

  constructor(payload: AppErrorPayload) {
    super(payload.message)
    this.code = payload.code
    this.correlationId = payload.correlationId
    this.fieldErrors = payload.fieldErrors ?? {}
  }
}

type SessionListener = (code: 'SESSION_LOCKED' | 'NOT_AUTHENTICATED') => void
const sessionListeners = new Set<SessionListener>()

/** App shell subscribes so a lock or sign-out anywhere switches to the right screen. */
export function onSessionInterrupted(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

/** Invokes a command through the preload bridge; resolves with data or throws ApiError. */
export async function call<K extends CommandName>(
  command: K,
  ...args: CommandMap[K]['input'] extends void ? [] : [CommandMap[K]['input']]
): Promise<CommandMap[K]['output']> {
  const [group, method] = command.split('.') as [string, string]
  const fn = (window.api as unknown as Record<string, Record<string, (i?: unknown) => Promise<Result<unknown>>>>)[group]?.[method]
  if (!fn) throw new ApiError({ code: 'UNKNOWN_COMMAND', message: 'Unknown command.', correlationId: '-' })
  const result = await fn(args[0])
  if (!result.ok) {
    if (result.error.code === 'SESSION_LOCKED' || result.error.code === 'NOT_AUTHENTICATED') {
      sessionListeners.forEach((l) => l(result.error.code as 'SESSION_LOCKED' | 'NOT_AUTHENTICATED'))
    }
    throw new ApiError(result.error)
  }
  return result.data as CommandMap[K]['output']
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Check the application log for details.'
}

export const formatDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

export const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
