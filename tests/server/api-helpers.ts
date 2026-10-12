import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../server/src/app'
import { loadConfig, type ServerConfig } from '../../server/src/config'
import { newCorrelationId } from '../../server/src/core'
import { syncPermissionCatalog } from '../../server/src/services/foundation'
import { bootstrapOrganization } from '../../server/src/services/identity'
import { createTestDatabase, type TestDatabase } from './db-helpers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStorage } from '../../server/src/storage/storage'

export const ORIGIN = 'http://localhost:5173'
export const ADMIN = { username: 'admin', displayName: 'Admin User', password: 'Correct-Horse-1' }
export const SETUP = {
  organization: { legalName: 'Test BPO Pvt Ltd', displayName: 'Test BPO', baseCurrency: 'INR', timezone: 'Asia/Kolkata' },
  admin: ADMIN
}

export interface RpcResponse<T = unknown> {
  status: number
  body: { ok: true; data: T } | { ok: false; error: { code: string; message: string; correlationId: string; fieldErrors?: Record<string, string> } }
  cookie: string | undefined
  headers: Record<string, unknown>
}

export interface TestServer {
  app: FastifyInstance
  tdb: TestDatabase
  config: ServerConfig
  storage: LocalStorage
  storageRoot: string
  /** Calls an RPC command as a browser would (CSRF header + Origin), optionally with a session cookie. */
  rpc<T = unknown>(command: string, body?: unknown, opts?: { cookie?: string | undefined; headers?: Record<string, string> }): Promise<RpcResponse<T>>
  /** Signs in and returns the session cookie value. */
  login(username?: string, password?: string): Promise<string>
  close(): Promise<void>
}

export async function createTestServer(opts: { bootstrap?: boolean; env?: Record<string, string> } = {}): Promise<TestServer> {
  const tdb = await createTestDatabase()
  const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: tdb.url, PUBLIC_ORIGIN: ORIGIN, LOG_LEVEL: 'silent', ...opts.env })
  await syncPermissionCatalog(tdb.db)
  if (opts.bootstrap !== false) await bootstrapOrganization(tdb.db, SETUP, newCorrelationId())
  const storageRoot = mkdtempSync(join(tmpdir(), 'bpoam-docs-'))
  const storage = new LocalStorage(storageRoot)
  const app = await buildApp({ config, db: tdb.db, storage })

  const rpc: TestServer['rpc'] = async (command, body, o = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rpc/${command}`,
      headers: { 'content-type': 'application/json', 'x-bpoam-request': '1', origin: ORIGIN, ...(o.cookie ? { cookie: `${config.cookieName}=${o.cookie}` } : {}), ...o.headers },
      payload: JSON.stringify(body ?? null)
    })
    const set = res.cookies.find((c) => c.name === config.cookieName)
    return { status: res.statusCode, body: res.json(), cookie: set?.value, headers: res.headers as Record<string, unknown> }
  }
  return {
    app,
    tdb,
    config,
    storage,
    storageRoot,
    rpc,
    login: async (username = ADMIN.username, password = ADMIN.password) => {
      const r = await rpc('session.login', { username, password })
      if (!r.body.ok || !r.cookie) throw new Error(`login failed: ${JSON.stringify(r.body)}`)
      return r.cookie
    },
    close: async () => {
      await app.close()
      await tdb.drop()
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
}
