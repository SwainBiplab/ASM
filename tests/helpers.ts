import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandMap, CommandName } from '../src/shared/api'
import type { Result } from '../src/shared/errors'
import { AppContainer } from '../src/main/app/container'
import { resolveDataPaths } from '../src/main/app/env'
import { buildCommands } from '../src/main/ipc/commands'
import { createDispatcher } from '../src/main/ipc/dispatcher'
import { silentLogger } from '../src/main/logging/logger'

export const ADMIN = { username: 'admin', displayName: 'Admin User', password: 'Correct-Horse-1' }

export const SETUP_INPUT = {
  organization: { legalName: 'Test BPO Pvt Ltd', displayName: 'Test BPO', baseCurrency: 'INR', timezone: 'Asia/Kolkata' },
  admin: ADMIN
}

export function makeTempDir(prefix = 'bpoam-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface TestApp {
  root: string
  container: AppContainer
  clock: { now: number }
  call<K extends CommandName>(command: K, payload?: CommandMap[K]['input']): Promise<Result<CommandMap[K]['output']>>
  ok<K extends CommandName>(command: K, payload?: CommandMap[K]['input']): Promise<CommandMap[K]['output']>
  /** Makes the next `employees.importSelectFile` return this file (null = user cancelled). */
  setPickedFile(file: { fileName: string; content: string | Uint8Array } | null): void
  cleanup(): void
}

/** Real container + dispatcher on a throwaway data directory (no mocked database). */
export async function createTestApp(root = makeTempDir()): Promise<TestApp> {
  const clock = { now: Date.now() }
  const container = new AppContainer(
    resolveDataPaths(root),
    silentLogger,
    { appVersion: '0.0.0-test', environment: 'test', versions: { electron: 'n/a', chrome: 'n/a', node: process.versions.node } },
    () => clock.now
  )
  await container.init()
  const dispatch = createDispatcher({
    commands: buildCommands(container),
    resolveSession: () => container.resolveSession(),
    touchSession: () => container.sessions.touch(),
    logger: silentLogger
  })
  const call = ((command: string, payload?: unknown) => dispatch(command, payload)) as TestApp['call']
  const ok = (async (command: CommandName, payload?: unknown) => {
    const r = await dispatch(command, payload)
    if (!r.ok) throw new Error(`${command} failed: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.fieldErrors ?? {})}`)
    return r.data
  }) as TestApp['ok']
  return {
    root,
    container,
    clock,
    call,
    ok,
    setPickedFile: (file) => {
      container.pickImportFile = async () =>
        file ? { fileName: file.fileName, data: typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content } : null
    },
    cleanup: () => {
      container.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Completes first-run setup and signs in as the Super Admin. */
export async function createReadyApp(root?: string): Promise<TestApp> {
  const app = await createTestApp(root)
  await app.ok('setup.complete', SETUP_INPUT)
  await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
  return app
}

/** Signs out and signs in as a new user holding the given roles. */
export async function switchToNewUser(app: TestApp, username: string, roleKeys: string[]): Promise<void> {
  const password = 'Test-Password-1'
  await app.ok('session.logout')
  await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
  await app.ok('users.create', { username, displayName: username, password, roleKeys })
  await app.ok('session.logout')
  await app.ok('session.login', { username, password })
}

export async function loginAsAdmin(app: TestApp): Promise<void> {
  await app.ok('session.logout')
  await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
}
