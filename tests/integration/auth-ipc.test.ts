import { afterEach, describe, expect, it } from 'vitest'
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from '../../src/main/services/auth'
import { ADMIN, SETUP_INPUT, createReadyApp, createTestApp, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))
const track = (a: TestApp): TestApp => (apps.push(a), a)

const STAFF = { username: 'auditor.one', displayName: 'Auditor One', password: 'Auditor-Pass-1', roleKeys: ['auditor'] }

describe('first-run setup', () => {
  it('creates one organization, role templates and the Super Admin', async () => {
    const app = track(await createTestApp())
    expect((await app.ok('system.getStartupState')).status).toBe('setup_required')
    await app.ok('setup.complete', SETUP_INPUT)
    expect((await app.ok('system.getStartupState')).status).toBe('ready')
    const session = await app.ok('session.login', { username: 'ADMIN', password: ADMIN.password })
    expect(session.roles).toEqual(['super_admin'])
    expect(session.permissions).toContain('backup.restore')
    const roles = await app.ok('roles.list')
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['super_admin', 'asset_manager', 'auditor', 'hr_officer']))
  })

  it('cannot be run twice', async () => {
    const app = track(await createReadyApp())
    const r = await app.call('setup.complete', SETUP_INPUT)
    expect(r).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
  })

  it('rejects weak passwords with field errors', async () => {
    const app = track(await createTestApp())
    const r = await app.call('setup.complete', { ...SETUP_INPUT, admin: { ...ADMIN, password: 'short' } })
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', fieldErrors: { 'admin.password': expect.any(String) } } })
  })
})

describe('login, lockout and idle lock', () => {
  it('rejects wrong passwords and unknown users with the same message', async () => {
    const app = track(await createReadyApp())
    await app.ok('session.logout')
    const wrong = await app.call('session.login', { username: ADMIN.username, password: 'nope-nope-nope' })
    const unknown = await app.call('session.login', { username: 'ghost', password: 'nope-nope-nope' })
    expect(wrong).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } })
    if (!wrong.ok && !unknown.ok) expect(wrong.error.message).toBe(unknown.error.message)
  })

  it(`locks the account after ${MAX_FAILED_LOGINS} failures, then allows login after the lockout`, async () => {
    const app = track(await createReadyApp())
    await app.ok('session.logout')
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) {
      expect((await app.call('session.login', { username: ADMIN.username, password: 'bad-password-x' })).ok).toBe(false)
    }
    const locking = await app.call('session.login', { username: ADMIN.username, password: 'bad-password-x' })
    expect(locking).toMatchObject({ ok: false, error: { code: 'ACCOUNT_LOCKED' } })
    // Even the correct password is refused while locked.
    expect(await app.call('session.login', { username: ADMIN.username, password: ADMIN.password })).toMatchObject({
      ok: false,
      error: { code: 'ACCOUNT_LOCKED' }
    })
    app.clock.now += (LOCKOUT_MINUTES + 1) * 60_000
    expect((await app.call('session.login', { username: ADMIN.username, password: ADMIN.password })).ok).toBe(true)
  })

  it('locks an idle session and requires the password to unlock', async () => {
    const app = track(await createReadyApp())
    app.clock.now += 16 * 60_000
    expect(await app.call('users.list')).toMatchObject({ ok: false, error: { code: 'SESSION_LOCKED' } })
    expect((await app.ok('session.getCurrent'))?.locked).toBe(true)
    expect(await app.call('session.unlock', { password: 'wrong-password' })).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } })
    await app.ok('session.unlock', { password: ADMIN.password })
    expect((await app.call('users.list')).ok).toBe(true)
  })

  it('records login, failure and logout audit events', async () => {
    const app = track(await createReadyApp())
    await app.ok('session.logout')
    await app.call('session.login', { username: ADMIN.username, password: 'bad-password-x' })
    await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
    const events = (await app.ok('audit.list', { page: 1, pageSize: 50 })).items.map((e) => e.eventType)
    expect(events).toEqual(expect.arrayContaining(['setup.completed', 'auth.login', 'auth.login_failed', 'auth.logout']))
    expect(JSON.stringify(events)).not.toContain(ADMIN.password)
  })
})

