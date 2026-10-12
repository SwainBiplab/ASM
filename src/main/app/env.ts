import { join } from 'node:path'
import type { AppEnvironment } from '@shared/api'

export interface DataPaths {
  root: string
  databaseDir: string
  databaseFile: string
  /** Written after a database has been initialized; guards against silent re-initialization. */
  initializedMarker: string
  documentsDir: string
  backupsDir: string
  logsDir: string
}

export const DATABASE_FILE_NAME = 'asset-management.sqlite'

export function resolveDataPaths(root: string): DataPaths {
  const databaseDir = join(root, 'database')
  return {
    root,
    databaseDir,
    databaseFile: join(databaseDir, DATABASE_FILE_NAME),
    initializedMarker: join(databaseDir, '.initialized'),
    documentsDir: join(root, 'documents'),
    backupsDir: join(root, 'backups'),
    logsDir: join(root, 'logs')
  }
}

/**
 * Production data lives under Electron's per-user appData directory (%APPDATA% on
 * Windows), separate from the install directory. Development and test runs use
 * distinct folders so they never touch production records.
 */
export function resolveDataRoot(opts: {
  appDataDir: string
  productName: string
  environment: AppEnvironment
  overrideDir?: string | undefined
}): string {
  if (opts.overrideDir) return opts.overrideDir
  const suffix = opts.environment === 'production' ? '' : ` (${opts.environment})`
  return join(opts.appDataDir, `${opts.productName}${suffix}`, 'data')
}

export function resolveEnvironment(isPackaged: boolean, envValue: string | undefined): AppEnvironment {
  if (envValue === 'test') return 'test'
  return isPackaged ? 'production' : 'development'
}
