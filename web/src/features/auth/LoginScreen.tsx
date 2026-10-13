import { useState, type FormEvent } from 'react'
import type { SessionInfo } from '@shared/api'
import { call } from '../../api'
import { Alert, Button, ErrorAlert, TextField } from '../../components/ui'
import { AuthLayout } from './AuthLayout'
import { ForgotPasswordScreen } from './ForgotPasswordScreen'

export function LoginScreen({ notice, onSignedIn }: { notice?: string; onSignedIn: (s: SessionInfo) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [forgotPassword, setForgotPassword] = useState(false)

  if (forgotPassword) return <ForgotPasswordScreen onBack={() => setForgotPassword(false)} />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await call('session.login', { username, password }))
    } catch (err) {
      setError(err)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout heading="Asset custody, on record" body="Track every laptop, headset, seat and fixture from purchase to disposal, with a full history of who held it.">
      <form className="auth__form" onSubmit={submit}>
        <h2>Sign in</h2>
        <p className="muted">Use the account your Super Admin created for you.</p>
        {notice && !error ? <Alert tone="info">{notice}</Alert> : null}
        <ErrorAlert error={error} />
        <div className="form-grid form-grid--single">
          <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="form-actions form-actions--split">
          <Button variant="quiet" onClick={() => setForgotPassword(true)}>Forgot your password?</Button>
          <Button type="submit" variant="primary" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
