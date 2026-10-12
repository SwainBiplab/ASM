import { useEffect, useRef } from 'react'
import type { SessionInfo } from '@shared/api'
import { call } from '../api'

const HEARTBEAT_MS = 60_000
const POLL_MS = 20_000

/**
 * Reports keyboard/mouse activity to the main process (at most once a minute) and polls
 * the session so the lock screen appears when the idle timeout expires. The main process
 * owns the timeout; this hook only mirrors it.
 */
export function useIdleHeartbeat(session: SessionInfo | null, onLockChange: (locked: boolean) => void): void {
  const lastSent = useRef(0)
  const active = session !== null && !session.locked
  const callback = useRef(onLockChange)
  callback.current = onLockChange

  useEffect(() => {
    if (!active) return
    const onActivity = () => {
      const now = Date.now()
      if (now - lastSent.current < HEARTBEAT_MS) return
      lastSent.current = now
      call('session.touch').catch(() => undefined)
    }
    const events = ['keydown', 'mousedown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    const poll = window.setInterval(() => {
      call('session.getCurrent')
        .then((s) => s && callback.current(s.locked))
        .catch(() => undefined)
    }, POLL_MS)
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity))
      window.clearInterval(poll)
    }
  }, [active])
}
