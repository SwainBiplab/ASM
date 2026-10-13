import type { PasswordResetRequestSummary, RoleSummary, SessionInfo, UserSummary } from '@shared/api'
import { isPermissionKey, ROLE_TEMPLATES, resolveTemplatePermissions, SUPER_ADMIN_ROLE_KEY, type PermissionKey } from '@shared/permissions'
import {
  changePasswordInputSchema,
  createUserInputSchema,
  loginInputSchema,
  passwordResetDismissInputSchema,
  passwordResetRequestInputSchema,
  resetPasswordInputSchema,
  setupInputSchema,
  updateRolePermissionsInputSchema,
  updateUserInputSchema,
  type ChangePasswordInput,
  type CreateUserInput,
  type LoginInput,
  type PasswordResetDismissInput,
  type PasswordResetRequestInput,
  type ResetPasswordInput,
  type SetupInput,
  type UpdateRolePermissionsInput,
  type UpdateUserInput
} from '@shared/schemas'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password'
import { createSession, revokeSession, revokeUserSessions, type NewSession } from '../auth/sessions'
import type { Db, SqlClient } from '../db/sql'
import { auditFrom, getSettings, loadUserPermissions, recordAudit, syncPermissionCatalog } from './foundation'

export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MINUTES = 15
const INVALID_CREDENTIALS = 'Invalid username or password.'

// ---------------------------------------------------------------- bootstrap

export async function organizationCount(c: SqlClient): Promise<number> {
  return (await c.one<{ n: number }>('SELECT count(*) AS n FROM organizations'))!.n
}

/**
 * Creates an organization, its role templates and the first Super Admin in one transaction.
 * Version 1 deploys one organization: a second requires `allowAdditional` (tests/tooling only).
 */
export async function bootstrapOrganization(db: Db, raw: SetupInput, correlationId: string, opts: { allowAdditional?: boolean } = {}): Promise<{ organizationId: string; adminUserId: string }> {
  const input = setupInputSchema.parse(raw)
  await syncPermissionCatalog(db)
  const passwordHash = await hashPassword(input.admin.password)
  const orgId = newId()
  const adminId = newId()
  await db.tx(async (t) => {
    await t.exec('LOCK TABLE organizations IN EXCLUSIVE MODE')
    if (!opts.allowAdditional && (await organizationCount(t)) > 0) throw new AppError('STATE_CONFLICT', 'An organization already exists.')
    await t.exec('INSERT INTO organizations (id, legal_name, display_name, base_currency, timezone) VALUES ($1, $2, $3, $4, $5)', [
      orgId, input.organization.legalName, input.organization.displayName, input.organization.baseCurrency, input.organization.timezone
    ])
    let superAdminRoleId = ''
    for (const tpl of ROLE_TEMPLATES) {
      const roleId = newId()
      if (tpl.key === SUPER_ADMIN_ROLE_KEY) superAdminRoleId = roleId
      await t.exec('INSERT INTO roles (id, organization_id, key, name, description, is_system) VALUES ($1, $2, $3, $4, $5, $6)', [
        roleId, orgId, tpl.key, tpl.name, tpl.description, tpl.key === SUPER_ADMIN_ROLE_KEY
      ])
      for (const p of resolveTemplatePermissions(tpl)) await t.exec('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)', [roleId, p])
    }
    await t.exec(
      'INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash) VALUES ($1, $2, $3, $4, $5, $6)',
      [adminId, orgId, input.admin.username, input.admin.username.toLowerCase(), input.admin.displayName, passwordHash]
    )
    await t.exec('INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)', [orgId, adminId, superAdminRoleId])
    // Default asset-code format (TAS B1 / D20): AST-000001.
    await t.exec("INSERT INTO asset_code_config (organization_id, prefix, separator, padding, next_number) VALUES ($1, 'AST', '-', 6, 1)", [orgId])
    await recordAudit(t, {
      organizationId: orgId,
      actorUserId: adminId,
      eventType: 'setup.completed',
      entityType: 'organization',
      entityId: orgId,
      correlationId,
      summary: { legalName: input.organization.legalName, adminUsername: input.admin.username }
    })
  })
  return { organizationId: orgId, adminUserId: adminId }
}

// ---------------------------------------------------------------- sessions / auth

