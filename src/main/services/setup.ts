import type { Database as DB } from 'better-sqlite3'
import { ROLE_TEMPLATES, SUPER_ADMIN_ROLE_KEY, resolveTemplatePermissions } from '@shared/permissions'
import { setupInputSchema, type SetupInput } from '@shared/schemas'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { hashPassword } from '../auth/password'
import { syncPermissionCatalog } from '../database/manager'
import { recordAudit } from './audit'

export function isSetupComplete(db: DB): boolean {
  return Boolean(db.prepare('SELECT 1 FROM organization_profile LIMIT 1').get())
}

/**
 * First-run setup: creates the single organization profile, default role templates and
 * the initial Super Admin in one transaction (TAS §4.4, §16.2). Rejected once completed.
 */
export async function completeSetup(db: DB, rawInput: SetupInput, correlationId: string): Promise<{ organizationId: string }> {
  const input = setupInputSchema.parse(rawInput)
  if (isSetupComplete(db)) throw new AppError('STATE_CONFLICT', 'Initial setup has already been completed.')

  const passwordHash = await hashPassword(input.admin.password)
  const now = nowIso()
  const orgId = newId()
  const adminId = newId()

  db.transaction(() => {
    // Re-check inside the transaction: the async hash above yields the event loop.
    if (isSetupComplete(db)) throw new AppError('STATE_CONFLICT', 'Initial setup has already been completed.')
    syncPermissionCatalog(db)

    db.prepare(
      `INSERT INTO organization_profile (id, legal_name, display_name, base_currency, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orgId, input.organization.legalName, input.organization.displayName, input.organization.baseCurrency, input.organization.timezone, now, now)

    const insertRole = db.prepare(
      'INSERT INTO roles (id, organization_id, key, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const grant = db.prepare('INSERT INTO role_permissions (role_id, permission_key, granted_at) VALUES (?, ?, ?)')
    let superAdminRoleId = ''
    for (const t of ROLE_TEMPLATES) {
      const roleId = newId()
      if (t.key === SUPER_ADMIN_ROLE_KEY) superAdminRoleId = roleId
      insertRole.run(roleId, orgId, t.key, t.name, t.description, t.key === SUPER_ADMIN_ROLE_KEY ? 1 : 0, now, now)
      for (const p of resolveTemplatePermissions(t)) grant.run(roleId, p, now)
    }

    db.prepare(
      `INSERT INTO users (id, organization_id, username, username_normalized, display_name, password_hash,
                          password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(adminId, orgId, input.admin.username, input.admin.username.toLowerCase(), input.admin.displayName, passwordHash, now, now, now)
    db.prepare('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)').run(adminId, superAdminRoleId, now)

    recordAudit(db, {
      actorUserId: adminId,
      eventType: 'setup.completed',
      entityType: 'organization_profile',
      entityId: orgId,
      correlationId,
      summary: {
        legalName: input.organization.legalName,
        baseCurrency: input.organization.baseCurrency,
        timezone: input.organization.timezone,
        adminUsername: input.admin.username
      }
    })
  })()

  return { organizationId: orgId }
}

export function getOrganizationName(db: DB): string {
  const row = db.prepare('SELECT display_name AS name FROM organization_profile LIMIT 1').get() as { name: string } | undefined
  return row?.name ?? ''
}

export function getOrganizationId(db: DB): string {
  const row = db.prepare('SELECT id FROM organization_profile LIMIT 1').get() as { id: string } | undefined
  if (!row) throw new AppError('STATE_CONFLICT', 'Initial setup has not been completed.')
  return row.id
}
