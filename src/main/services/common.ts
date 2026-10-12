import type { Database as DB } from 'better-sqlite3'
import type { PermissionKey } from '@shared/permissions'
import { AppError } from '../app/errors'
import type { OpContext } from './context'

/** Case-insensitive comparison key for names and codes. */
export const normalizeKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

export const normalizeOptional = (value: string | null): string | null => (value === null ? null : normalizeKey(value))

/** LIKE pattern with user wildcards escaped (use with `ESCAPE '\\'`). */
export const likePattern = (query: string): string => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export function assertAnyPermission(ctx: OpContext, keys: readonly PermissionKey[]): void {
  if (!keys.some((k) => ctx.actor.permissions.has(k))) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
  }
}

/** Throws DUPLICATE_RECORD with a field error when the query finds a conflicting row. */
export function assertUnique(db: DB, sql: string, params: unknown[], field: string, message: string): void {
  if (db.prepare(sql).get(...params)) throw new AppError('DUPLICATE_RECORD', message, { [field]: message })
}

export function requireRow<T>(row: T | undefined, what: string): T {
  if (!row) throw new AppError('NOT_FOUND', `${what} not found.`)
  return row
}

/** Permissions that allow reading the organization structure. */
export const ORG_VIEW_PERMISSIONS: readonly PermissionKey[] = ['locations.manage', 'employees.view', 'employees.manage', 'assets.view']
