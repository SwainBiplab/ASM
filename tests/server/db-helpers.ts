import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { inject } from 'vitest'
import { createDb, type Db } from '../../server/src/db/sql'
import { migrate } from '../../server/src/db/migrator'
import { MIGRATIONS } from '../../server/src/db/migrations'

export interface TestDatabase {
  db: Db
  url: string
  drop(): Promise<void>
}

/** Creates a fresh, empty database on the shared test cluster (optionally migrated). */
export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl')
  const name = `bpoam_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)
  const db = createDb(url, { max: 20, applicationName: 'bpoam-test' })
  if (opts.migrate !== false) await migrate(db, MIGRATIONS, '0.0.0-test')
  return {
    db,
    url,
    drop: async () => {
      await db.close()
      const a = new pg.Client({ connectionString: adminUrl })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await a.end()
    }
  }
}
