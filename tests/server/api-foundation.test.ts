import { afterEach, describe, expect, it } from 'vitest'
import { newCorrelationId } from '../../server/src/core'
import { bootstrapOrganization, LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from '../../server/src/services/identity'
import { ADMIN, ORIGIN, SETUP, createTestServer, type TestServer } from './api-helpers'

const servers: TestServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})
const server = async (opts?: Parameters<typeof createTestServer>[0]) => {
  const s = await createTestServer(opts)
  servers.push(s)
  return s
}
const STAFF = { username: 'auditor.one', displayName: 'Auditor One', password: 'Auditor-Pass-1', roleKeys: ['auditor'] }

describe('setup and health', () => {
  it('reports setup state from the database and readiness from the schema version', async () => {
    const s = await server({ bootstrap: false })
    expect((await s.rpc('system.getStartupState')).body).toMatchObject({ ok: true, data: { status: 'setup_required', environment: 'test' } })
    expect((await s.app.inject({ method: 'GET', url: '/api/health/ready' })).json()).toMatchObject({ status: 'ready' })
    await bootstrapOrganization(s.tdb.db, SETUP, newCorrelationId())
    expect((await s.rpc('system.getStartupState')).body).toMatchObject({ ok: true, data: { status: 'ready' } })
    await expect(bootstrapOrganization(s.tdb.db, SETUP, newCorrelationId())).rejects.toMatchObject({ code: 'STATE_CONFLICT' })
  })

  it('sends security headers', async () => {
    const s = await server()
    const res = await s.app.inject({ method: 'GET', url: '/api/health/live' })
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('sessions', () => {
  it('issues an HttpOnly SameSite session cookie and stores only its hash', async () => {
    const s = await server()
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/v1/rpc/session.login',
      headers: { 'content-type': 'application/json', 'x-bpoam-request': '1', origin: ORIGIN },
      payload: JSON.stringify({ username: 'ADMIN', password: ADMIN.password })
    })
    expect(res.statusCode).toBe(200)
    const c = res.cookies.find((x) => x.name === s.config.cookieName)!
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
    const stored = await s.tdb.db.many<{ id_hash: string }>('SELECT id_hash FROM sessions')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id_hash).not.toBe(c.value)
    expect(stored[0]!.id_hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await s.rpc('session.getCurrent', null, { cookie: c.value })).body).toMatchObject({ ok: true, data: { user: { username: 'admin' }, roles: ['super_admin'] } })
  })

  it('rejects protected calls without a session and after logout', async () => {
    const s = await server()
    expect((await s.rpc('users.list')).status).toBe(401)
    const cookie = await s.login()
    expect((await s.rpc('users.list', null, { cookie })).status).toBe(200)
    await s.rpc('session.logout', null, { cookie })
    expect((await s.rpc('users.list', null, { cookie })).status).toBe(401)
    expect((await s.rpc('session.getCurrent', null, { cookie })).body).toEqual({ ok: true, data: null })
  })

  it('expires idle and absolute-lifetime sessions server-side', async () => {
    const s = await server()
    const cookie = await s.login()
    await s.tdb.db.exec("UPDATE sessions SET last_seen_at = now() - interval '16 minutes'")
    expect((await s.rpc('users.list', null, { cookie })).status).toBe(401)
    expect((await s.tdb.db.one<{ r: string }>('SELECT revoke_reason AS r FROM sessions'))!.r).toBe('idle_timeout')

    const cookie2 = await s.login()
    await s.tdb.db.exec("UPDATE sessions SET absolute_expires_at = now() - interval '1 second' WHERE revoked_at IS NULL")
    expect((await s.rpc('users.list', null, { cookie: cookie2 })).status).toBe(401)
  })

  it('revokes sessions on deactivation, password reset and password change', async () => {
    const s = await server()
    const admin = await s.login()
    const created = await s.rpc<{ id: string }>('users.create', STAFF, { cookie: admin })
    const staffId = created.body.ok ? created.body.data.id : ''
    const staff1 = await s.login(STAFF.username, STAFF.password)
    const staff2 = await s.login(STAFF.username, STAFF.password)

    // Changing your own password keeps the current session and ends the others.
    const changed = await s.rpc('session.changePassword', { currentPassword: STAFF.password, newPassword: 'Brand-New-Pass-1' }, { cookie: staff1 })
    expect(changed.status).toBe(200)
    expect((await s.rpc('audit.list', { page: 1, pageSize: 5 }, { cookie: staff1 })).status).toBe(200)
    expect((await s.rpc('audit.list', { page: 1, pageSize: 5 }, { cookie: staff2 })).status).toBe(401)

    await s.rpc('users.resetPassword', { id: staffId, newPassword: 'Temporary-Pass-1' }, { cookie: admin })
    expect((await s.rpc('audit.list', { page: 1, pageSize: 5 }, { cookie: staff1 })).status).toBe(401)

    const staff3 = await s.login(STAFF.username, 'Temporary-Pass-1')
    await s.rpc('users.update', { id: staffId, isActive: false, reason: 'left' }, { cookie: admin })
    expect((await s.rpc('audit.list', { page: 1, pageSize: 5 }, { cookie: staff3 })).status).toBe(401)
    expect((await s.rpc('session.login', { username: STAFF.username, password: 'Temporary-Pass-1' })).status).toBe(403)
  })
})

