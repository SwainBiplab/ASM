import type { Database as DB } from 'better-sqlite3'
import { isPermissionKey, type PermissionKey } from '@shared/permissions'
import { AppError } from '../app/errors'

/** Effective permissions of an active user, derived from role assignments. */
export function loadUserPermissions(db: DB, userId: string): Set<PermissionKey> {
  const rows = db
    .prepare(
      `SELECT DISTINCT rp.permission_key AS key
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE u.id = ? AND u.is_active = 1`
    )
    .all(userId) as Array<{ key: string }>
  return new Set(rows.map((r) => r.key).filter(isPermissionKey))
}

export function loadUserRoleKeys(db: DB, userId: string): string[] {
  return (
    db
      .prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key')
      .all(userId) as Array<{ key: string }>
  ).map((r) => r.key)
}

export function assertPermission(granted: ReadonlySet<PermissionKey>, required: PermissionKey): void {
  if (!granted.has(required)) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
  }
}
