/**
 * In-memory session for the single desktop window. One user is signed in at a time;
 * the session locks after the configured idle timeout and must be unlocked with the
 * user's password (TAS §6.3).
 */
export interface ActiveSession {
  userId: string
  startedAt: number
  lastActivityAt: number
  locked: boolean
}

export type SessionCheck =
  | { state: 'none' }
  | { state: 'locked'; session: ActiveSession }
  | { state: 'active'; session: ActiveSession }

export class SessionManager {
  private session: ActiveSession | null = null

  constructor(private readonly clock: () => number = Date.now) {}

  start(userId: string): ActiveSession {
    const now = this.clock()
    this.session = { userId, startedAt: now, lastActivityAt: now, locked: false }
    return this.session
  }

  end(): void {
    this.session = null
  }

  /** Applies the idle timeout, then reports the session state without extending it. */
  check(idleTimeoutMinutes: number): SessionCheck {
    const s = this.session
    if (!s) return { state: 'none' }
    if (!s.locked && this.clock() - s.lastActivityAt > idleTimeoutMinutes * 60_000) s.locked = true
    return s.locked ? { state: 'locked', session: s } : { state: 'active', session: s }
  }

  touch(): void {
    if (this.session && !this.session.locked) this.session.lastActivityAt = this.clock()
  }

  lock(): void {
    if (this.session) this.session.locked = true
  }

  unlock(): void {
    if (this.session) {
      this.session.locked = false
      this.session.lastActivityAt = this.clock()
    }
  }
}
