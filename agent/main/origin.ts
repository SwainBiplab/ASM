import { resolve, sep } from 'node:path'
import type { WebPreferences } from 'electron'

/**
 * New, standalone constants/helpers for the agent's own privileged scheme and CSP -- same proven
 * shape as `src/main/app/origin.ts`, not imported from it, so the agent has no runtime dependency
 * on the frozen prototype (CLAUDE.md: reuse the *pattern*, not the prototype's own code).
 */
export const AGENT_APP_SCHEME = 'bpoam-agent'
export const AGENT_APP_HOST = 'local'
export const AGENT_APP_ORIGIN = `${AGENT_APP_SCHEME}://${AGENT_APP_HOST}`

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

/** Returns true when a frame URL belongs to the agent's own renderer origin. */
export function isTrustedOrigin(frameUrl: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  if (!frameUrl) return false
  try {
    const url = new URL(frameUrl)
    return allowedOrigins.has(`${url.protocol}//${url.host}`)
  } catch {
    return false
  }
}

/**
 * The agent's Electron security posture (W9.3 phase 1), following the same verified pattern as
 * `src/main/app/security.ts`/`src/main/index.ts`: context isolation on, Node integration off,
 * sandbox on, no remote content. Only `WebPreferences`' TYPE is imported (erased at compile time,
 * no runtime dependency on the `electron` module), so this is safely unit-testable under plain
 * Node/vitest -- the actual window-creation and process-hardening wiring in `security.ts` does need
 * the real `electron` module and is exercised by a future end-to-end test instead, once there is a
 * renderer worth testing, the same way the prototype's own `foundation.e2e.ts` is its real proof.
 */
export function buildWebPreferences(preloadPath: string, devToolsAllowed: boolean): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
    devTools: devToolsAllowed
  }
}
