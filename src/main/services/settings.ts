import type { Database as DB } from 'better-sqlite3'
import {
  DEFAULT_SETTINGS,
  settingsSchema,
  settingsUpdateInputSchema,
  type AppSettings,
  type SettingsUpdateInput
} from '@shared/schemas'
import { assertPermission } from '../auth/permissions'
import { nowIso } from '../app/ids'
import { recordAudit } from './audit'
import type { OpContext } from './context'

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>

/** Reads allow-listed settings, falling back to defaults for unset or invalid values. */
export function getSettings(db: DB): AppSettings {
  const rows = db.prepare('SELECT key, value_json AS valueJson FROM app_settings').all() as Array<{
    key: string
    valueJson: string
  }>
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    if ((SETTING_KEYS as string[]).includes(row.key)) merged[row.key] = JSON.parse(row.valueJson)
  }
  const parsed = settingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS }
}

export function updateSettings(db: DB, rawInput: SettingsUpdateInput, ctx: OpContext): AppSettings {
  assertPermission(ctx.actor.permissions, 'settings.manage')
  const input = settingsUpdateInputSchema.parse(rawInput)
  const before = getSettings(db)
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  )
  db.transaction(() => {
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of SETTING_KEYS) {
      const value = input[key]
      if (value === undefined || value === before[key]) continue
      upsert.run(key, JSON.stringify(value), nowIso(), ctx.actor.userId)
      changes[key] = { from: before[key], to: value }
    }
    if (Object.keys(changes).length) {
      recordAudit(db, {
        actorUserId: ctx.actor.userId,
        eventType: 'settings.updated',
        entityType: 'app_settings',
        correlationId: ctx.correlationId,
        summary: changes
      })
    }
  })()
  return getSettings(db)
}
