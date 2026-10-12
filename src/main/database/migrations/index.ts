import type { Migration } from '../migrator'
import { migration0001 } from './0001_foundation'
import { migration0002 } from './0002_organization'
import { migration0003 } from './0003_assets'

/** Ordered list of all bundled migrations. Append only. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