export interface RequestMeta {
  correlationId: string
  ip: string | null
  userAgent: string | null
}

async function loginOrganizationId(c: SqlClient): Promise<string> {
  const orgs = await c.many<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 2')
  if (orgs.length === 0) throw new AppError('STATE_CONFLICT', 'This installation has not been set up yet.')
  // V1 serves one organization; tenant selection (e.g. by subdomain) is future SaaS work.
  if (orgs.length > 1) throw new AppError('STATE_CONFLICT', 'Organization selection is not configured for this deployment.')
  return orgs[0]!.id
}

interface UserAuthRow {
  id: string
  organizationId: string
  passwordHash: string
  isActive: boolean
  failedLoginCount: number
  lockedUntil: string | null
}

export async function login(db: Db, raw: LoginInput, meta: RequestMeta, absoluteHours: number): Promise<{ session: NewSession; info: SessionInfo }> {
  const input = loginInputSchema.parse(raw)
  const orgId = await loginOrganizationId(db)
  const normalized = input.username.trim().toLowerCase()
  const user = await db.one<UserAuthRow>(
    `SELECT id, organization_id AS "organizationId", password_hash AS "passwordHash", is_active AS "isActive",
            failed_login_count AS "failedLoginCount", locked_until AS "lockedUntil"
     FROM users WHERE organization_id = $1 AND username_normalized = $2`,
    [orgId, normalized]
  )
  const audit = { organizationId: orgId, correlationId: meta.correlationId, ip: meta.ip }
  if (!user) {
    await verifyPassword(input.password, await getDummyHash())
    await recordAudit(db, { ...audit, actorUserId: null, eventType: 'auth.login_failed', entityType: 'user', summary: { username: normalized, reason: 'unknown_user' } })
    throw new AppError('INVALID_CREDENTIALS', INVALID_CREDENTIALS)
  }
  if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.')
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const failures = user.failedLoginCount + 1
    const lock = failures >= MAX_FAILED_LOGINS
    await db.tx(async (t) => {
      await t.exec(
        `UPDATE users SET failed_login_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE NULL END, updated_at = now() WHERE id = $1`,
        [user.id, lock ? 0 : failures, lock, LOCKOUT_MINUTES]
      )
      await recordAudit(t, { ...audit, actorUserId: null, eventType: lock ? 'auth.account_locked' : 'auth.login_failed', entityType: 'user', entityId: user.id, summary: { failures } })
    })
    if (lock) throw new AppError('ACCOUNT_LOCKED', `Too many failed attempts. The account is locked for ${LOCKOUT_MINUTES} minutes.`)
    throw new AppError('INVALID_CREDENTIALS', INVALID_CREDENTIALS)
  }
  if (!user.isActive) throw new AppError('PERMISSION_DENIED', 'This account is deactivated. Contact the Super Admin.')

  const session = await db.tx(async (t) => {
    await t.exec('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1', [user.id])
    const s = await createSession(t, { organizationId: orgId, userId: user.id, absoluteHours, ip: meta.ip, userAgent: meta.userAgent })
    await recordAudit(t, { ...audit, actorUserId: user.id, eventType: 'auth.login', entityType: 'user', entityId: user.id })
    return s
  })
  return { session, info: await sessionInfo(db, orgId, user.id) }
}

export async function logout(db: Db, idHash: string, organizationId: string, userId: string, meta: RequestMeta): Promise<void> {
  await db.tx(async (t) => {
    await revokeSession(t, idHash, 'logout')
    await recordAudit(t, { organizationId, actorUserId: userId, eventType: 'auth.logout', entityType: 'user', entityId: userId, correlationId: meta.correlationId, ip: meta.ip })
  })
}

export async function sessionInfo(c: SqlClient, organizationId: string, userId: string): Promise<SessionInfo> {
  const u = (await c.one<{ id: string; username: string; displayName: string; mustChangePassword: boolean }>(
    'SELECT id, username, display_name AS "displayName", must_change_password AS "mustChangePassword" FROM users WHERE id = $1 AND organization_id = $2',
    [userId, organizationId]
  ))!
  const roles = (await c.many<{ key: string }>('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.key', [userId])).map((r) => r.key)
  return {
    user: u,
    permissions: [...(await loadUserPermissions(c, organizationId, userId))].sort(),
    roles,
    idleTimeoutMinutes: (await getSettings(c, organizationId)).idleTimeoutMinutes,
    locked: false
  }
}

