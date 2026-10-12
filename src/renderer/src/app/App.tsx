import { useCallback, useEffect, useState } from 'react'
import type { SessionInfo, StartupState } from '@shared/api'
import { call, onSessionInterrupted } from '../api'
import { ChangePasswordScreen } from '../features/auth/ChangePasswordScreen'
import { LockScreen } from '../features/auth/LockScreen'
import { LoginScreen } from '../features/auth/LoginScreen'
import { SetupScreen } from '../features/auth/SetupScreen'
import { RecoveryScreen } from '../features/recovery/RecoveryScreen'
import { Shell } from '../features/shell/Shell'
import { useIdleHeartbeat } from './useIdleHeartbeat'

type Phase =
  | { kind: 'loading' }
  | { kind: 'recovery'; startup: StartupState }
  | { kind: 'setup'; startup: StartupState }
  | { kind: 'login'; startup: StartupState; notice?: string }
  | { kind: 'session'; startup: StartupState; session: SessionInfo }

/** Top-level state machine: startup state → setup / login / lock / app shell. */
export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  const boot = useCallback(async (notice?: string) => {
    try {
      const startup = await call('system.getStartupState')
      if (startup.status === 'database_error') return setPhase({ kind: 'recovery', startup })
      if (startup.status === 'setup_required') return setPhase({ kind: 'setup', startup })
      const session = await call('session.getCurrent')
      setPhase(session ? { kind: 'session', startup, session } : { kind: 'login', startup, ...(notice ? { notice } : {}) })
    } catch (err) {
      setPhase({
        kind: 'recovery',
        startup: {
          status: 'database_error',
          appVersion: '',
          environment: 'production',
          error: { code: 'INTERNAL_ERROR', message: (err as Error).message, correlationId: '-' }
        }
      })
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // A lock or sign-out detected by any call moves to the matching screen.
  useEffect(
    () =>
      onSessionInterrupted((code) => {
        setPhase((p) => {
          if (p.kind !== 'session') return p
          if (code === 'SESSION_LOCKED') return { ...p, session: { ...p.session, locked: true } }
          return { kind: 'login', startup: p.startup, notice: 'Your session ended. Sign in again.' }
        })
      }),
    []
  )

  const session = phase.kind === 'session' ? phase.session : null
  useIdleHeartbeat(session, (locked) => {
    setPhase((p) => (p.kind === 'session' && p.session.locked !== locked ? { ...p, session: { ...p.session, locked } } : p))
  })

  switch (phase.kind) {
    case 'loading':
      return null
    case 'recovery':
      return <RecoveryScreen startup={phase.startup} onRetry={() => void boot()} />
    case 'setup':
      return <SetupScreen onDone={() => void boot('Setup is complete. Sign in with the Super Admin account you created.')} />
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
      if (s.locked) return <LockScreen session={s} onUnlocked={setSession} onSignOut={() => void boot()} />
      if (s.user.mustChangePassword) return <ChangePasswordScreen session={s} onChanged={setSession} onSignOut={() => void boot()} />
      return <Shell session={s} environment={phase.startup.environment} onSignedOut={(notice) => void boot(notice)} onLocked={() => setSession({ ...s, locked: true })} />
    }
  }
}
