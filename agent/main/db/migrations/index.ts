import type { Migration } from '../migrator'
import { migration0001 } from './0001_foundation'
import { migration0002 } from './0002_assets'
import { migration0003 } from './0003_scoped_assets'
import { migration0004 } from './0004_observations'
import { migration0005 } from './0005_maintenance_requests'

/** Ordered list of all bundled agent-local migrations. Append only. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
