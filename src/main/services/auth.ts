import type { Database as DB } from 'better-sqlite3'
import type { SessionInfo } from '@shared/api'
import {
  changePasswordInputSchema,
  loginInputSchema,
  unlockInputSchema,
  type ChangePasswordInput,
  type LoginInput,
  type UnlockInput
} from '@shared/schemas'
import { AppError } from '../app/errors'
import { nowIso } from '../app/ids'
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password'
import { loadUserPermissions, loadUserRoleKeys } from '../auth/permissions'
import type { SessionManager } from '../auth/session'
import { recordAudit } from './audit'
import { getSettings } from './settings'

/** Lockout after repeated failures (TAS §6.3). Technical defaults, documented in DECISIONS.md. */
export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MINUTES = 15

interface UserAuthRow {
  id: string
  username: string
  displayName: string
  passwordHash: string
  isActive: number
  mustChangePassword: number
  failedLoginCount: number
  lockedUntil: string | null
}

const USER_AUTH_COLUMNS = `id, username, display_name AS displayName, password_hash AS passwordHash, is_active AS isActive,
  must_change_password AS mustChangePassword, failed_login_count AS failedLoginCount, locked_until AS lockedUntil`

const INVALID_CREDENTIALS = 'Invalid username or password.'

export class AuthService {
  constructor(
    private readonly getDb: () => DB,
    private readonly sessions: SessionManager,
    private readonly clock: () => number = Date.now
  ) {}

  async login(rawInput: LoginInput, correlationId: string): Promise<SessionInfo> {
    const input = loginInputSchema.parse(rawInput)
    const db = this.getDb()
    const normalized = input.username.trim().toLowerCase()
    const user = db.prepare(`SELECT ${USER_AUTH_COLUMNS} FROM users WHERE username_normalized = ?`).get(normalized) as
      | UserAuthRow
      | undefined

    if (!user) {
      await verifyPassword(input.password, await getDummyHash())
      recordAudit(db, {
        actorUserId: null,
        eventType: 'auth.login_failed',
        entityType: 'user',
        correlationId,
        summary: { username: normalized, reason: 'unknown_user' }
      })
      throw new AppError('INVALID_CREDENTIALS', INVALID_CREDENTIALS)
    }

    if (user.lockedUntil && Date.parse(user.lockedUntil) > this.clock()) {
      throw new AppError('ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${new Date(user.lockedUntil).toLocaleTimeString()}.`)
    }

    const ok = await verifyPassword(input.password, user.passwordHash)
    if (!ok) {
      const failures = user.failedLoginCount + 1
      const lock = failures >= MAX_FAILED_LOGINS
      const lockedUntil = lock ? new Date(this.clock() + LOCKOUT_MINUTES * 60_000).toISOString() : null
      db.transaction(() => {
        db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
          lock ? 0 : failures,
          lockedUntil,
          nowIso(),
          user.id
        )
        recordAudit(db, {
          actorUserId: null,
          eventType: lock ? 'auth.account_locked' : 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          correlationId,
          summary: { failures }
        })
      })()
      if (lock) throw new AppError('ACCOUNT_LOCKED', `Too many failed attempts. The account is locked for ${LOCKOUT_MINUTES} minutes.`)
      throw new AppError('INVALID_CREDENTIALS', INVALID_CREDENTIALS)
    }

    if (!user.isActive) throw new AppError('PERMISSION_DENIED', 'This account is deactivated. Contact the Super Admin.')

    db.transaction(() => {
      db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?').run(
        nowIso(),
        nowIso(),
        user.id
      )
      recordAudit(db, { actorUserId: user.id, eventType: 'auth.login', entityType: 'user', entityId: user.id, correlationId })
    })()
    this.sessions.start(user.id)
    return this.buildSessionInfo(user.id, false)
  }

  logout(correlationId: string): void {
    const check = this.sessions.check(Number.MAX_SAFE_INTEGER)
    if (check.state !== 'none') {
      recordAudit(this.getDb(), {
        actorUserId: check.session.userId,
        eventType: 'auth.logout',
        entityType: 'user',
        entityId: check.session.userId,
        correlationId
      })
    }
    this.sessions.end()
  }

  getCurrent(): SessionInfo | null {
    const db = this.getDb()
    const check = this.sessions.check(getSettings(db).idleTimeoutMinutes)
    if (check.state === 'none') return null
    const active = db.prepare('SELECT is_active AS a FROM users WHERE id = ?').get(check.session.userId) as { a: number } | undefined
    if (!active?.a) {
      this.sessions.end()
      return null
    }
    return this.buildSessionInfo(check.session.userId, check.state === 'locked')
  }

  async unlock(rawInput: UnlockInput, correlationId: string): Promise<SessionInfo> {
    const input = unlockInputSchema.parse(rawInput)
    const db = this.getDb()
    const check = this.sessions.check(getSettings(db).idleTimeoutMinutes)
    if (check.state === 'none') throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
    const user = db.prepare(`SELECT ${USER_AUTH_COLUMNS} FROM users WHERE id = ?`).get(check.session.userId) as UserAuthRow | undefined
    if (!user || !user.isActive) {
      this.sessions.end()
      throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      recordAudit(db, { actorUserId: user.id, eventType: 'auth.unlock_failed', entityType: 'user', entityId: user.id, correlationId })
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect password.')
    }
    this.sessions.unlock()
    return this.buildSessionInfo(user.id, false)
  }

  async changePassword(userId: string, rawInput: ChangePasswordInput, correlationId: string): Promise<SessionInfo> {
    const input = changePasswordInputSchema.parse(rawInput)
    const db = this.getDb()
    const user = db.prepare(`SELECT ${USER_AUTH_COLUMNS} FROM users WHERE id = ?`).get(userId) as UserAuthRow | undefined
    if (!user) throw new AppError('NOT_FOUND', 'User not found.')
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError('VALIDATION_ERROR', 'The current password is incorrect.', { currentPassword: 'Incorrect password' })
    }
    if (input.currentPassword === input.newPassword) {
      throw new AppError('VALIDATION_ERROR', 'Choose a password different from the current one.', { newPassword: 'Must differ from current password' })
    }
    const hash = await hashPassword(input.newPassword)
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?').run(
        hash,
        nowIso(),
        nowIso(),
        userId
      )
      recordAudit(db, { actorUserId: userId, eventType: 'user.password_changed', entityType: 'user', entityId: userId, correlationId })
    })()
    return this.buildSessionInfo(userId, false)
  }

  buildSessionInfo(userId: string, locked: boolean): SessionInfo {
    const db = this.getDb()
    const row = db
      .prepare('SELECT id, username, display_name AS displayName, must_change_password AS mcp FROM users WHERE id = ?')
      .get(userId) as { id: string; username: string; displayName: string; mcp: number }
    return {
      user: { id: row.id, username: row.username, displayName: row.displayName, mustChangePassword: Boolean(row.mcp) },
      permissions: [...loadUserPermissions(db, userId)].sort(),
      roles: loadUserRoleKeys(db, userId),
      idleTimeoutMinutes: getSettings(db).idleTimeoutMinutes,
      locked
    }
  }
}