describe('authorization enforced in services', () => {
  it('denies unauthenticated calls to protected commands', async () => {
    const app = track(await createReadyApp())
    await app.ok('session.logout')
    expect(await app.call('users.list')).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } })
    expect(await app.call('backup.create')).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } })
  })

  it('denies a read-only auditor from administrative actions', async () => {
    const app = track(await createReadyApp())
    await app.ok('users.create', STAFF)
    await app.ok('session.logout')
    const s = await app.ok('session.login', { username: STAFF.username, password: STAFF.password })
    expect(s.user.mustChangePassword).toBe(true)
    expect(s.permissions).not.toContain('users.manage')
    for (const [cmd, payload] of [
      ['users.list', undefined],
      ['backup.create', undefined],
      ['settings.update', { idleTimeoutMinutes: 60 }],
      ['roles.updatePermissions', { roleKey: 'auditor', permissions: ['users.manage'], reason: 'escalate' }]
    ] as const) {
      expect(await app.call(cmd, payload as never)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    }
    expect((await app.call('audit.list', { page: 1, pageSize: 10 })).ok).toBe(true)
  })

  it('applies role changes immediately to an active session', async () => {
    const app = track(await createReadyApp())
    const user = await app.ok('users.create', { ...STAFF, roleKeys: ['employee'] })
    await app.ok('session.logout')
    await app.ok('session.login', { username: STAFF.username, password: STAFF.password })
    expect(await app.call('audit.list', { page: 1, pageSize: 10 })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    // Grant via direct role update while the session is active.
    const db = app.container.dbm.db
    const auditorRole = db.prepare("SELECT id FROM roles WHERE key = 'auditor'").get() as { id: string }
    db.prepare('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)').run(user.id, auditorRole.id, new Date().toISOString())
    expect((await app.call('audit.list', { page: 1, pageSize: 10 })).ok).toBe(true)
  })

  it('protects the last active Super Admin and blocks self-deactivation', async () => {
    const app = track(await createReadyApp())
    const me = (await app.ok('session.getCurrent'))!.user
    expect(await app.call('users.update', { id: me.id, isActive: false })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })
    expect(await app.call('users.update', { id: me.id, roleKeys: ['auditor'] })).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT', message: expect.stringContaining('Super Admin') }
    })
    // The failed transaction left roles unchanged.
    expect((await app.ok('session.getCurrent'))!.roles).toEqual(['super_admin'])
  })

  it('ends access for a deactivated user', async () => {
    const app = track(await createReadyApp())
    const staff = await app.ok('users.create', STAFF)
    await app.ok('users.update', { id: staff.id, isActive: false, reason: 'left company' })
    await app.ok('session.logout')
    expect(await app.call('session.login', { username: STAFF.username, password: STAFF.password })).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' }
    })
  })

  it('rejects duplicate usernames case-insensitively', async () => {
    const app = track(await createReadyApp())
    await app.ok('users.create', STAFF)
    expect(await app.call('users.create', { ...STAFF, username: 'AUDITOR.ONE' })).toMatchObject({ ok: false, error: { code: 'DUPLICATE_RECORD' } })
  })

  it('audits role permission changes and keeps Super Admin immutable', async () => {
    const app = track(await createReadyApp())
    const updated = await app.ok('roles.updatePermissions', { roleKey: 'auditor', permissions: ['assets.view'], reason: 'tighten scope' })
    expect(updated.permissions).toEqual(['assets.view'])
    expect(await app.call('roles.updatePermissions', { roleKey: 'super_admin', permissions: [], reason: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'STATE_CONFLICT' }
    })
    const page = await app.ok('audit.list', { page: 1, pageSize: 10, eventType: 'role.permissions_changed' })
    expect(page.total).toBe(1)
    expect(page.items[0]!.reason).toBe('tighten scope')
  })
})

describe('IPC payload validation', () => {
  it('rejects unknown commands', async () => {
    const app = track(await createReadyApp())
    expect(await app.call('db.exec' as never, 'DROP TABLE users' as never)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } })
  })

  it('rejects unknown keys and wrong types', async () => {
    const app = track(await createReadyApp())
    expect(await app.call('settings.update', { idleTimeoutMinutes: 30, sql: 'x' } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('settings.update', { idleTimeoutMinutes: '30' } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await app.call('users.list', { anything: true } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('returns a correlation id and never leaks stack traces', async () => {
    const app = track(await createReadyApp())
    const r = await app.call('users.update', { id: '00000000-0000-4000-8000-000000000000', displayName: 'x' })
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', correlationId: expect.stringMatching(/^[0-9a-f]{12}$/) } })
    expect(JSON.stringify(r)).not.toMatch(/at .*\.ts/)
  })

  it('persists allow-listed settings with an audit event', async () => {
    const app = track(await createReadyApp())
    expect((await app.ok('settings.update', { idleTimeoutMinutes: 30 })).idleTimeoutMinutes).toBe(30)
    expect((await app.ok('settings.get')).idleTimeoutMinutes).toBe(30)
    expect((await app.ok('audit.list', { page: 1, pageSize: 5, eventType: 'settings.updated' })).total).toBe(1)
  })
})
