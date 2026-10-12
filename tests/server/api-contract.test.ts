import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { silentLogger } from '../../server/src/core'
import { buildCommands } from '../../server/src/rpc/commands'
import { createDispatcher, type HttpBridge, type ServerCommandTable } from '../../server/src/rpc/dispatcher'
import { nullOutput } from '../../server/src/rpc/responses'
import { loadUserPermissions } from '../../server/src/services/foundation'
import { ORIGIN, createTestServer, type TestServer } from './api-helpers'

const servers: TestServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})
const server = async () => {
  const s = await createTestServer()
  servers.push(s)
  return s
}
const STAFF = { username: 'staff.one', displayName: 'Staff One', password: 'Staff-Pass-123', roleKeys: ['auditor'] }
const http: HttpBridge = { ip: '127.0.0.1', userAgent: 'test', setSessionCookie: () => undefined, clearSessionCookie: () => undefined }

/** Dispatcher with selected commands replaced, acting as the bootstrapped Super Admin. */
async function dispatcherWith(s: TestServer, overrides: Partial<ServerCommandTable>) {
  const admin = (await s.tdb.db.one<{ id: string; organization_id: string }>("SELECT id, organization_id FROM users WHERE username = 'admin'"))!
  const actor = { userId: admin.id, organizationId: admin.organization_id, permissions: await loadUserPermissions(s.tdb.db, admin.organization_id, admin.id) }
  const dispatch = createDispatcher({
    db: s.tdb.db,
    commands: { ...buildCommands(s.config, s.storage), ...overrides } as ServerCommandTable,
    logger: silentLogger,
    resolveSession: async () => ({ actor, sessionHash: 'x'.repeat(64) })
  })
  return (command: string, payload: unknown, idempotencyKey?: string) => dispatch(command, payload, { token: 't', http, correlationId: 'c0ffee', idempotencyKey })
}

describe('API versioning', () => {
  it('serves RPC only under /api/v1', async () => {
    const s = await server()
    const old = await s.app.inject({ method: 'POST', url: '/api/rpc/system.getStartupState', headers: { 'content-type': 'application/json', 'x-bpoam-request': '1', origin: ORIGIN }, payload: 'null' })
    expect(old.statusCode).toBe(404)
    expect((await s.rpc('system.getStartupState')).status).toBe(200)
  })
})

describe('response schemas', () => {
  it('strips fields that are not part of the response contract', async () => {
    const s = await server()
    const dispatch = await dispatcherWith(s, {
      'users.list': {
        input: z.undefined(),
        output: buildCommands(s.config, s.storage)['users.list'].output,
        auth: 'session',
        handler: async () =>
          [{ id: randomUUID(), username: 'u', displayName: 'U', isActive: true, mustChangePassword: false, lastLoginAt: null, roleKeys: [], createdAt: new Date().toISOString(), passwordHash: 'scrypt$secret', organizationId: randomUUID() }] as never
      }
    })
    const r = await dispatch('users.list', undefined)
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|scrypt|organizationId/)
  })

  it('never returns data that fails its output schema', async () => {
    const s = await server()
    const dispatch = await dispatcherWith(s, {
      'session.touch': { input: z.undefined(), output: nullOutput, auth: 'session', handler: async () => ({ secret: 'leak' }) as never }
    })
    const r = await dispatch('session.touch', undefined)
    expect(r).toMatchObject({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR' } } })
    expect(JSON.stringify(r.body)).not.toContain('leak')
  })
})

describe('idempotency', () => {
  it('replays the original response for a retried request and creates one record', async () => {
    const s = await server()
    const cookie = await s.login()
    const key = randomUUID()
    const first = await s.rpc<{ id: string }>('users.create', STAFF, { cookie, headers: { 'idempotency-key': key } })
    const second = await s.rpc<{ id: string }>('users.create', STAFF, { cookie, headers: { 'idempotency-key': key } })
    expect(first.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect((await s.tdb.db.one<{ n: number }>("SELECT count(*) AS n FROM users WHERE username = 'staff.one'"))!.n).toBe(1)
    expect((await s.tdb.db.one<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE event_type = 'user.created'"))!.n).toBe(1)
  })

  it('handles concurrent duplicates without a second transaction', async () => {
    const s = await server()
    const cookie = await s.login()
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 5 }, () => s.rpc<{ id: string }>('users.create', STAFF, { cookie, headers: { 'idempotency-key': key } })))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(new Set(results.map((r) => (r.body.ok ? r.body.data.id : '')))).toEqual(new Set([results[0]!.body.ok ? results[0]!.body.data.id : '']))
    expect((await s.tdb.db.one<{ n: number }>("SELECT count(*) AS n FROM users WHERE username = 'staff.one'"))!.n).toBe(1)
  })

  it('rejects a key reused for a different request and malformed keys', async () => {
    const s = await server()
    const cookie = await s.login()
    const key = randomUUID()
    await s.rpc('users.create', STAFF, { cookie, headers: { 'idempotency-key': key } })
    expect((await s.rpc('users.create', { ...STAFF, username: 'other.user' }, { cookie, headers: { 'idempotency-key': key } })).status).toBe(409)
    expect((await s.rpc('users.create', STAFF, { cookie, headers: { 'idempotency-key': 'not-a-uuid' } })).status).toBe(400)
  })

  it('replays business errors but rolls back unexpected failures so a retry can succeed', async () => {
    const s = await server()
    const cookie = await s.login()
    const dupKey = randomUUID()
    await s.rpc('users.create', STAFF, { cookie })
    const dupe1 = await s.rpc('users.create', STAFF, { cookie, headers: { 'idempotency-key': dupKey } })
    const dupe2 = await s.rpc('users.create', STAFF, { cookie, headers: { 'idempotency-key': dupKey } })
    expect(dupe1.status).toBe(409)
    expect(dupe2.body).toEqual(dupe1.body)

    let calls = 0
    const dispatch = await dispatcherWith(s, {
      'users.create': {
        ...buildCommands(s.config, s.storage)['users.create'],
        handler: async (input, ctx) => {
          calls++
          await ctx.db.exec("INSERT INTO app_settings (organization_id, key, value) SELECT organization_id, 'probe', '1' FROM users WHERE username = 'admin'")
          if (calls === 1) throw new Error('simulated crash after a write')
          return buildCommands(s.config, s.storage)['users.create'].handler(input, ctx)
        }
      }
    })
    const key = randomUUID()
    const input = { ...STAFF, username: 'retry.user' }
    expect((await dispatch('users.create', input, key)).status).toBe(500)
    expect((await s.tdb.db.one<{ n: number }>("SELECT count(*) AS n FROM app_settings WHERE key = 'probe'"))!.n).toBe(0)
    const retried = await dispatch('users.create', input, key)
    expect(retried.status).toBe(200)
    expect(calls).toBe(2)
  })
})
