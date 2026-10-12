import type { PermissionKey } from '@shared/permissions'

/** Authenticated caller resolved by the IPC dispatcher. */
export interface Actor {
  userId: string
  permissions: ReadonlySet<PermissionKey>
}

export interface OpContext {
  correlationId: string
  actor: Actor
}
