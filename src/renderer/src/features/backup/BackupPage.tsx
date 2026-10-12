import { useCallback, useEffect, useState } from 'react'
import type { BackupSummary, BackupValidation, SessionInfo } from '@shared/api'
import { RESTORE_CONFIRMATION_PHRASE } from '@shared/constants'
import { call, formatBytes, formatDateTime } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, TextField } from '../../components/ui'

const KIND_LABEL: Record<BackupSummary['kind'], string> = {
  manual: 'Manual',
  automatic: 'Scheduled',
  pre_migration: 'Before upgrade',
  pre_restore: 'Before restore'
}

export function BackupPage({ session, onRestored }: { session: SessionInfo; onRestored: () => void }) {
  const canCreate = session.permissions.includes('backup.create')
  const canRestore = session.permissions.includes('backup.restore')
  const [backups, setBackups] = useState<BackupSummary[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [validation, setValidation] = useState<BackupValidation | null>(null)
  const [restoring, setRestoring] = useState<BackupSummary | null>(null)

  const load = useCallback(() => {
    if (canCreate) call('backup.list').then(setBackups, setError)
  }, [canCreate])
  useEffect(load, [load])

  const create = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const b = await call('backup.create')
      setNotice(`Backup created and verified (${formatBytes(b.databaseBytes)}, ${b.documentCount} documents).`)
      load()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const validate = async (b: BackupSummary) => {
    setError(null)
    try {
      setValidation(await call('backup.validate', { backupId: b.backupId }))
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Backup and recovery"
        description="Each backup is a consistent copy of the database plus all attached documents, with checksums. Older generations are kept."
        actions={canCreate ? <Button variant="primary" disabled={busy} onClick={() => void create()}>{busy ? 'Backing up…' : 'Back up now'}</Button> : null}
      />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Alert tone="info">
        Backups are currently saved inside this computer's data folder. Copy them to an external drive or approved protected location
        regularly; a disk failure would otherwise lose both the data and its backups. Scheduled backups arrive in a later milestone.
      </Alert>
      {validation ? (
        <Alert tone={validation.valid ? 'success' : 'error'}>
          {validation.valid ? 'This backup passed all checks: manifest, checksums, database integrity and schema compatibility.' : `This backup failed validation: ${validation.problems.join(' ')}`}
        </Alert>
      ) : null}

      <Panel title="Backup generations" flush>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Created</th>
                <th>Type</th>
                <th>Schema</th>
                <th className="num">Database</th>
                <th className="num">Documents</th>
                <th>Status</th>
                <th className="actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.backupId}>
                  <td className="num">{formatDateTime(b.createdAt)}</td>
                  <td>{KIND_LABEL[b.kind]}</td>
                  <td className="num">v{b.schemaVersion}</td>
                  <td className="num">{formatBytes(b.databaseBytes)}</td>
                  <td className="num">{b.documentCount}</td>
                  <td>
                    <span className={`badge ${b.verified ? 'badge--ok' : 'badge--off'}`}>{b.verified ? 'Verified' : 'Unverified'}</span>
                  </td>
                  <td className="actions">
                    <Button small variant="quiet" onClick={() => void validate(b)}>Check</Button>
                    {canRestore ? (
                      <Button small variant="quiet" onClick={() => setRestoring(b)}>Restore</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {backups.length === 0 ? <div className="empty">No backups yet. Use Back up now to create the first one.</div> : null}
        </div>
      </Panel>

      {restoring ? <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} onRestored={onRestored} /> : null}
    </div>
  )
}

function RestoreDialog({ backup, onClose, onRestored }: { backup: BackupSummary; onClose: () => void; onRestored: () => void }) {
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => !busy && onClose(), [busy, onClose])

  const restore = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('backup.restore', { backupId: backup.backupId, confirmation: RESTORE_CONFIRMATION_PHRASE })
      onRestored()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Restore this backup?"
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="danger" disabled={busy || phrase !== RESTORE_CONFIRMATION_PHRASE} onClick={() => void restore()}>
            {busy ? 'Restoring…' : 'Replace current data'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <p>
          All records and documents will be replaced with the backup from <strong>{formatDateTime(backup.createdAt)}</strong>. Changes made
          after that time will no longer appear.
        </p>
        <p className="muted">
          A safety backup of the current data is taken first, so this can be reversed. Everyone is signed out when the restore finishes.
        </p>
        <TextField
          label={`Type ${RESTORE_CONFIRMATION_PHRASE} to confirm`}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
        />
      </div>
    </Dialog>
  )
}
