import pg from 'pg'

/**
 * Thin typed access layer over node-postgres. SQL stays explicit (DECISIONS D25).
 * Type parsers return ISO strings for timestamps, plain strings for dates and numbers for
 * bigint counts, so DTOs match the shared contract exactly.
 */
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()) // timestamptz
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString()) // timestamp
pg.types.setTypeParser(1082, (v) => v) // date → 'YYYY-MM-DD'
pg.types.setTypeParser(20, (v) => {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error('bigint value exceeds the safe integer range')
  return n
}) // int8 (count(*), sums)

export interface SqlClient {
  one<T>(sql: string, params?: unknown[]): Promise<T | undefined>
  many<T>(sql: string, params?: unknown[]): Promise<T[]>
  /** Returns the affected row count. */
  exec(sql: string, params?: unknown[]): Promise<number>
}

type PgQueryable = Pick<pg.Pool | pg.PoolClient, 'query'>

function wrap(q: PgQueryable): SqlClient {
  return {
    async one<T>(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rows[0] as T | undefined
    },
    async many<T>(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rows as T[]
    },
    async exec(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rowCount ?? 0
    }
  }
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'

export interface Db extends SqlClient {
  pool: pg.Pool
  /** Runs fn in one transaction on one connection; rolls back on any error. */
  tx<T>(fn: (t: SqlClient) => Promise<T>, isolation?: IsolationLevel): Promise<T>
  close(): Promise<void>
}

export function createDb(connectionString: string, opts: { max?: number; applicationName?: string } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, application_name: opts.applicationName ?? 'bpoam-server' })
  const base = wrap(pool)
  return {
    ...base,
    pool,
    async tx<T>(fn: (t: SqlClient) => Promise<T>, isolation: IsolationLevel = 'read committed') {
      const client = await pool.connect()
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`)
        const result = await fn(wrap(client))
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end()
  }
}

/**
 * A Db bound to one connection that is already inside a transaction (used for idempotent
 * commands). Nested `tx()` calls become savepoints, so a service's own transaction rolls back
 * on error without ending the outer transaction.
 */
export function scopedDb(client: pg.PoolClient, base: Db): Db {
  const inner = wrap(client)
  let depth = 0
  return {
    ...inner,
    pool: base.pool,
    async tx<T>(fn: (t: SqlClient) => Promise<T>) {
      const name = `sp_${++depth}`
      await client.query(`SAVEPOINT ${name}`)
      try {
        const result = await fn(inner)
        await client.query(`RELEASE SAVEPOINT ${name}`)
        return result
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined)
        throw err
      } finally {
        depth--
      }
    },
    close: async () => undefined
  }
}

/** PostgreSQL error with SQLSTATE code (node-postgres DatabaseError). */
export function pgErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null
}