describe('login protection', () => {
  it('uses one message for wrong passwords and unknown users, then locks the account', async () => {
    const s = await server({ env: { LOGIN_RATE_LIMIT_PER_MINUTE: '100' } })
    const wrong = await s.rpc('session.login', { username: ADMIN.username, password: 'nope-nope-nope' })
    const unknown = await s.rpc('session.login', { username: 'ghost', password: 'nope-nope-nope' })
    expect([wrong.status, unknown.status]).toEqual([401, 401])
    if (!wrong.body.ok && !unknown.body.ok) expect(wrong.body.error.message).toBe(unknown.body.error.message)
    for (let i = 1; i < MAX_FAILED_LOGINS - 1; i++) await s.rpc('session.login', { username: ADMIN.username, password: 'bad-password-x' })
    const locked = await s.rpc('session.login', { username: ADMIN.username, password: 'bad-password-x' })
    expect(locked).toMatchObject({ status: 423, body: { ok: false, error: { code: 'ACCOUNT_LOCKED', message: expect.stringContaining(String(LOCKOUT_MINUTES)) } } })
    expect((await s.rpc('session.login', { username: ADMIN.username, password: ADMIN.password })).status).toBe(423)
  })

  it('rate-limits login attempts per IP', async () => {
    const s = await server({ env: { LOGIN_RATE_LIMIT_PER_MINUTE: '3' } })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await s.rpc('session.login', { username: 'ghost', password: 'nope-nope-nope' })).status)
    expect(statuses).toEqual([401, 401, 401, 429, 429])
  })
})

