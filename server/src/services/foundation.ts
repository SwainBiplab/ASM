import { ALL_PERMISSION_KEYS, PERMISSIONS, isPermissionKey, SUPER_ADMIN_ROLE_KEY, type PermissionKey } from '@shared/permissions'
import { DEFAULT_SETTINGS, settingsSchema, settingsUpdateInputSchema, type AppSettings, type SettingsUpdateInput } from '@shared/schemas'
import { auditListInputSchema, type AuditListInput } from '@shared/schemas'
import type { AuditEventView, Page } from '@shared/api'
import { assertPermission, newId, redact, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'

// ---------------------------------------------------------------- permissions

/** Aligns the permissions table with the code catalog; every Super Admin role holds all keys. */
export async function syncPermissionCatalog(db: Db): Promise<void> {
  await db.tx(async (t) => {
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      await t.exec('INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description', [key, description])
    }
    await t.exec(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, p.key FROM roles r CROSS JOIN permissions p WHERE r.key = $1
       ON CONFLICT DO NOTHING`,
      [SUPER_ADMIN_ROLE_KEY]
    )
  })
}

/** Effective permissions of an active user, scoped to the user's organization. */
export async function loadUserPermissions(c: SqlClient, organizationId: string, userId: string): Promise<Set<PermissionKey>> {
  const rows = await c.many<{ key: string }>(
    `SELECT DISTINCT rp.permission_key AS key
     FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE u.id = $1 AND u.organization_id = $2 AND u.is_active`,
    [userId, organizationId]
  )
  return new Set(rows.map((r) => r.key).filter(isPermissionKey))
}

export const allPermissions = (): PermissionKey[] => [...ALL_PERMISSION_KEYS]

// ---------------------------------------------------------------- audit

export interface AuditEntry {
  organizationId: string | null
  actorUserId: string | null
  eventType: string
  entityType: string
  entityId?: string | null
  reason?: string | null
  correlationId: string
  ip?: string | null
  summary?: Record<string, unknown>
}

/** Appends an audit event; call with the transaction client of the business change. */
export async function recordAudit(c: SqlClient, e: AuditEntry): Promise<void> {
  await c.exec(
    `INSERT INTO audit_events (id, organization_id, actor_user_id, event_type, entity_type, entity_id, reason, correlation_id, ip_address, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId(), e.organizationId, e.actorUserId, e.eventType, e.entityType, e.entityId ?? null, e.reason ?? null, e.correlationId, e.ip ?? null, e.summary ? JSON.stringify(redact(e.summary)) : null]
  )
}

export const auditFrom = (ctx: OpContext) => ({ organizationId: ctx.actor.organizationId, actorUserId: ctx.actor.userId, correlationId: ctx.correlationId, ip: ctx.ip })

export async function listAuditEvents(db: Db, raw: AuditListInput, ctx: OpContext): Promise<Page<AuditEventView>> {
  assertPermission(ctx.actor.permissions, 'audit_log.view')
  const input = auditListInputSchema.parse(raw)
  const where = ['a.organization_id = $1']
  const params: unknown[] = [ctx.actor.organizationId]
  if (input.eventType) where.push(`a.event_type = $${params.push(input.eventType)}`)
  if (input.entityType) where.push(`a.entity_type = $${params.push(input.entityType)}`)
  const whereSql = where.join(' AND ')
  const total = (await db.one<{ n: number }>(`SELECT count(*) AS n FROM audit_events a WHERE ${whereSql}`, params))!.n
  const items = await db.many<AuditEventView>(
    `SELECT a.id, a.occurred_at AS "occurredAt", a.actor_user_id AS "actorUserId", u.display_name AS "actorName", a.event_type AS "eventType",
            a.entity_type AS "entityType", a.entity_id AS "entityId", a.reason, a.correlation_id AS "correlationId", a.summary
     FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${whereSql} ORDER BY a.occurred_at DESC, a.seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, input.pageSize, (input.page - 1) * input.pageSize]
  )
  return { items, total, page: input.page, pageSize: input.pageSize }
}

// ---------------------------------------------------------------- settings

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>

export async function getSettings(c: SqlClient, organizationId: string): Promise<AppSettings> {
  const rows = await c.many<{ key: string; value: unknown }>('SELECT key, value FROM app_settings WHERE organization_id = $1', [organizationId])
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const r of rows) if ((SETTING_KEYS as string[]).includes(r.key)) merged[r.key] = r.value
  const parsed = settingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS }
}

export async function updateSettings(db: Db, raw: SettingsUpdateInput, ctx: OpContext): Promise<AppSettings> {
  assertPermission(ctx.actor.permissions, 'settings.manage')
  const input = settingsUpdateInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const before = await getSettings(t, org)
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of SETTING_KEYS) {
      const value = input[key]
      if (value === undefined || value === before[key]) continue
      await t.exec(
        `INSERT INTO app_settings (organization_id, key, value, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [org, key, JSON.stringify(value), ctx.actor.userId]
      )
      changes[key] = { from: before[key], to: value }
    }
    if (Object.keys(changes).length) await recordAudit(t, { ...auditFrom(ctx), eventType: 'settings.updated', entityType: 'app_settings', summary: changes })
    return getSettings(t, org)
  })
}
