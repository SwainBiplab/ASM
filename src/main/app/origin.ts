import { resolve, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/** Production CSP: only bundled scripts/styles; no remote content, no inline script. */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

/** Dev CSP additionally allows Vite's HMR client and React Refresh preamble. */
export const DEVELOPMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join('; ')

/** Resolves a request path inside the renderer bundle, refusing traversal outside it. */
export function resolveBundlePath(rendererDir: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const root = resolve(rendererDir)
  const target = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded))
  return target === root || target.startsWith(root + sep) ? target : null
}

/** Returns true when a frame URL belongs to the application renderer. */
export function isTrustedOrigin(frameUrl: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  if (!frameUrl) return false
  try {
    // Node's URL reports origin "null" for custom schemes such as app://, so build it explicitly.
    const url = new URL(frameUrl)
    return allowedOrigins.has(`${url.protocol}//${url.host}`)
  } catch {
    return false
  }
}
