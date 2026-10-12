import type { CommandMap, CommandName } from '@shared/api'
import type { AppErrorPayload, ErrorCode } from '@shared/errors'

/**
 * Typed HTTP client for the web API (`/api/v1`, DECISIONS D33). The session lives in an
 * HttpOnly cookie that scripts cannot read; nothing session-related is stored in Web Storage.
 * Every request carries the CSRF header the server requires; mutations carry an Idempotency-Key.
 */

/** Same-origin by default; a separate API origin is a build-time setting (never a secret). */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''
const CSRF_HEADERS = { 'x-bpoam-request': '1' } as const

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR'

/** Error thrown by `call` so components can show code-specific messages. */
export class ApiError extends Error {
  readonly code: ClientErrorCode
  readonly correlationId: string
  readonly fieldErrors: Record<string, string>
  readonly status: number

  constructor(payload: Omit<AppErrorPayload, 'code'> & { code: ClientErrorCode }, status = 0) {
    super(payload.message)
    this.code = payload.code
    this.correlationId = payload.correlationId
    this.fieldErrors = payload.fieldErrors ?? {}
    this.status = status
  }
}

type SessionListener = (code: 'NOT_AUTHENTICATED') => void
const sessionListeners = new Set<SessionListener>()

/** App shell subscribes so an expired or revoked session anywhere returns to sign-in. */
export function onSessionInterrupted(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

/** Commands that only read; everything else gets a fresh Idempotency-Key per user action (D36). */
const READ_ONLY = /\.(list|get|search|lookup|getCurrent|getSummary|getStartupState|getCodeConfig|generateLabels|touch|importPreview)$/

const newKey = (): string => crypto.randomUUID()

/**
 * Commands the server makes retry-safe (idempotency 'required', D36). If the connection drops
 * before the response arrives, the client retries once with the same key; the server replays
 * the original outcome instead of running the change twice.
 */
const RETRY_SAFE = new Set<string>(['assets.create', 'employees.importCommit'])

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...init })
  } catch {
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: 'The server could not be reached. Check your connection; if you were saving, check whether the change was saved before trying again.',
      correlationId: '-'
    })
  }
}

async function sendWithRetry(path: string, init: RequestInit, retrySafe: boolean): Promise<Response> {
  try {
    return await send(path, init)
  } catch (err) {
    if (!retrySafe || !(err instanceof ApiError) || err.code !== 'NETWORK_ERROR') throw err
    await new Promise((r) => setTimeout(r, 1000))
    return send(path, init)
  }
}

/** Parses the `{ ok, data | error }` envelope; non-JSON responses become a safe generic error. */
async function unwrap<T>(res: Response): Promise<T> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const env = body as { ok?: boolean; data?: unknown; error?: AppErrorPayload } | null
  if (env && env.ok === true) return env.data as T
  const error: AppErrorPayload = env?.error ?? {
    code: res.status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
    message: res.status >= 500 ? 'The server could not complete the request. Try again shortly.' : 'The request could not be processed.',
    correlationId: res.headers.get('x-request-id') ?? '-'
  }
  if (error.code === 'NOT_AUTHENTICATED') sessionListeners.forEach((l) => l('NOT_AUTHENTICATED'))
  throw new ApiError(error, res.status)
}

/**
 * The typed seam a screen's RPC calls actually go through (W9.6, DECISIONS.md D48/D51's adapter
 * plan). `call` below always delegates to whichever implementation is currently installed; the
 * browser's own HTTP implementation (`browserCall`) is installed by default and is exactly the
 * same code that ran before this refactor -- nothing about the web app's behavior changes unless
 * something explicitly calls `setCallTransport`. The desktop agent is the only other installer
 * today (`agent/renderer-src/desktopApiAdapter.ts`), swapped in once at its own entry point, never
 * from within a shared component.
 */
export type CallTransport = <K extends CommandName>(command: K, ...args: CommandMap[K]['input'] extends void ? [] : [CommandMap[K]['input']]) => Promise<CommandMap[K]['output']>

async function browserCall<K extends CommandName>(
  command: K,
  ...args: CommandMap[K]['input'] extends void ? [] : [CommandMap[K]['input']]
): Promise<CommandMap[K]['output']> {
  const headers: Record<string, string> = { ...CSRF_HEADERS }
  if (args[0] !== undefined) headers['content-type'] = 'application/json'
  if (!READ_ONLY.test(command)) headers['idempotency-key'] = newKey()
  const init: RequestInit = { method: 'POST', headers, ...(args[0] !== undefined ? { body: JSON.stringify(args[0]) } : {}) }
  const path = `/api/v1/rpc/${encodeURIComponent(command)}`
  return unwrap<CommandMap[K]['output']>(await sendWithRetry(path, init, RETRY_SAFE.has(command)))
}

let activeTransport: CallTransport = browserCall

/** Installs a non-browser transport (the desktop agent's local/offline adapter). Returns the previous one, mainly so tests can restore it. */
export function setCallTransport(transport: CallTransport): CallTransport {
  const previous = activeTransport
  activeTransport = transport
  return previous
}

export function resetCallTransport(): void {
  activeTransport = browserCall
}

/** Invokes a command through whichever transport is installed; resolves with data or throws ApiError. */
export async function call<K extends CommandName>(
  command: K,
  ...args: CommandMap[K]['input'] extends void ? [] : [CommandMap[K]['input']]
): Promise<CommandMap[K]['output']> {
  return activeTransport(command, ...args)
}

/** Uploads one file as multipart/form-data. The server picks the storage location (D35). */
export async function uploadFile<T>(path: string, file: File, query: Record<string, string> = {}): Promise<T> {
  const form = new FormData()
  form.append('file', file, file.name)
  const qs = new URLSearchParams(query).toString()
  // Document uploads are retry-safe on the server (same key + same file → replayed result).
  const res = await sendWithRetry(`${path}${qs ? `?${qs}` : ''}`, { method: 'POST', headers: { ...CSRF_HEADERS, 'idempotency-key': newKey() }, body: form }, true)
  return unwrap<T>(res)
}

/** URL of an authorized GET resource (cookie-authenticated, same origin). */
export function apiUrl(path: string, query: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')).toString()
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`
}

/**
 * Fetches an authorized file and saves it through the browser. Errors (permission, missing file)
 * arrive as the normal JSON envelope and are thrown as ApiError instead of navigating away.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<string> {
  const res = await send(url.slice(API_BASE.length), { method: 'GET' })
  if (!res.ok) return unwrap<never>(res)
  const blob = await res.blob()
  const name = fileNameFrom(res.headers.get('content-disposition')) ?? fallbackName
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 30_000)
  return name
}

function fileNameFrom(disposition: string | null): string | null {
  if (!disposition) return null
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      return decodeURIComponent(star[1]!)
    } catch {
      /* fall through to the ASCII name */
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Reload the page and try again.'
}

export const formatDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

export const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