export async function changePassword(db: Db, raw: ChangePasswordInput, ctx: OpContext, currentSessionHash: string): Promise<SessionInfo> {
  const input = changePasswordInputSchema.parse(raw)
  const user = await db.one<{ hash: string }>('SELECT password_hash AS hash FROM users WHERE id = $1 AND organization_id = $2', [ctx.actor.userId, ctx.actor.organizationId])
  if (!user) throw new AppError('NOT_FOUND', 'User not found.')
  if (!(await verifyPassword(input.currentPassword, user.hash))) {
    throw new AppError('VALIDATION_ERROR', 'The current password is incorrect.', { currentPassword: 'Incorrect password' })
  }
  if (input.currentPassword === input.newPassword) {
    throw new AppError('VALIDATION_ERROR', 'Choose a password different from the current one.', { newPassword: 'Must differ from current password' })
  }
  const hash = await hashPassword(input.newPassword)
  await db.tx(async (t) => {
    await t.exec('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now() WHERE id = $1', [ctx.actor.userId, hash])
    // Other devices must sign in again with the new password.
    await revokeUserSessions(t, ctx.actor.userId, 'password_changed', currentSessionHash)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'user.password_changed', entityType: 'user', entityId: ctx.actor.userId })
  })
  return sessionInfo(db, ctx.actor.organizationId, ctx.actor.userId)
}

// ---------------------------------------------------------------- users & roles

const USER_SELECT = `
  SELECT u.id, u.username, u.display_name AS "displayName", u.is_active AS "isActive", u.must_change_password AS "mustChangePassword",
         u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
         coalesce((SELECT array_agg(r.key ORDER BY r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS "roleKeys"
  FROM users u`

export async function listUsers(db: Db, ctx: OpContext): Promise<UserSummary[]> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  return db.many<UserSummary>(`${USER_SELECT} WHERE u.organization_id = $1 ORDER BY u.username_normalized`, [ctx.actor.organizationId])
}

async function getUser(c: SqlClient, ctx: OpContext, id: string): Promise<UserSummary> {
  const u = await c.one<UserSummary>(`${USER_SELECT} WHERE u.id = $1 AND u.organization_id = $2`, [id, ctx.actor.organizationId])
  if (!u) throw new AppError('NOT_FOUND', 'User not found.')
  return u
}

async function resolveRoleIds(c: SqlClient, ctx: OpContext, keys: readonly string[]): Promise<string[]> {
  const ids: string[] = []
  for (const key of new Set(keys)) {
    const r = await c.one<{ id: string }>('SELECT id FROM roles WHERE organization_id = $1 AND key = $2', [ctx.actor.organizationId, key])
    if (!r) throw new AppError('VALIDATION_ERROR', `Unknown role: ${key}`, { roleKeys: `Unknown role: ${key}` })
    ids.push(r.id)
  }
  return ids
}

async function setUserRoles(c: SqlClient, ctx: OpContext, userId: string, roleIds: string[]): Promise<void> {
  await c.exec('DELETE FROM user_roles WHERE user_id = $1', [userId])
  for (const roleId of roleIds) await c.exec('INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)', [ctx.actor.organizationId, userId, roleId])
}

async function activeSuperAdmins(c: SqlClient, orgId: string): Promise<number> {
  return (await c.one<{ n: number }>(
    `SELECT count(DISTINCT u.id) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE u.organization_id = $1 AND r.key = $2 AND u.is_active`,
    [orgId, SUPER_ADMIN_ROLE_KEY]
  ))!.n
}

