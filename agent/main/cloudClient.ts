import type { AssetListItem, OfflineLeaseView } from '@shared/api'

/**
 * Minimal, honest cloud client for the agent's controlled downloads: speaks the exact same
 * contract the browser client (`web/src/api.ts`) uses against the real `/api/v1/rpc/:command`
 * endpoint -- the same CSRF header, the same `{ ok, data | error }` envelope, the same session
 * cookie model. No endpoint is invented and no authorization is bypassed.
 *
 * W9.5 replaces the W9.4 organization-wide `assets.search` download with a work-package-scoped
 * one: the agent never claims which assets it wants. It asks the server for a specific lease's
 * assets (`leases.getScopedAssets`), and the server derives the actual authorized set from the
 * real lease/scope records -- a lease the caller doesn't own is rejected server-side (D50/D51-style
 * ownership check), so changing `leaseId` here can never fetch another device's leased inventory.
 */

const CSRF_HEADER = 'x-bpoam-request'

export class CloudClientError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

async function rpc<T>(baseUrl: string, command: string, payload: unknown, cookie: string | null): Promise<{ data: T; setCookie: string | null }> {
  const res = await fetch(`${baseUrl}/api/v1/rpc/${encodeURIComponent(command)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload ?? null)
  })
  const body = (await res.json().catch(() => null)) as Envelope<T> | null
  if (!body || !body.ok) throw new CloudClientError(body?.error?.message ?? `The server returned an unexpected response (HTTP ${res.status}).`, body?.error?.code ?? 'NETWORK_ERROR')
  // Only the name=value pair is kept; cookie attributes (HttpOnly, Secure, SameSite) are for the
  // browser's cookie jar, not meaningful to this plain HTTP client.
  const setCookie = res.headers.get('set-cookie')?.split(';')[0] ?? null
  return { data: body.data as T, setCookie }
}

/** Logs in exactly like the browser does (`session.login`); returns the session cookie to reuse. */
export async function cloudLogin(baseUrl: string, username: string, password: string): Promise<string> {
  const { setCookie } = await rpc<unknown>(baseUrl, 'session.login', { username, password }, null)
  if (!setCookie) throw new CloudClientError('Sign-in succeeded but the server did not return a session.', 'NOT_AUTHENTICATED')
  return setCookie
}

/** The real leases the authenticated user currently holds (`leases.manage`), i.e. their available work packages. */
export async function listMyLeases(baseUrl: string, cookie: string): Promise<OfflineLeaseView[]> {
  const { data } = await rpc<OfflineLeaseView[]>(baseUrl, 'leases.list', { mine: true }, cookie)
  return data
}

/** Downloads exactly one lease's authorized asset scope -- never a client-chosen asset list (`leases.getScopedAssets`). */
export async function fetchLeaseScopedAssets(baseUrl: string, cookie: string, leaseId: string): Promise<AssetListItem[]> {
  const { data } = await rpc<AssetListItem[]>(baseUrl, 'leases.getScopedAssets', { leaseId }, cookie)
  return data
}
