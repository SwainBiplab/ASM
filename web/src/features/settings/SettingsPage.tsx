import { useEffect, useState } from 'react'
import type { SessionInfo } from '@shared/api'
import type { AppSettings } from '@shared/schemas'
import { ACKNOWLEDGMENT_POLICIES, ACKNOWLEDGMENT_POLICY_LABELS } from '@shared/allocations'
import { ApiError, call } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel, TextField } from '../../components/ui'
import { AssetCodeSettings } from './AssetCodeSettings'

export function SettingsPage({ session }: { session: SessionInfo }) {
  const canManage = session.permissions.includes('settings.manage')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    call('settings.get').then(setSettings, setError)
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
      <PageHeader title="Settings" description="Preferences for your organization. Changes apply to every user." />
      <ErrorAlert error={error} />
      {saved ? <Alert tone="success">Settings saved.</Alert> : null}
      {settings ? (
        <Panel title="Preferences">
          <div className="form-grid">
            <TextField label="Sign out after inactivity (minutes)" {...num('idleTimeoutMinutes')} hint="1 to 240" />
            <TextField label="Warranty expiry warning (days)" {...num('warrantyExpiryWindowDays')} hint="Used by the dashboard and asset filters" />
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
            <div className="field">
              <label className="field__label" htmlFor="ack-policy">Handover acknowledgment</label>
              <select
                id="ack-policy"
                className="select"
                disabled={!canManage}
                value={settings.handoverAcknowledgment}
                onChange={(e) => setSettings({ ...settings, handoverAcknowledgment: e.target.value as AppSettings['handoverAcknowledgment'] })}
              >
                {ACKNOWLEDGMENT_POLICIES.map((p) => <option key={p} value={p}>{ACKNOWLEDGMENT_POLICY_LABELS[p]}</option>)}
              </select>
              <span className="field__hint">How recipients confirm issued and transferred assets</span>
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
    </div>
  )
}
