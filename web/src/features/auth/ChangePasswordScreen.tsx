import { useState, type FormEvent } from 'react'
import type { SessionInfo } from '@shared/api'
import { PASSWORD_MIN_LENGTH } from '@shared/constants'
import { ApiError, call } from '../../api'
import { Button, ErrorAlert, TextField } from '../../components/ui'
import { AuthLayout } from './AuthLayout'

/** Shown when an administrator created or reset the account password. */
export function ChangePasswordScreen({ session, onChanged, onSignOut }: { session: SessionInfo; onChanged: (s: SessionInfo) => void; onSignOut: () => void }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (form.newPassword !== form.confirm) return setFields({ confirm: 'Passwords do not match' })
    setFields({})
    setBusy(true)
    try {
      onChanged(await call('session.changePassword', { currentPassword: form.currentPassword, newPassword: form.newPassword }))
    } catch (err) {
      setError(err)
      if (err instanceof ApiError) setFields(err.fieldErrors)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout heading="Choose your own password" body="Your password was set by an administrator. Replace it before continuing.">
      <form className="auth__form" onSubmit={submit} noValidate>
        <h2>Change password</h2>
        <p className="muted">Signed in as {session.user.username}.</p>
        <ErrorAlert error={error} />
        <div className="form-grid form-grid--single">
          <TextField label="Current password" type="password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} error={fields['currentPassword']} />
          <TextField
            label="New password"
            type="password"
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters`}
            error={fields['newPassword']}
          />
          <TextField label="Confirm new password" type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} error={fields['confirm']} />
        </div>
        <div className="form-actions">
          <Button onClick={() => void call('session.logout').finally(onSignOut)}>Sign out</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Change password
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
