import { useCallback, useEffect, useState } from 'react'
import type { SessionInfo, StartupState } from '@shared/api'
import { ApiError, call, onSessionInterrupted } from '../api'
import { ChangePasswordScreen } from '../features/auth/ChangePasswordScreen'
import { LoginScreen } from '../features/auth/LoginScreen'
import { SetupRequiredScreen } from '../features/auth/SetupRequiredScreen'
import { UnavailableScreen } from '../features/recovery/UnavailableScreen'
import { Shell } from '../features/shell/Shell'
import { useSessionKeepAlive } from './useSessionKeepAlive'

export const SESSION_EXPIRED_NOTICE = 'Your session has expired or was ended. Sign in again to continue.'

type Phase =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string; reference: string | null }
  | { kind: 'setup' }
  | { kind: 'login'; startup: StartupState; notice?: string }
  | { kind: 'session'; startup: StartupState; session: SessionInfo }

/**
 * Top-level state machine: server status → sign-in → (required password change) → app shell.
 * A page refresh restores the session from the HttpOnly cookie via `session.getCurrent`.
 */
export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  const boot = useCallback(async (notice?: string) => {
    try {
      const startup = await call('system.getStartupState')
      if (startup.status === 'setup_required') return setPhase({ kind: 'setup' })
      const session = await call('session.getCurrent')
      setPhase(session ? { kind: 'session', startup, session } : { kind: 'login', startup, ...(notice ? { notice } : {}) })
    } catch (err) {
      setPhase({
        kind: 'unavailable',
        message: err instanceof ApiError ? err.message : 'The application could not start.',
        reference: err instanceof ApiError && err.correlationId !== '-' ? err.correlationId : null
      })
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // An expired or revoked session detected by any request returns to sign-in.
  const expire = useCallback(() => {
    setPhase((p) => (p.kind === 'session' ? { kind: 'login', startup: p.startup, notice: SESSION_EXPIRED_NOTICE } : p))
  }, [])
  useEffect(() => onSessionInterrupted(expire), [expire])

  useSessionKeepAlive(phase.kind === 'session', expire)

  switch (phase.kind) {
    case 'loading':
      return (
        <div className="boot" role="status" aria-live="polite">
          Loading…
        </div>
      )
    case 'unavailable':
      return <UnavailableScreen message={phase.message} reference={phase.reference} onRetry={() => void boot()} />
    case 'setup':
      return <SetupRequiredScreen onRetry={() => void boot()} />
    case 'login':
      return (
        <LoginScreen
          {...(phase.notice ? { notice: phase.notice } : {})}
          onSignedIn={(s) => setPhase({ kind: 'session', startup: phase.startup, session: s })}
        />
      )
    case 'session': {
      const s = phase.session
      const setSession = (next: SessionInfo) => setPhase({ ...phase, session: next })
      if (s.user.mustChangePassword) return <ChangePasswordScreen session={s} onChanged={setSession} onSignOut={() => void boot()} />
      return <Shell session={s} environment={phase.startup.environment} onSignedOut={(notice) => void boot(notice)} />
    }
  }
}
