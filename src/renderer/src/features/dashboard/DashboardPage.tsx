import { useEffect, useState } from 'react'
import type { DashboardSummary, SessionInfo } from '@shared/api'
import { call, formatDateTime } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel } from '../../components/ui'

export function DashboardPage({ session, navigate }: { session: SessionInfo; navigate: (id: string) => void }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    call('dashboard.getSummary').then(setSummary, setError)
  }, [])

  const canBackup = session.permissions.includes('backup.create')
  const lastBackupAgeHours = summary?.lastBackup ? (Date.now() - Date.parse(summary.lastBackup.createdAt)) / 3_600_000 : null

  return (
    <div className="stack">
      <PageHeader title={summary?.organizationName || 'Dashboard'} description="Figures are read from the local database each time this page opens." />
      <ErrorAlert error={error} />
      {canBackup && summary && (lastBackupAgeHours === null || lastBackupAgeHours > 24) ? (
        <Alert tone="warn">
          {summary.lastBackup ? 'The last backup is more than a day old.' : 'No backup has been made yet.'}{' '}
          <Button small onClick={() => navigate('backup')}>
            Open backup and recovery
          </Button>
        </Alert>
      ) : null}
      {summary ? (
        <div className="ledger" aria-label="System summary">
          <div className="ledger__cell">
            <div className="ledger__value">{summary.activeUsers}</div>
            <div className="ledger__label">Active user accounts</div>
          </div>
          <div className="ledger__cell">
            <div className="ledger__value">{summary.auditEventsLast7Days}</div>
            <div className="ledger__label">Audit events in the last 7 days</div>
          </div>
          <div className="ledger__cell">
            <div className="ledger__value ledger__value--text">{summary.lastBackup ? formatDateTime(summary.lastBackup.createdAt) : 'None yet'}</div>
            <div className="ledger__label">Last backup</div>
          </div>
          <div className="ledger__cell">
            <div className="ledger__value">v{summary.schemaVersion}</div>
            <div className="ledger__label">Database schema</div>
          </div>
        </div>
      ) : null}
      {summary?.assets ? (
        <>
          <h2>Assets</h2>
          <div className="ledger" aria-label="Asset summary">
            {[
              ['Active assets', summary.assets.totalActive],
              ['Ready to use', summary.assets.ready],
              ['Awaiting inspection', summary.assets.awaitingInspection],
              ['Not working', summary.assets.nonOperational],
              ['Under maintenance', summary.assets.underMaintenance],
              [`Warranty ending in ${summary.assets.warrantyWindowDays} days`, summary.assets.warrantyExpiringSoon]
            ].map(([label, value]) => (
              <button key={label as string} className="ledger__cell ledger__cell--link" onClick={() => navigate('assets')}>
                <div className="ledger__value">{value}</div>
                <div className="ledger__label">{label}</div>
              </button>
            ))}
          </div>
          <p className="faint">
            Out of service: {summary.assets.lost} lost, {summary.assets.retired} retired, {summary.assets.disposed} disposed (not counted as active).
            Assignment figures and pending exit clearances appear once allocation is delivered (M4).
          </p>
        </>
      ) : (
        <Panel title="Asset figures">
          <p className="muted">Asset figures are shown to users who can view the asset register.</p>
        </Panel>
      )}
    </div>
  )
}
