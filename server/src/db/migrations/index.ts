import type { Migration } from '../migrator'
import { migration0001 } from './0001_foundation'
import { migration0002 } from './0002_platform'
import { migration0003 } from './0003_organization'
import { migration0004 } from './0004_assets'
import { migration0005 } from './0005_allocations'
import { migration0006 } from './0006_maintenance_audits'
import { migration0007 } from './0007_procurement'
import { migration0008 } from './0008_ops'
import { migration0009 } from './0009_asset_import'

/** Ordered PostgreSQL migrations. Append only. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007, migration0008, migration0009]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
