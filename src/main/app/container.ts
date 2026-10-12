import type { AppEnvironment, StartupState } from '@shared/api'
import { AuthService } from '../services/auth'
import { EmployeeImportService } from '../import/employeeImport'
import { setDocumentsRoot } from '../services/documents'
import { BackupService } from '../backup/backupService'
import { DatabaseManager } from '../database/manager'
import { SessionManager } from '../auth/session'
import { loadUserPermissions } from '../auth/permissions'
import { getSettings } from '../services/settings'
import type { SessionResolution } from '../ipc/dispatcher'
import type { Logger } from '../logging/logger'
import type { DataPaths } from './env'
import { isAppError } from './errors'
import { newCorrelationId } from './ids'

/** A file chosen by the user through a native dialog; the renderer never supplies paths. */
export interface PickedFile {
  fileName: string
  data: Uint8Array
}

export interface AppMeta {
  appVersion: string
  environment: AppEnvironment
  versions: { electron: string; chrome: string; node: string }
}

/** Composition root shared by the Electron entry point, smoke test and integration tests. */
export class AppContainer {
  readonly sessions: SessionManager
  readonly dbm: DatabaseManager
  readonly backups: BackupService
  readonly auth: AuthService
  readonly employeeImport: EmployeeImportService
  /** Opens the native CSV picker. Replaced in tests; null result means cancelled. */
  pickImportFile: () => Promise<PickedFile | null> = async () => null
  /** Native picker for document attachments (allow-listed types). */
  pickDocumentFile: () => Promise<PickedFile | null> = async () => null
  /** Native save dialog; returns the chosen absolute path or null if cancelled. */
  pickSavePath: (defaultName: string) => Promise<string | null> = async () => null
  /** Opens a stored, allow-listed document with the system viewer. */
  openPath: (absolutePath: string) => Promise<void> = async () => undefined
  startup: StartupState

  constructor(
    readonly paths: DataPaths,
    readonly logger: Logger,
    readonly meta: AppMeta,
    clock: () => number = Date.now
  ) {
    this.sessions = new SessionManager(clock)
    setDocumentsRoot(paths.documentsDir)
    this.dbm = new DatabaseManager(paths, logger, meta.appVersion, {
      beforeMigrate: async (db) => {
        await this.backups.createFrom(db, 'pre_migration', null, newCorrelationId())
      }
    })
    this.backups = new BackupService(this.dbm, logger, meta.appVersion)
    this.auth = new AuthService(() => this.dbm.db, this.sessions, clock)
    this.employeeImport = new EmployeeImportService(() => this.dbm.db, clock)
    this.startup = { status: 'database_error', appVersion: meta.appVersion, environment: meta.environment }
  }

  async init(): Promise<StartupState> {
    try {
      const status = await this.dbm.open()
      this.startup = { status, appVersion: this.meta.appVersion, environment: this.meta.environment }
      this.logger.info('startup', 'Database ready', { status, schemaVersion: this.dbm.schemaVersion() })
    } catch (err) {
      const correlationId = newCorrelationId()
      this.logger.error('startup', 'Database initialization failed', { correlationId, error: err })
      this.startup = {
        status: 'database_error',
        appVersion: this.meta.appVersion,
        environment: this.meta.environment,
        dataDirectory: this.paths.root,
        error: {
          code: isAppError(err) ? err.code : 'DATABASE_ERROR',
          message: (err as Error).message,
          correlationId
        }
      }
    }
    return this.startup
  }

  refreshStartupStatus(): void {
    if (this.dbm.isOpen) {
      this.startup = { status: this.dbm.status(), appVersion: this.meta.appVersion, environment: this.meta.environment }
    }
  }

  /** Re-reads permissions on every call so role changes and deactivation apply immediately. */
  resolveSession(): SessionResolution {
    if (!this.dbm.isOpen) return { state: 'none' }
    const db = this.dbm.db
    const check = this.sessions.check(getSettings(db).idleTimeoutMinutes)
    if (check.state === 'none') return { state: 'none' }
    const active = db.prepare('SELECT is_active AS a FROM users WHERE id = ?').get(check.session.userId) as { a: number } | undefined
    if (!active?.a) {
      this.sessions.end()
      return { state: 'none' }
    }
    const actor = { userId: check.session.userId, permissions: loadUserPermissions(db, check.session.userId) }
    return check.state === 'locked' ? { state: 'locked', actor } : { state: 'active', actor }
  }

  shutdown(): void {
    this.dbm.close()
  }
}
