import type { CommandMap, CommandName } from './api'

/**
 * The typed seam between a screen and how it reaches the server (D48 "UI reuse assessment").
 * `web/src/api.ts`'s `call()` already has this exact signature; it is not changed to implement
 * this interface yet (that refactor is separate, future work) -- this file only extracts the
 * contract so a future `DesktopApiAdapter` (agent/) can be written against it without guessing.
 */
export interface CloudCommandClient {
  call<K extends CommandName>(command: K, ...args: CommandMap[K]['input'] extends void ? [] : [CommandMap[K]['input']]): Promise<CommandMap[K]['output']>
}

/**
 * The local SQLite side of the future desktop agent. Deliberately minimal for W9.3 phase 1: only
 * the device's own local identity exists today. Lease caching, an outbox, and sync state are W9.4+
 * concerns and are not guessed at here -- adding fields speculatively would just be wrong later.
 */
export interface LocalDeviceStore {
  getLocalDevice(): Promise<{ id: string; createdAt: string } | null>
}