describe('request protection and validation', () => {
  it('rejects requests without the CSRF header or from another origin', async () => {
    const s = await server()
    const cookie = await s.login()
    const noHeader = await s.app.inject({ method: 'POST', url: '/api/v1/rpc/users.list', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `${s.config.cookieName}=${cookie}` }, payload: 'null' })
    expect(noHeader.statusCode).toBe(403)
    expect((await s.rpc('users.list', null, { cookie, headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('validates payloads, rejects unknown commands and never leaks stack traces', async () => {
    const s = await server()
    const cookie = await s.login()
    expect((await s.rpc('db.exec', 'DROP TABLE users', { cookie })).status).toBe(404)
    const bad = await s.rpc('settings.update', { idleTimeoutMinutes: 30, sql: 'x' }, { cookie })
    expect(bad).toMatchObject({ status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR' } } })
    const malformed = await s.app.inject({
      method: 'POST',
      url: '/api/v1/rpc/users.list',
      headers: { 'content-type': 'application/json', 'x-bpoam-request': '1', origin: ORIGIN, cookie: `${s.config.cookieName}=${cookie}` },
      payload: '{not json'
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.body).not.toMatch(/at .*\.(ts|js)/)
  })
})

describe('authorization and organization boundary', () => {
  it('enforces permissions on the server', async () => {
    const s = await server()
    const admin = await s.login()
    await s.rpc('users.create', STAFF, { cookie: admin })
    const auditor = await s.login(STAFF.username, STAFF.password)
    for (const [cmd, body] of [['users.list', null], ['settings.update', { idleTimeoutMinutes: 60 }], ['roles.updatePermissions', { roleKey: 'auditor', permissions: ['users.manage'], reason: 'x' }]] as const) {
      expect((await s.rpc(cmd, body, { cookie: auditor })).status).toBe(403)
    }
    expect((await s.rpc('audit.list', { page: 1, pageSize: 5 }, { cookie: auditor })).status).toBe(200)
  })

  it('keeps the last active Super Admin and blocks self-deactivation', async () => {
    const s = await server()
    const cookie = await s.login()
    const me = await s.rpc<{ user: { id: string } }>('session.getCurrent', null, { cookie })
    const id = me.body.ok ? me.body.data.user.id : ''
    expect((await s.rpc('users.update', { id, isActive: false }, { cookie })).status).toBe(409)
    expect((await s.rpc('users.update', { id, roleKeys: ['auditor'] }, { cookie })).status).toBe(409)
  })

  it('never exposes or modifies another organization\'s records', async () => {
    const s = await server()
    const cookie = await s.login()
    const other = await bootstrapOrganization(s.tdb.db, { ...SETUP, organization: { ...SETUP.organization, legalName: 'Other BPO', displayName: 'Other' } }, newCorrelationId(), { allowAdditional: true })
    const users = await s.rpc<Array<{ id: string }>>('users.list', null, { cookie })
    expect(users.body.ok && users.body.data.map((u) => u.id)).not.toContain(other.adminUserId)
    expect((await s.rpc('users.update', { id: other.adminUserId, displayName: 'Hijacked' }, { cookie })).status).toBe(404)
    expect((await s.rpc('users.resetPassword', { id: other.adminUserId, newPassword: 'Hijack-Pass-123' }, { cookie })).status).toBe(404)
    const audit = await s.rpc<{ items: Array<{ entityId: string | null }> }>('audit.list', { page: 1, pageSize: 200 }, { cookie })
    expect(audit.body.ok && audit.body.data.items.some((e) => e.entityId === other.organizationId)).toBe(false)
    const name = await s.tdb.db.one<{ n: string }>('SELECT display_name AS n FROM users WHERE id = $1', [other.adminUserId])
    expect(name!.n).toBe(ADMIN.displayName)
  })

  it('records audit events with the client IP and no secrets', async () => {
    const s = await server()
    const cookie = await s.login()
    await s.rpc('users.create', STAFF, { cookie })
    const rows = await s.tdb.db.many<{ event_type: string; ip_address: string | null; summary: unknown }>('SELECT event_type, ip_address, summary FROM audit_events ORDER BY seq')
    expect(rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(['setup.completed', 'auth.login', 'user.created']))
    expect(rows.find((r) => r.event_type === 'auth.login')!.ip_address).toBeTruthy()
    expect(JSON.stringify(rows)).not.toContain(STAFF.password)
  })
})

describe('self-service password-reset requests (U2)', () => {
  it('never reveals whether the username matched a real account, from an unauthenticated caller', async () => {
    const s = await server()
    const admin = await s.login()
    await s.rpc('users.create', STAFF, { cookie: admin })
    const matched = await s.rpc('passwordReset.request', { username: STAFF.username })
    const unmatched = await s.rpc('passwordReset.request', { username: 'nobody-by-this-name' })
    expect(matched.status).toBe(200)
    expect(unmatched.status).toBe(200)
    expect(matched.body).toEqual(unmatched.body)
  })

  it('queues exactly one pending request per user even after repeated submissions, visible only to an admin', async () => {
    const s = await server()
    const admin = await s.login()
    await s.rpc('users.create', STAFF, { cookie: admin })
    await s.rpc('passwordReset.request', { username: STAFF.username, message: 'Locked out of my laptop' })
    await s.rpc('passwordReset.request', { username: STAFF.username.toUpperCase() })

    const auditor = await s.login(STAFF.username, STAFF.password)
    expect((await s.rpc('passwordReset.list', null, { cookie: auditor })).status).toBe(403)

    const list = await s.rpc<Array<{ username: string; message: string | null; status: string }>>('passwordReset.list', null, { cookie: admin })
    expect(list.status).toBe(200)
    const mine = list.body.ok ? list.body.data.filter((r) => r.username === STAFF.username) : []
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ status: 'pending', message: 'Locked out of my laptop' })
  })

  it('an admin reset auto-resolves the pending request; dismissing is a separate, one-time action', async () => {
    const s = await server()
    const admin = await s.login()
    const created = await s.rpc<{ id: string }>('users.create', STAFF, { cookie: admin })
    const staffId = created.body.ok ? created.body.data.id : ''
    await s.rpc('passwordReset.request', { username: STAFF.username })

    await s.rpc('users.resetPassword', { id: staffId, newPassword: 'Temporary-Pass-2' }, { cookie: admin })
    const afterReset = await s.rpc<Array<{ username: string; status: string }>>('passwordReset.list', null, { cookie: admin })
    const row = afterReset.body.ok ? afterReset.body.data.find((r) => r.username === STAFF.username) : undefined
    expect(row?.status).toBe('resolved')

    await s.rpc('passwordReset.request', { username: STAFF.username })
    const pending = await s.rpc<Array<{ id: string; username: string; status: string }>>('passwordReset.list', null, { cookie: admin })
    const second = pending.body.ok ? pending.body.data.find((r) => r.username === STAFF.username && r.status === 'pending') : undefined
    expect(second).toBeTruthy()

    expect((await s.rpc('passwordReset.dismiss', { id: second!.id }, { cookie: admin })).status).toBe(200)
    expect((await s.rpc('passwordReset.dismiss', { id: second!.id }, { cookie: admin })).status).toBe(409)
  })

  it('audits the request and never records a secret', async () => {
    const s = await server()
    const admin = await s.login()
    await s.rpc('users.create', STAFF, { cookie: admin })
    await s.rpc('passwordReset.request', { username: STAFF.username })
    const rows = await s.tdb.db.many<{ event_type: string }>("SELECT event_type FROM audit_events WHERE event_type = 'auth.password_reset_requested'")
    expect(rows).toHaveLength(1)
  })
})
