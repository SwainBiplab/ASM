import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { Database as DB } from 'better-sqlite3'
import { PERMISSIONS, SUPER_ADMIN_ROLE_KEY } from '@shared/permissions'
import type { DataPaths } from '../app/env'
import { AppError, isAppError } from '../app/errors'
import { nowIso } from '../app/ids'
import type { Logger } from '../logging/logger'
import { integrityCheck, openDatabase } from './connection'
import { MIGRATIONS } from './migrations'
import { applyMigrations, currentSchemaVersion, planMigrations, type Migration, type MigrationPlan } from './migrator'

export type OpenStatus = 'ready' | 'setup_required'

export interface DatabaseHooks {
  /** Runs before migrating an existing database, e.g. to take a safety backup. */
  beforeMigrate?: (db: DB, plan: MigrationPlan) => Promise<void>
}

/** Owns the single live SQLite connection for the main process. */
export class DatabaseManager {
  private conn: DB | null = null

  constructor(
    readonly paths: DataPaths,
    private readonly logger: Logger,
    private readonly appVersion: string,
    private readonly hooks: DatabaseHooks = {},
    private readonly migrations: readonly Migration[] = MIGRATIONS
  ) {}

  get db(): DB {
    if (!this.conn) throw new AppError('DATABASE_ERROR', 'The database is not open.')
    return this.conn
  }

  get isOpen(): boolean {
    return this.conn !== null
  }

  /**
   * Opens, verifies and migrates the database. Never silently creates a blank database
   * over a previously initialized installation (TAS §15, §16.2).
   */
  async open(): Promise<OpenStatus> {
    if (this.conn) return this.status()
    const { databaseFile, initializedMarker } = this.paths
    const previouslyInitialized = existsSync(initializedMarker)

    if (!existsSync(databaseFile) && previouslyInitialized) {
      throw new AppError(
        'DATABASE_ERROR',
        'The database file is missing, but this installation was previously initialized. Restore it from a backup instead of starting with an empty database.'
      )
    }

    for (const dir of [this.paths.databaseDir, this.paths.documentsDir, this.paths.backupsDir]) {
      mkdirSync(dir, { recursive: true })
    }

    let db: DB
    try {
      db = openDatabase(databaseFile)
    } catch (err) {
      throw new AppError('DATABASE_ERROR', `The database could not be opened: ${(err as Error).message}`)
    }

    try {
      const problems = integrityCheck(db, 'quick')
      if (problems.length) {
        throw new AppError('DATABASE_ERROR', `Database integrity check failed: ${problems.slice(0, 3).join('; ')}`)
      }
      const plan = planMigrations(db, this.migrations)
      if (plan.currentVersion === 0 && previouslyInitialized) {
        throw new AppError(
          'DATABASE_ERROR',
          'The database is empty, but this installation was previously initialized. Restore it from a backup.'
        )
      }
      if (plan.pending.length) {
        if (plan.currentVersion > 0) {
          this.logger.info('database', 'Migrating database', { from: plan.currentVersion, to: plan.targetVersion })
          await this.hooks.beforeMigrate?.(db, plan)
        }
        applyMigrations(db, plan.pending, this.appVersion)
      }
      syncPermissionCatalog(db)
      writeFileSync(initializedMarker, JSON.stringify({ initializedAt: nowIso() }), 'utf8')
    } catch (err) {
      db.close()
      if (isAppError(err)) throw err
      throw new AppError('DATABASE_ERROR', `Database initialization failed: ${(err as Error).message}`)
    }

    this.conn = db
    return this.status()
  }

  status(): OpenStatus {
    const row = this.db.prepare('SELECT 1 FROM organization_profile LIMIT 1').get()
    return row ? 'ready' : 'setup_required'
  }

  schemaVersion(): number {
    return currentSchemaVersion(this.db)
  }

  close(): void {
    this.conn?.close()
    this.conn = null
  }
}

/** Keeps the permissions table aligned with the code catalog; Super Admin holds every key. */
export function syncPermissionCatalog(db: DB): void {
  const upsert = db.prepare(
    'INSERT INTO permissions (key, description) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET description = excluded.description'
  )
  const grantSuperAdmin = db.prepare(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_key, granted_at)
     SELECT r.id, p.key, ? FROM roles r CROSS JOIN permissions p WHERE r.key = ?`
  )
  db.transaction(() => {
    for (const [key, description] of Object.entries(PERMISSIONS)) upsert.run(key, description)
    grantSuperAdmin.run(nowIso(), SUPER_ADMIN_ROLE_KEY)
  })()
}