export async function createUser(db: Db, raw: CreateUserInput, ctx: OpContext): Promise<UserSummary> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = createUserInputSchema.parse(raw)
  const hash = await hashPassword(input.password)
  const id = newId()
  return db.tx(async (t) => {
    const roleIds = await resolveRoleIds(t, ctx, input.roleKeys)
    if (await t.one('SELECT 1 FROM users WHERE organization_id = $1 AND username_normalized = $2', [ctx.actor.organizationId, input.username.toLowerCase()])) {
      throw new AppError('DUPLICATE_RECORD', 'That username is already in use.', { username: 'Already in use' })
    }
    await t.exec(
      `INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [id, ctx.actor.organizationId, input.username, input.username.toLowerCase(), input.displayName, hash]
    )
    await setUserRoles(t, ctx, id, roleIds)
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'user.created', entityType: 'user', entityId: id, summary: { username: input.username, roles: input.roleKeys } })
    return getUser(t, ctx, id)
  })
}

export async function updateUser(db: Db, raw: UpdateUserInput, ctx: OpContext): Promise<UserSummary> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = updateUserInputSchema.parse(raw)
  if (input.isActive === false && input.id === ctx.actor.userId) throw new AppError('STATE_CONFLICT', 'You cannot deactivate your own account.')
  return db.tx(async (t) => {
    const before = await getUser(t, ctx, input.id)
    const roleIds = input.roleKeys ? await resolveRoleIds(t, ctx, input.roleKeys) : null
    await t.exec('UPDATE users SET display_name = $2, is_active = $3, updated_at = now() WHERE id = $1', [
      input.id, input.displayName ?? before.displayName, input.isActive ?? before.isActive
    ])
    if (roleIds) await setUserRoles(t, ctx, input.id, roleIds)
    if ((await activeSuperAdmins(t, ctx.actor.organizationId)) === 0) throw new AppError('STATE_CONFLICT', 'At least one active Super Admin account must remain.')
    if (input.isActive === false && before.isActive) await revokeUserSessions(t, input.id, 'user_deactivated')
    const after = await getUser(t, ctx, input.id)
    await recordAudit(t, {
      ...auditFrom(ctx),
      eventType: roleIds ? 'user.roles_changed' : 'user.updated',
      entityType: 'user',
      entityId: input.id,
      reason: input.reason ?? null,
      summary: { before: { displayName: before.displayName, isActive: before.isActive, roles: before.roleKeys }, after: { displayName: after.displayName, isActive: after.isActive, roles: after.roleKeys } }
    })
    return after
  })
}

export async function resetUserPassword(db: Db, raw: ResetPasswordInput, ctx: OpContext): Promise<void> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = resetPasswordInputSchema.parse(raw)
  const hash = await hashPassword(input.newPassword)
  await db.tx(async (t) => {
    await getUser(t, ctx, input.id)
    await t.exec(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = NULL, password_changed_at = now(), updated_at = now() WHERE id = $1`,
      [input.id, hash]
    )
    await revokeUserSessions(t, input.id, 'password_reset')
    // Closes out any self-service request (U2) that prompted this reset, so the admin queue doesn't
    // keep showing a request that was already acted on.
    await t.exec(
      `UPDATE password_reset_requests SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2 WHERE user_id = $1 AND status = 'pending'`,
      [input.id, ctx.actor.userId]
    )
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'user.password_reset', entityType: 'user', entityId: input.id })
  })
}

// ---------------------------------------------------------------- self-service password-reset requests (U2)

/**
 * Public, unauthenticated: a user who forgot their password asks to be noticed. Never reveals
 * whether `username` matched a real, active account -- the caller always sees the same outcome.
 * Any error (bad input aside) is swallowed for the same reason: a different response for "no such
 * organization" vs. "no such user" vs. "already requested" would itself leak information.
 */
export async function requestPasswordReset(db: Db, raw: PasswordResetRequestInput, meta: RequestMeta): Promise<void> {
  const input = passwordResetRequestInputSchema.parse(raw)
  try {
    const orgId = await loginOrganizationId(db)
    const normalized = input.username.trim().toLowerCase()
    const user = await db.one<{ id: string }>('SELECT id FROM users WHERE organization_id = $1 AND username_normalized = $2 AND is_active', [orgId, normalized])
    if (!user) return
    await db.tx(async (t) => {
      if (await t.one('SELECT 1 FROM password_reset_requests WHERE user_id = $1 AND status = $2', [user.id, 'pending'])) return
      const id = newId()
      await t.exec(
        `INSERT INTO password_reset_requests (id, organization_id, user_id, message, requested_ip) VALUES ($1, $2, $3, $4, $5)`,
        [id, orgId, user.id, input.message ?? null, meta.ip]
      )
      await recordAudit(t, { organizationId: orgId, actorUserId: null, eventType: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, correlationId: meta.correlationId, ip: meta.ip })
    })
  } catch {
    // Deliberately silent -- see function doc.
  }
}

