import type { Database as DB } from 'better-sqlite3'
import type { RoleSummary, UserSummary } from '@shared/api'
import { isPermissionKey, SUPER_ADMIN_ROLE_KEY, type PermissionKey } from '@shared/permissions'
import {
  createUserInputSchema,
  resetPasswordInputSchema,
  updateRolePermissionsInputSchema,
  updateUserInputSchema,
  type CreateUserInput,
  type ResetPasswordInput,
  type UpdateRolePermissionsInput,
  type UpdateUserInput
} from '@shared/schemas'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { hashPassword } from '../auth/password'
import { assertPermission } from '../auth/permissions'
import { recordAudit } from './audit'
import type { OpContext } from './context'
import { getOrganizationId } from './setup'

interface UserRow {
  id: string
  username: string
  displayName: string
  isActive: number
  mustChangePassword: number
  lastLoginAt: string | null
  createdAt: string
  roleKeys: string | null
}

const USER_SELECT = `SELECT u.id, u.username, u.display_name AS displayName, u.is_active AS isActive,
  u.must_change_password AS mustChangePassword, u.last_login_at AS lastLoginAt, u.created_at AS createdAt,
  (SELECT group_concat(r.key, ',') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roleKeys
  FROM users u`

const toSummary = (r: UserRow): UserSummary => ({
  id: r.id,
  username: r.username,
  displayName: r.displayName,
  isActive: Boolean(r.isActive),
  mustChangePassword: Boolean(r.mustChangePassword),
  lastLoginAt: r.lastLoginAt,
  createdAt: r.createdAt,
  roleKeys: r.roleKeys ? r.roleKeys.split(',').sort() : []
})

export function listUsers(db: DB, ctx: OpContext): UserSummary[] {
  assertPermission(ctx.actor.permissions, 'users.manage')
  return (db.prepare(`${USER_SELECT} ORDER BY u.username_normalized`).all() as UserRow[]).map(toSummary)
}

function getUser(db: DB, id: string): UserSummary {
  const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow | undefined
  if (!row) throw new AppError('NOT_FOUND', 'User not found.')
  return toSummary(row)
}

function resolveRoleIds(db: DB, roleKeys: readonly string[]): Map<string, string> {
  const unique = [...new Set(roleKeys)]
  const map = new Map<string, string>()
  const stmt = db.prepare('SELECT id FROM roles WHERE key = ?')
  for (const key of unique) {
    const row = stmt.get(key) as { id: string } | undefined
    if (!row) throw new AppError('VALIDATION_ERROR', `Unknown role: ${key}`, { roleKeys: `Unknown role: ${key}` })
    map.set(key, row.id)
  }
  return map
}

function countActiveSuperAdmins(db: DB): number {
  return (
    db
      .prepare(
        `SELECT count(DISTINCT u.id) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id WHERE r.key = ? AND u.is_active = 1`
      )
      .get(SUPER_ADMIN_ROLE_KEY) as { n: number }
  ).n
}

function setUserRoles(db: DB, userId: string, roleIds: Map<string, string>): void {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
  const insert = db.prepare('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)')
  for (const roleId of roleIds.values()) insert.run(userId, roleId, nowIso())
}

export async function createUser(db: DB, rawInput: CreateUserInput, ctx: OpContext): Promise<UserSummary> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = createUserInputSchema.parse(rawInput)
  const normalized = input.username.toLowerCase()
  const roleIds = resolveRoleIds(db, input.roleKeys)
  if (db.prepare('SELECT 1 FROM users WHERE username_normalized = ?').get(normalized)) {
    throw new AppError('DUPLICATE_RECORD', 'That username is already in use.', { username: 'Already in use' })
  }
  const hash = await hashPassword(input.password)
  const id = newId()
  const now = nowIso()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash,
                          must_change_password, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(id, getOrganizationId(db), input.username, normalized, input.displayName, hash, now, now, now)
    setUserRoles(db, id, roleIds)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'user.created',
      entityType: 'user',
      entityId: id,
      correlationId: ctx.correlationId,
      summary: { username: input.username, roles: [...roleIds.keys()] }
    })
  })()
  return getUser(db, id)
}

