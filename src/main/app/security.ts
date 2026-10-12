import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { app, protocol, session } from 'electron'
import {
  APP_HOST,
  APP_SCHEME,
  DEVELOPMENT_CSP,
  PRODUCTION_CSP,
  isTrustedOrigin,
  resolveBundlePath
} from './origin'

export { APP_ORIGIN } from './origin'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

/** Must run before `app.ready`. */
export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}


/** Serves the built renderer from app://bundle with security headers. */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const file = url.host === APP_HOST ? resolveBundlePath(rendererDir, url.pathname) : null
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': PRODUCTION_CSP,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}


/** Global hardening for every webContents and the default session (TAS §3.2). */
export function hardenApplication(allowedOrigins: ReadonlySet<string>, devServerUrl: string | undefined): void {
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

  if (devServerUrl) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEVELOPMENT_CSP] } })
    })
  }
}
