import { useState, type FormEvent } from 'react'
import { call } from '../../api'
import { Alert, Button, ErrorAlert, TextField } from '../../components/ui'
import { AuthLayout } from './AuthLayout'

/**
 * Self-service "forgot password" request (U2). This never tells the submitter whether the
 * username matched a real account -- the confirmation message is identical either way, by design
 * (see `passwordReset.request` on the server). An administrator reviews and resets from the
 * Users screen; there is no automated email/reset-link delivery (requires B7, not yet decided).
 */
export function ForgotPasswordScreen({ onBack }: { onBack: () => void }) {
  const [username, setUsername] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await call('passwordReset.request', { username, ...(message.trim() ? { message: message.trim() } : {}) })
      setSent(true)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthLayout heading="Request sent" body="An administrator will reach out to reset your password if your account was found.">
        <div className="auth__form">
          <h2>Check with your administrator</h2>
          <Alert tone="success">If that username matches an account, an administrator has been notified. They'll contact you to complete the reset.</Alert>
          <div className="form-actions">
            <Button variant="primary" onClick={onBack}>Back to sign in</Button>
          </div>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout heading="Forgot your password?" body="Tell us your username and an administrator will be notified to reset it for you.">
      <form className="auth__form" onSubmit={submit} noValidate>
        <h2>Request a password reset</h2>
        <p className="muted">There's no automatic email reset yet -- an administrator will contact you directly.</p>
        <ErrorAlert error={error} />
        <div className="form-grid form-grid--single">
          <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          <TextField label="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} hint="Anything that helps an administrator find and verify you" />
        </div>
        <div className="form-actions">
          <Button onClick={onBack}>Back to sign in</Button>
          <Button type="submit" variant="primary" disabled={busy || !username.trim()}>
            {busy ? 'Sending…' : 'Send request'}
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
