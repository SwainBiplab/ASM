import { useEffect, useRef } from 'react'
import { call } from '../api'

const TOUCH_MS = 60_000
const POLL_MS = 30_000

/**
 * The server owns idle and absolute session expiry. This hook reports user activity at most
 * once a minute (sliding the idle timeout) and polls the session so an expired session sends
 * the user back to sign-in even when they are not clicking anything.
 */
export function useSessionKeepAlive(active: boolean, onExpired: () => void): void {
  const lastSent = useRef(0)
  const expired = useRef(onExpired)
  expired.current = onExpired

  useEffect(() => {
    if (!active) return
    const onActivity = () => {
      const now = Date.now()
      if (now - lastSent.current < TOUCH_MS) return
      lastSent.current = now
      call('session.touch').catch(() => undefined)
    }
    const check = () => {
      call('session.getCurrent')
        .then((s) => s === null && expired.current())
        .catch(() => undefined)
    }
    const onVisible = () => document.visibilityState === 'visible' && check()
    const events = ['keydown', 'mousedown', 'wheel', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    document.addEventListener('visibilitychange', onVisible)
    const poll = window.setInterval(check, POLL_MS)
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity))
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(poll)
    }
  }, [active])
}