export async function listPasswordResetRequests(db: Db, ctx: OpContext): Promise<PasswordResetRequestSummary[]> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  return db.many<PasswordResetRequestSummary>(
    `SELECT r.id, r.user_id AS "userId", u.username, u.display_name AS "displayName", r.message, r.status,
            r.requested_at AS "requestedAt", r.resolved_at AS "resolvedAt"
     FROM password_reset_requests r JOIN users u ON u.id = r.user_id
     WHERE r.organization_id = $1
     ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
     LIMIT 200`,
    [ctx.actor.organizationId]
  )
}

export async function dismissPasswordResetRequest(db: Db, raw: PasswordResetDismissInput, ctx: OpContext): Promise<void> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = passwordResetDismissInputSchema.parse(raw)
  await db.tx(async (t) => {
    const r = await t.one<{ userId: string; status: string }>('SELECT user_id AS "userId", status FROM password_reset_requests WHERE id = $1 AND organization_id = $2', [
      input.id, ctx.actor.organizationId
    ])
    if (!r) throw new AppError('NOT_FOUND', 'Request not found.')
    if (r.status !== 'pending') throw new AppError('STATE_CONFLICT', 'This request was already handled.')
    await t.exec(`UPDATE password_reset_requests SET status = 'dismissed', resolved_at = now(), resolved_by_user_id = $2 WHERE id = $1`, [input.id, ctx.actor.userId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'auth.password_reset_dismissed', entityType: 'user', entityId: r.userId })
  })
}

/** Dashboard figure; null when the user cannot view/manage users. */
export async function pendingPasswordResetCount(c: SqlClient, ctx: OpContext): Promise<number | null> {
  if (!ctx.actor.permissions.has('users.manage')) return null
  return (await c.one<{ n: number }>("SELECT count(*) AS n FROM password_reset_requests WHERE organization_id = $1 AND status = 'pending'", [ctx.actor.organizationId]))!.n
}

export async function listRoles(db: SqlClient, ctx: OpContext): Promise<RoleSummary[]> {
  if (!ctx.actor.permissions.has('roles.manage') && !ctx.actor.permissions.has('users.manage')) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
  }
  const rows = await db.many<Omit<RoleSummary, 'permissions'> & { permissions: string[] }>(
    `SELECT r.key, r.name, r.description, r.is_system AS "isSystem",
            (SELECT count(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.is_active) AS "userCount",
            coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS permissions
     FROM roles r WHERE r.organization_id = $1 ORDER BY r.is_system DESC, r.name`,
    [ctx.actor.organizationId]
  )
  return rows.map((r) => ({ ...r, permissions: r.permissions.filter(isPermissionKey) }))
}

export async function updateRolePermissions(db: Db, raw: UpdateRolePermissionsInput, ctx: OpContext): Promise<RoleSummary> {
  assertPermission(ctx.actor.permissions, 'roles.manage')
  const input = updateRolePermissionsInputSchema.parse(raw)
  if (input.roleKey === SUPER_ADMIN_ROLE_KEY) throw new AppError('STATE_CONFLICT', 'The Super Admin role always holds every permission.')
  return db.tx(async (t) => {
    const role = await t.one<{ id: string }>('SELECT id FROM roles WHERE organization_id = $1 AND key = $2', [ctx.actor.organizationId, input.roleKey])
    if (!role) throw new AppError('NOT_FOUND', 'Role not found.')
    const before = (await t.many<{ k: string }>('SELECT permission_key AS k FROM role_permissions WHERE role_id = $1', [role.id])).map((r) => r.k)
    const next = [...new Set(input.permissions)] as PermissionKey[]
    await t.exec('DELETE FROM role_permissions WHERE role_id = $1', [role.id])
    for (const p of next) await t.exec('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)', [role.id, p])
    await t.exec('UPDATE roles SET updated_at = now() WHERE id = $1', [role.id])
    await recordAudit(t, {
      ...auditFrom(ctx),
      eventType: 'role.permissions_changed',
      entityType: 'role',
      entityId: role.id,
      reason: input.reason,
      summary: { role: input.roleKey, added: next.filter((p) => !before.includes(p)), removed: before.filter((p) => !next.includes(p as PermissionKey)) }
    })
    return (await listRoles(t, ctx)).find((r) => r.key === input.roleKey)!
  })
}
