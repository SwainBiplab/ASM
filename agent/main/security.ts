import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { app, protocol, session } from 'electron'
import { AGENT_APP_HOST, AGENT_APP_SCHEME, PRODUCTION_CSP, isTrustedOrigin, resolveBundlePath } from './origin'

export { AGENT_APP_ORIGIN, buildWebPreferences } from './origin'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

/** Must run before `app.ready`. */
export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: AGENT_APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Serves the placeholder renderer from bpoam-agent://local with security headers. No bundler: phase 1's renderer is static, hand-written markup, not a built React app. */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(AGENT_APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const file = url.host === AGENT_APP_HOST ? resolveBundlePath(rendererDir, url.pathname) : null
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, { status: 200, headers: { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': PRODUCTION_CSP, 'X-Content-Type-Options': 'nosniff' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Global hardening for every webContents and the default session, same posture as the prototype's. */
export function hardenApplication(allowedOrigins: ReadonlySet<string>): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const blockForeign = (event: Electron.Event, url: string): void => {
      if (!isTrustedOrigin(url, allowedOrigins)) event.preventDefault()
    }
    contents.on('will-navigate', blockForeign)
    contents.on('will-redirect', blockForeign)
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
}
