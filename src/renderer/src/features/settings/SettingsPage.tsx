import { useEffect, useState } from 'react'
import type { SessionInfo, SystemInfo } from '@shared/api'
import type { AppSettings } from '@shared/schemas'
import { ApiError, call } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel, TextField } from '../../components/ui'
import { AssetCodeSettings } from './AssetCodeSettings'

export function SettingsPage({ session }: { session: SessionInfo }) {
  const canManage = session.permissions.includes('settings.manage')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    call('settings.get').then(setSettings, setError)
    call('system.getInfo').then(setInfo, setError)
  }, [])

  const save = async () => {
    if (!settings) return
    setSaved(false)
    setError(null)
    setFields({})
    try {
      setSettings(await call('settings.update', settings))
      setSaved(true)
    } catch (err) {
      setError(err)
      if (err instanceof ApiError) setFields(err.fieldErrors)
    }
  }

  const num = (k: 'idleTimeoutMinutes' | 'backupRetentionCount' | 'warrantyExpiryWindowDays') => ({
    value: settings ? String(settings[k]) : '',
    disabled: !canManage,
    inputMode: 'numeric' as const,
    error: fields[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => settings && setSettings({ ...settings, [k]: Number(e.target.value) || 0 })
  })

  return (
    <div className="stack">
      <PageHeader title="Settings" description="Application preferences for this installation." />
      <ErrorAlert error={error} />
      {saved ? <Alert tone="success">Settings saved.</Alert> : null}
      {settings ? (
        <Panel title="Preferences">
          <div className="form-grid">
            <TextField label="Lock after inactivity (minutes)" {...num('idleTimeoutMinutes')} hint="1 to 240" />
            <TextField label="Backup generations to keep" {...num('backupRetentionCount')} hint="Applies to scheduled backups" />
            <TextField label="Warranty expiry warning (days)" {...num('warrantyExpiryWindowDays')} hint="Used by the dashboard once assets exist" />
            <div className="field">
              <label className="field__label" htmlFor="scanner-suffix">USB scanner suffix</label>
              <select
                id="scanner-suffix"
                className="select"
                disabled={!canManage}
                value={settings.scannerSuffix}
                onChange={(e) => setSettings({ ...settings, scannerSuffix: e.target.value as AppSettings['scannerSuffix'] })}
              >
                <option value="enter">Enter</option>
                <option value="tab">Tab</option>
                <option value="none">None</option>
              </select>
              <span className="field__hint">The key your scanner sends after each code</span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="dup-email">Duplicate employee email</label>
              <select
                id="dup-email"
                className="select"
                disabled={!canManage}
                value={settings.employeeDuplicateEmailPolicy}
                onChange={(e) => setSettings({ ...settings, employeeDuplicateEmailPolicy: e.target.value as AppSettings['employeeDuplicateEmailPolicy'] })}
              >
                <option value="warn">Allow, with a warning</option>
                <option value="reject">Reject the record</option>
              </select>
              <span className="field__hint">Employee IDs must always be unique; this applies to email addresses only</span>
            </div>
          </div>
          {canManage ? (
            <div className="form-actions">
              <Button variant="primary" onClick={() => void save()}>Save settings</Button>
            </div>
          ) : (
            <p className="faint">Only users with settings permission can change these values.</p>
          )}
        </Panel>
      ) : null}
      {session.permissions.includes('assets.view') || session.permissions.includes('assets.configure_codes') ? (
        <AssetCodeSettings canConfigure={session.permissions.includes('assets.configure_codes')} />
      ) : null}
      {info ? (
        <Panel title="About this installation">
          <dl className="dl">
            <dt>Organization</dt>
            <dd>{info.organizationName}</dd>
            <dt>Application version</dt>
            <dd>{info.appVersion} ({info.environment})</dd>
            <dt>Database schema</dt>
            <dd>v{info.schemaVersion}, SQLite {info.sqliteVersion}</dd>
            <dt>Runtime</dt>
            <dd>Electron {info.electronVersion}, Chromium {info.chromeVersion}, Node {info.nodeVersion}, {info.platform}</dd>
            <dt>Data folder</dt>
            <dd>{info.dataDirectory}</dd>
            <dt>Database file</dt>
            <dd>{info.databasePath}</dd>
            <dt>Backups</dt>
            <dd>{info.backupDirectory}</dd>
            <dt>Logs</dt>
            <dd>{info.logDirectory}</dd>
          </dl>
        </Panel>
      ) : null}
    </div>
  )
}
