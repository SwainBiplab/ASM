import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '@shared/assets'
import { COMMAND_NAMES, WEB_ONLY_COMMAND_NAMES } from '@shared/api'
import type { ServerConfig } from './config'
import { newCorrelationId, type Logger } from './core'
import { resolveSession } from './auth/sessions'
import type { Db } from './db/sql'
import { schemaVersion } from './db/migrator'
import { LATEST_SCHEMA_VERSION } from './db/migrations'
import { buildCommands } from './rpc/commands'
import { createDispatcher, type HttpBridge } from './rpc/dispatcher'
import { getSettings, loadUserPermissions } from './services/foundation'
import { registerFileRoutes } from './routes/files'
import { LocalStorage, S3Storage, type DocumentStorage } from './storage/storage'

export interface AppDeps {
  config: ServerConfig
  db: Db
  /** Defaults to the configured driver; tests inject a temporary LocalStorage. */
  storage?: DocumentStorage
}

/** Header every state-changing request must carry; browsers can't add it cross-site without CORS. */
export const CSRF_HEADER = 'x-bpoam-request'

/**
 * Builds the API (not listening), so tests drive it with `app.inject()`.
 * Security: helmet CSP/HSTS, SameSite+HttpOnly cookies, CSRF header + Origin check, rate limits,
 * safe error envelopes. Authorization happens inside services for every command.
 */
export async function buildApp({ config, db, storage: injected }: AppDeps): Promise<FastifyInstance> {
  const storage =
    injected ??
    (config.STORAGE_DRIVER === 's3'
      ? new S3Storage({
          bucket: config.STORAGE_S3_BUCKET!,
          region: config.STORAGE_S3_REGION!,
          endpoint: config.STORAGE_S3_ENDPOINT,
          accessKeyId: config.STORAGE_S3_ACCESS_KEY_ID!,
          secretAccessKey: config.STORAGE_S3_SECRET_ACCESS_KEY!,
          forcePathStyle: config.STORAGE_S3_FORCE_PATH_STYLE
        })
      : new LocalStorage(config.STORAGE_LOCAL_ROOT))
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: () => newCorrelationId(),
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : { level: config.LOG_LEVEL, redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[redacted]' } }
  })
  const logger: Logger = {
    info: (o, m) => app.log.info(o, m),
    warn: (o, m) => app.log.warn(o, m),
    error: (o, m) => app.log.error(o, m)
  }

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    hsts: config.secureCookies ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false
  })
  await app.register(cookie)
  // Upload size limits are also enforced per route while streaming (D35).
  await app.register(multipart, { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 0, parts: 1 } })
  await app.register(rateLimit, {
    global: false,
    // Thrown by the plugin and rendered by the error handler below as a 429 envelope.
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.` })
  })

  // Never leak internals: unexpected errors become a generic envelope with a reference.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500
    if (status >= 500) req.log.error({ err }, 'Request failed')
    const message = status === 429 ? err.message : status < 500 ? 'The request could not be processed.' : `The operation could not be completed. Reference: ${req.id}`
    const code = status === 429 ? 'RATE_LIMITED' : status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR'
    void reply.status(status).send({ ok: false, error: { code, message, correlationId: String(req.id) } })
  })

  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/' }
  async function resolveActor(token: string | undefined) {
    const s = await resolveSession(db, token, async (orgId) => (await getSettings(db, orgId)).idleTimeoutMinutes)
    if (!s) return null
    // Permissions are re-read on every request, so role changes apply immediately.
    return { sessionHash: s.idHash, actor: { userId: s.userId, organizationId: s.organizationId, permissions: await loadUserPermissions(db, s.organizationId, s.userId) } }
  }
  const dispatch = createDispatcher({
    db,
    commands: buildCommands(config, storage),
    logger,
    resolveSession: resolveActor
  })

  const allowedOrigin = new URL(config.PUBLIC_ORIGIN).origin
  function csrfRejected(req: FastifyRequest): string | null {
    if (req.headers[CSRF_HEADER] !== '1') return 'Missing request header.'
    const origin = req.headers.origin
    if (origin !== undefined && origin !== allowedOrigin) return 'Cross-origin request rejected.'
    return null
  }

  const known = new Set<string>([...COMMAND_NAMES, ...WEB_ONLY_COMMAND_NAMES])
  app.post<{ Params: { command: string } }>(
    '/api/v1/rpc/:command',
    {
      config: {
        rateLimit: {
          // Stricter per-IP budget for login attempts; per-account lockout applies on top.
          max: (req: FastifyRequest) => ((req.params as { command?: string }).command === 'session.login' ? config.LOGIN_RATE_LIMIT_PER_MINUTE : config.RATE_LIMIT_PER_MINUTE),
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => `${req.ip}|${(req.params as { command?: string }).command === 'session.login' ? 'login' : 'api'}`
        }
      }
    },
    async (req, reply: FastifyReply) => {
      const correlationId = String(req.id)
      const rejected = csrfRejected(req)
      if (rejected) return reply.status(403).send({ ok: false, error: { code: 'FORBIDDEN_SENDER', message: rejected, correlationId } })
      const command = req.params.command
      if (!known.has(command)) return reply.status(404).send({ ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command.', correlationId } })
      const http: HttpBridge = {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        setSessionCookie: (token, expires) => void reply.setCookie(config.cookieName, token, { ...cookieOptions, expires }),
        clearSessionCookie: () => void reply.clearCookie(config.cookieName, cookieOptions)
      }
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined
      const outcome = await dispatch(command, req.body === null ? undefined : req.body, { token: req.cookies[config.cookieName], http, correlationId, idempotencyKey })
      reply.header('cache-control', 'no-store')
      return reply.status(outcome.status).send(outcome.body)
    }
  )

  registerFileRoutes(app, {
    db,
    storage,
    logger,
    csrfRejected,
    authenticate: async (req) => (await resolveActor(req.cookies[config.cookieName]))?.actor ?? null
  })

  // The browser application (W3) is served from the same origin, so cookies, the Origin check
  // and the CSP `'self'` sources all apply unchanged. Unknown /api paths still return JSON 404s.
  if (config.WEB_ROOT) {
    const root = resolve(config.WEB_ROOT)
    if (!existsSync(resolve(root, 'index.html'))) throw new Error(`WEB_ROOT has no index.html: ${root}`)
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      index: ['index.html'],
      dotfiles: 'deny',
      // Hashed asset files are immutable; index.html must always be revalidated.
      setHeaders: (reply, path) => void reply.header('cache-control', /[\/]assets[\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache')
    })
  }
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.', correlationId: String(req.id) } })
  )

  app.get('/api/health/live', async () => ({ status: 'ok' }))
  app.get('/api/health/ready', async (_req, reply) => {
    try {
      const version = await schemaVersion(db)
      if (version !== LATEST_SCHEMA_VERSION) return reply.status(503).send({ status: 'migrations_pending', schemaVersion: version })
      return { status: 'ready', schemaVersion: version }
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' })
    }
  })

  return app
}
