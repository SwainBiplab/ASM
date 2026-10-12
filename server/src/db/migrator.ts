import { createHash } from 'node:crypto'
import type { Db } from './sql'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrationChecksum = (sql: string): string => createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/** Fixed key for pg_advisory_lock so two app instances never migrate at once. */
const MIGRATION_LOCK_KEY = 8_317_441_002

/**
 * Applies pending migrations in order, each in its own transaction. Refuses to run when the
 * database has migrations this build doesn't know (newer schema) or altered history.
 */
export async function migrate(db: Db, migrations: readonly Migration[], appVersion: string): Promise<{ from: number; to: number }> {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration list must be contiguous from 1; found ${m.version} at index ${i}`)
  })
  const client = await db.pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      app_version text NOT NULL
    )`)
    const applied = (await client.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows
    const known = new Map(migrations.map((m) => [m.version, m]))
    for (const row of applied) {
      const m = known.get(row.version)
      if (!m) throw new Error(`Database schema version ${row.version} is newer than this application supports.`)
      if (migrationChecksum(m.sql) !== row.checksum) throw new Error(`Migration ${row.version} (${row.name}) checksum does not match the applied history.`)
    }
    const from = applied.length ? applied[applied.length - 1]!.version : 0
    for (const m of migrations.filter((x) => x.version > from)) {
      await client.query('BEGIN')
      try {
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version, name, checksum, app_version) VALUES ($1, $2, $3, $4)', [m.version, m.name, migrationChecksum(m.sql), appVersion])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`)
      }
    }
    return { from, to: migrations.length ? migrations[migrations.length - 1]!.version : 0 }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined)
    client.release()
  }
}

export async function schemaVersion(db: Db): Promise<number> {
  const exists = await db.one<{ t: string | null }>("SELECT to_regclass('public.schema_migrations') AS t")
  if (!exists?.t) return 0
  return (await db.one<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations'))?.v ?? 0
}
