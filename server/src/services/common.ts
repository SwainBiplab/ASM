import { AppError } from '../core'
import type { SqlClient } from '../db/sql'

/** Case-insensitive comparison key for names and codes (same rule as the prototype). */
export const normalizeKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()
export const normalizeOptional = (value: string | null): string | null => (value === null ? null : normalizeKey(value))

/** LIKE pattern with user wildcards escaped (use with `ESCAPE '\\'`). */
export const likePattern = (query: string): string => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** Collects positional parameters so dynamic WHERE clauses stay parameterized. */
export class Params {
  readonly values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

export async function assertUnique(c: SqlClient, sql: string, params: unknown[], field: string, message: string): Promise<void> {
  if (await c.one(sql, params)) throw new AppError('DUPLICATE_RECORD', message, { [field]: message })
}

export function requireRow<T>(row: T | undefined, what: string): T {
  if (!row) throw new AppError('NOT_FOUND', `${what} not found.`)
  return row
}

export function invalid(field: string, message: string): never {
  throw new AppError('VALIDATION_ERROR', message, { [field]: message })
}

export function conflict(message: string): never {
  throw new AppError('STATE_CONFLICT', message)
}
