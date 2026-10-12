import { randomUUID } from 'node:crypto'
import type { CommandMap, CommandName } from '../../src/shared/api'
import type { Result } from '../../src/shared/errors'
import { ADMIN, ORIGIN, createTestServer, type TestServer } from './api-helpers'

/**
 * Session-bound client mirroring the prototype tests' `ok`/`call` style over the real HTTP API.
 * Every call carries a fresh Idempotency-Key, so commands that require one work as a browser would.
 */
export interface ApiSession {
  s: TestServer
  cookie: string
  call<K extends CommandName>(command: K, payload?: CommandMap[K]['input']): Promise<Result<CommandMap[K]['output']>>
  ok<K extends CommandName>(command: K, payload?: CommandMap[K]['input']): Promise<CommandMap[K]['output']>
  /** Signs in as a newly created user holding the given roles (admin creates the account). */
  becomeNewUser(username: string, roleKeys: string[]): Promise<void>
  becomeAdmin(): Promise<void>
  upload(url: string, file: { name: string; content: string | Uint8Array; type?: string }, headers?: Record<string, string>): Promise<{ status: number; body: Result<unknown> }>
  get(url: string): Promise<{ status: number; headers: Record<string, unknown>; raw: Buffer }>
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

export async function createApiSession(opts: { env?: Record<string, string> } = {}): Promise<ApiSession> {
  const s = await createTestServer({ env: opts.env })
  let cookie = await s.login()
  const call = (async (command: string, payload?: unknown) => {
    const r = await s.rpc(command, payload, { cookie, headers: { 'idempotency-key': randomUUID() } })
    return r.body
  }) as ApiSession['call']
  const ok = (async (command: string, payload?: unknown) => {
    const r = await call(command as CommandName, payload as never)
    if (!r.ok) throw new Error(`${command} failed: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.fieldErrors ?? {})}`)
    return r.data
  }) as ApiSession['ok']

  const session: ApiSession = {
    s,
    get cookie() {
      return cookie
    },
    call,
    ok,
    async becomeNewUser(username, roleKeys) {
      cookie = await s.login()
      await ok('users.create', { username, displayName: username, password: 'Test-Password-1', roleKeys })
      cookie = await s.login(username, 'Test-Password-1')
    },
    async becomeAdmin() {
      cookie = await s.login(ADMIN.username, ADMIN.password)
    },
    async upload(url, file, headers = {}) {
      const boundary = `----bpoam${randomUUID().replace(/-/g, '')}`
      const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content)
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8'
      )
      const payload = Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')])
      const res = await s.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-bpoam-request': '1', origin: ORIGIN, cookie: `${s.config.cookieName}=${cookie}`, ...headers },
        payload
      })
      return { status: res.statusCode, body: res.json() }
    },
    async get(url) {
      const res = await s.app.inject({ method: 'GET', url, headers: { cookie: `${s.config.cookieName}=${cookie}` } })
      return { status: res.statusCode, headers: res.headers as Record<string, unknown>, raw: res.rawPayload }
    },
    sql: (query, params = []) => s.tdb.db.many(query, params),
    close: () => s.close()
  }
  return session
}

/** Uploads a CSV through the real import route and returns the preview. */
export async function uploadImport(a: ApiSession, content: string | Uint8Array, name = 'employees.csv') {
  const r = await a.upload('/api/v1/uploads/employee-import', { name, content, type: 'text/csv' })
  if (!r.body.ok) throw new Error(`import upload failed: ${JSON.stringify(r.body)}`)
  return r.body.data as CommandMap['employees.importPreview']['output']
}
