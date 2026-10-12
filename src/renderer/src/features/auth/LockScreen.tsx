import { useState, type FormEvent } from 'react'
import type { SessionInfo } from '@shared/api'
import { call } from '../../api'
import { Button, ErrorAlert, TextField } from '../../components/ui'
import { AuthLayout } from './AuthLayout'

export function LockScreen({ session, onUnlocked, onSignOut }: { session: SessionInfo; onUnlocked: (s: SessionInfo) => void; onSignOut: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onUnlocked(await call('session.unlock', { password }))
    } catch (err) {
      setError(err)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await call('session.logout').catch(() => undefined)
    onSignOut()
  }

  return (
    <AuthLayout heading="Session locked" body={`The session locked after ${session.idleTimeoutMinutes} minutes without activity.`}>
      <form className="auth__form" onSubmit={submit}>
        <h2>Unlock</h2>
        <p className="muted">Signed in as {session.user.displayName} ({session.user.username}).</p>
        <ErrorAlert error={error} />
        <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        <div className="form-actions">
          <Button onClick={() => void signOut()}>Sign out</Button>
          <Button type="submit" variant="primary" disabled={busy || !password}>
            Unlock
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}