export function updateUser(db: DB, rawInput: UpdateUserInput, ctx: OpContext): UserSummary {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = updateUserInputSchema.parse(rawInput)
  const before = getUser(db, input.id)
  const roleIds = input.roleKeys ? resolveRoleIds(db, input.roleKeys) : null

  if (input.isActive === false && input.id === ctx.actor.userId) {
    throw new AppError('STATE_CONFLICT', 'You cannot deactivate your own account.')
  }

  db.transaction(() => {
    if (input.displayName !== undefined || input.isActive !== undefined) {
      db.prepare('UPDATE users SET display_name = ?, is_active = ?, updated_at = ? WHERE id = ?').run(
        input.displayName ?? before.displayName,
        (input.isActive ?? before.isActive) ? 1 : 0,
        nowIso(),
        input.id
      )
    }
    if (roleIds) setUserRoles(db, input.id, roleIds)
    // Invariant: at least one active Super Admin must remain (checked after the change, inside the transaction).
    if (countActiveSuperAdmins(db) === 0) {
      throw new AppError('STATE_CONFLICT', 'At least one active Super Admin account must remain.')
    }
    const after = getUser(db, input.id)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: roleIds ? 'user.roles_changed' : 'user.updated',
      entityType: 'user',
      entityId: input.id,
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
      summary: {
        before: { displayName: before.displayName, isActive: before.isActive, roles: before.roleKeys },
        after: { displayName: after.displayName, isActive: after.isActive, roles: after.roleKeys }
      }
    })
  })()
  return getUser(db, input.id)
}

export async function resetUserPassword(db: DB, rawInput: ResetPasswordInput, ctx: OpContext): Promise<void> {
  assertPermission(ctx.actor.permissions, 'users.manage')
  const input = resetPasswordInputSchema.parse(rawInput)
  getUser(db, input.id)
  const hash = await hashPassword(input.newPassword)
  db.transaction(() => {
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL, password_changed_at = ?, updated_at = ? WHERE id = ?'
    ).run(hash, nowIso(), nowIso(), input.id)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'user.password_reset',
      entityType: 'user',
      entityId: input.id,
      correlationId: ctx.correlationId
    })
  })()
}

export function listRoles(db: DB, ctx: OpContext): RoleSummary[] {
  if (!ctx.actor.permissions.has('roles.manage') && !ctx.actor.permissions.has('users.manage')) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
  }
  const roles = db
    .prepare(
      `SELECT r.id, r.key, r.name, r.description, r.is_system AS isSystem,
              (SELECT count(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.is_active = 1) AS userCount
       FROM roles r ORDER BY r.is_system DESC, r.name`
    )
    .all() as Array<{ id: string; key: string; name: string; description: string; isSystem: number; userCount: number }>
  const permsStmt = db.prepare('SELECT permission_key AS k FROM role_permissions WHERE role_id = ? ORDER BY permission_key')
  return roles.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: Boolean(r.isSystem),
    userCount: r.userCount,
    permissions: (permsStmt.all(r.id) as Array<{ k: string }>).map((p) => p.k).filter(isPermissionKey)
  }))
}

export function updateRolePermissions(db: DB, rawInput: UpdateRolePermissionsInput, ctx: OpContext): RoleSummary {
  assertPermission(ctx.actor.permissions, 'roles.manage')
  const input = updateRolePermissionsInputSchema.parse(rawInput)
  if (input.roleKey === SUPER_ADMIN_ROLE_KEY) {
    throw new AppError('STATE_CONFLICT', 'The Super Admin role always holds every permission.')
  }
  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(input.roleKey) as { id: string } | undefined
  if (!role) throw new AppError('NOT_FOUND', 'Role not found.')
  const before = (db.prepare('SELECT permission_key AS k FROM role_permissions WHERE role_id = ?').all(role.id) as Array<{ k: string }>).map(
    (p) => p.k
  )
  const next = [...new Set(input.permissions)] as PermissionKey[]
  db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id)
    const grant = db.prepare('INSERT INTO role_permissions (role_id, permission_key, granted_at) VALUES (?, ?, ?)')
    for (const p of next) grant.run(role.id, p, nowIso())
    db.prepare('UPDATE roles SET updated_at = ? WHERE id = ?').run(nowIso(), role.id)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'role.permissions_changed',
      entityType: 'role',
      entityId: role.id,
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: {
        role: input.roleKey,
        added: next.filter((p) => !before.includes(p)),
        removed: before.filter((p) => !next.includes(p as PermissionKey))
      }
    })
  })()
  const updated = listRoles(db, ctx).find((r) => r.key === input.roleKey)
  if (!updated) throw new AppError('NOT_FOUND', 'Role not found.')
  return updated
}
