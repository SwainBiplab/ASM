import type { Database as DB } from 'better-sqlite3'
import type { AssetMetrics, BackupSummary, DashboardSummary } from '@shared/api'
import { currentSchemaVersion } from '../database/migrator'
import { getOrganizationName } from './setup'

/** Live counts only — no hardcoded metrics. Asset metrics arrive with their modules. */
export function getDashboardSummary(db: DB, lastBackup: BackupSummary | null, assets: AssetMetrics | null): DashboardSummary {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  return {
    organizationName: getOrganizationName(db),
    activeUsers: (db.prepare('SELECT count(*) AS n FROM users WHERE is_active = 1').get() as { n: number }).n,
    auditEventsLast7Days: (db.prepare('SELECT count(*) AS n FROM audit_events WHERE occurred_at >= ?').get(sevenDaysAgo) as { n: number }).n,
    lastBackup,
    schemaVersion: currentSchemaVersion(db),
    assets
  }
}
