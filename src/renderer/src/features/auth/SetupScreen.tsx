import { useState, type FormEvent } from 'react'
import { PASSWORD_MIN_LENGTH } from '@shared/constants'
import { ApiError, call } from '../../api'
import { Button, ErrorAlert, TextField } from '../../components/ui'
import { AuthLayout } from './AuthLayout'

const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

/** First-run setup: one organization profile plus the initial Super Admin (TAS §4.4). */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    legalName: '',
    displayName: '',
    baseCurrency: 'INR',
    timezone: detectedTimezone,
    username: '',
    adminName: '',
    password: '',
    confirm: ''
  })
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setFields({})
    if (form.password !== form.confirm) {
      setFields({ 'admin.confirm': 'Passwords do not match' })
      return
    }
    setBusy(true)
    try {
      await call('setup.complete', {
        organization: { legalName: form.legalName, displayName: form.displayName, baseCurrency: form.baseCurrency.toUpperCase(), timezone: form.timezone },
        admin: { username: form.username, displayName: form.adminName, password: form.password }
      })
      onDone()
    } catch (err) {
      setError(err)
      if (err instanceof ApiError) setFields(err.fieldErrors)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      heading="Set up this installation"
      body="Create the organization profile and the first Super Admin. The Super Admin then adds users, roles and approval rules."
    >
      <form className="auth__form auth__form--wide" onSubmit={submit} noValidate>
        <h2>Initial setup</h2>
        <p className="muted">This runs once. The organization profile cannot be duplicated later.</p>
        <ErrorAlert error={error} />
        <div className="form-section">
          <h2>Organization</h2>
          <div className="form-grid">
            <TextField label="Legal name" value={form.legalName} onChange={set('legalName')} error={fields['organization.legalName']} required />
            <TextField label="Display name" value={form.displayName} onChange={set('displayName')} error={fields['organization.displayName']} required />
            <TextField
              label="Base currency"
              value={form.baseCurrency}
              onChange={set('baseCurrency')}
              hint="3-letter ISO code. Amounts are stored in minor units."
              error={fields['organization.baseCurrency']}
              maxLength={3}
            />
            <TextField label="Time zone" value={form.timezone} onChange={set('timezone')} hint="IANA name, e.g. Asia/Kolkata" error={fields['organization.timezone']} />
          </div>
        </div>
        <div className="form-section">
          <h2>Super Admin account</h2>
          <div className="form-grid">
            <TextField label="Username" value={form.username} onChange={set('username')} autoComplete="off" error={fields['admin.username']} />
            <TextField label="Full name" value={form.adminName} onChange={set('adminName')} error={fields['admin.displayName']} />
            <TextField
              label="Password"
              type="password"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters`}
              error={fields['admin.password']}
            />
            <TextField label="Confirm password" type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" error={fields['admin.confirm']} />
          </div>
        </div>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create organization and Super Admin'}
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
