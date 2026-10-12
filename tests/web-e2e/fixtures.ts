/**
 * Test-only fixtures for the browser E2E suite (never used by the application or production).
 * Run as a separate process against a throwaway database created by global-setup.ts.
 */
import { createDb } from '../../server/src/db/sql'
import { migrate } from '../../server/src/db/migrator'
import { MIGRATIONS } from '../../server/src/db/migrations'
import { newCorrelationId } from '../../server/src/core'
import { loadUserPermissions } from '../../server/src/services/foundation'
import { bootstrapOrganization, createUser } from '../../server/src/services/identity'
import { E2E_ADMIN, E2E_USERS, E2E_ORG } from './accounts'

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url || !/\/bpoam_e2e_[a-f0-9]+$/.test(url)) throw new Error('fixtures refuse to run outside a bpoam_e2e_* test database')
  const db = createDb(url, { max: 4, applicationName: 'bpoam-e2e-fixtures' })
  try {
    await migrate(db, MIGRATIONS, '0.0.0-e2e')
    const { organizationId, adminUserId } = await bootstrapOrganization(db, { organization: E2E_ORG, admin: E2E_ADMIN }, newCorrelationId())
    const ctx = { correlationId: newCorrelationId(), ip: null, actor: { userId: adminUserId, organizationId, permissions: await loadUserPermissions(db, organizationId, adminUserId) } }
    for (const u of Object.values(E2E_USERS)) {
      await createUser(db, { username: u.username, displayName: u.displayName, password: u.password, roleKeys: [...u.roleKeys] }, ctx)
      if (!u.mustChangePassword) await db.exec('UPDATE users SET must_change_password = false WHERE organization_id = $1 AND username_normalized = $2', [organizationId, u.username])
    }
    await db.exec('UPDATE users SET must_change_password = false WHERE id = $1', [adminUserId])
  } finally {
    await db.close()
  }
}

main().catch((err: unknown) => {
  console.error('E2E fixtures failed:', (err as Error).message)
  process.exit(1)
})
