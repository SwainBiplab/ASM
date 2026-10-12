import { createInterface } from 'node:readline/promises'
import { writeFileSync } from 'node:fs'
import { loadConfig } from '../config'
import { newCorrelationId } from '../core'
import { createDb } from '../db/sql'
import { migrate } from '../db/migrator'
import { MIGRATIONS } from '../db/migrations'
import { applyLegacyMigration, openLegacyDatabase, planLegacyMigration, verifyLegacyMigration } from '../migration/legacyMigration'
import { bootstrapOrganization, organizationCount } from '../services/identity'
import { syncPermissionCatalog } from '../services/foundation'
import { LocalStorage, S3Storage, type DocumentStorage } from '../storage/storage'
import { loadEnvFile } from '../envFile'

/**
 * Operator CLI (never exposed over HTTP):
 *   migrate    — apply pending migrations (release step)
 *   bootstrap  — create the organization and first Super Admin (interactive; once)
 */
async function main(): Promise<void> {
  const command = process.argv[2]
  loadEnvFile()
  const config = loadConfig()
  const db = createDb(config.DATABASE_URL, { max: 2, applicationName: 'bpoam-admin' })
  try {
    if (command === 'migrate') {
      const r = await migrate(db, MIGRATIONS, process.env['npm_package_version'] ?? '0.1.0')
      await syncPermissionCatalog(db)
      console.log(`Schema version ${r.from} -> ${r.to}`)
      return
    }
    if (command === 'bootstrap') {
      await migrate(db, MIGRATIONS, process.env['npm_package_version'] ?? '0.1.0')
      if ((await organizationCount(db)) > 0) throw new Error('An organization already exists; bootstrap can only run once.')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      // Piped (non-interactive) input: read every answer up front; readline drops early lines otherwise.
      const piped: string[] | null = process.stdin.isTTY ? null : await (async () => {
        const lines: string[] = []
        for await (const line of rl) lines.push(line)
        return lines
      })()
      const ask = async (q: string, def?: string) =>
        ((piped ? (piped.shift() ?? '') : await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || '')
      const input = {
        organization: {
          legalName: await ask('Organization legal name'),
          displayName: await ask('Display name'),
          baseCurrency: (await ask('Base currency', 'INR')).toUpperCase(),
          timezone: await ask('Time zone', 'Asia/Kolkata')
        },
        admin: { username: await ask('Super Admin username'), displayName: await ask('Super Admin full name'), password: await ask('Super Admin password (min 10 chars)') }
      }
      rl.close()
      const r = await bootstrapOrganization(db, input, newCorrelationId())
      console.log(`Organization ${r.organizationId} created. Sign in as ${input.admin.username}.`)
      return
    }
    if (command === 'migrate-legacy') {
      await runLegacyMigrationCli(db, config, process.argv.slice(3))
      return
    }
    console.log('Usage: admin <migrate|bootstrap|migrate-legacy>')
    process.exitCode = 2
  } finally {
    await db.close()
  }
}

/**
 * `admin.ts migrate-legacy <sqlitePath> <organizationId> <actorUserId> [--docs <path>] [--apply] [--verify] [--report <path>]`
 * Defaults to a dry run (plan only, writes nothing). `--apply` performs the migration
 * transactionally (all-or-nothing on conflict); `--verify` independently re-checks the target
 * after an apply. The source SQLite file is always opened read-only and is never modified.
 */
async function runLegacyMigrationCli(db: ReturnType<typeof createDb>, config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const [sqlitePath, organizationId, actorUserId] = args
  if (!sqlitePath || !organizationId || !actorUserId) {
    console.log('Usage: admin migrate-legacy <sqlitePath> <organizationId> <actorUserId> [--docs <path>] [--apply] [--verify] [--report <path>]')
    process.exitCode = 2
    return
  }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const docsRoot = flag('docs')
  const reportPath = flag('report')
  const apply = args.includes('--apply')
  const verifyOnly = args.includes('--verify')

  const storage: DocumentStorage | undefined = docsRoot
    ? config.STORAGE_DRIVER === 's3'
      ? new S3Storage({
          bucket: config.STORAGE_S3_BUCKET!, region: config.STORAGE_S3_REGION!, endpoint: config.STORAGE_S3_ENDPOINT,
          accessKeyId: config.STORAGE_S3_ACCESS_KEY_ID!, secretAccessKey: config.STORAGE_S3_SECRET_ACCESS_KEY!, forcePathStyle: config.STORAGE_S3_FORCE_PATH_STYLE
        })
      : new LocalStorage(config.STORAGE_LOCAL_ROOT)
    : undefined
  const opts = { organizationId, actorUserId, legacyDocumentsRoot: docsRoot, storage }
  const legacy = openLegacyDatabase(sqlitePath)
  try {
    if (verifyOnly) {
      const report = await verifyLegacyMigration(legacy, db, opts)
      console.log(JSON.stringify(report, null, 2))
      if (!report.ok) process.exitCode = 1
      return
    }
    const report = apply ? await applyLegacyMigration(legacy, db, opts) : await planLegacyMigration(legacy, db, opts)
    const text = JSON.stringify(report, null, 2)
    // Reports can name real people (employee/user records); write to a file with the operator's
    // explicit chosen path rather than defaulting to stdout history when --report is given.
    if (reportPath) writeFileSync(reportPath, text, { mode: 0o600 })
    else console.log(text)
    console.log(`\n${report.mode}: ${report.aborted ? 'ABORTED (conflicts found; nothing was written)' : 'completed'}`)
    for (const [entity, c] of Object.entries(report.counts)) console.log(`  ${entity}: insert=${c.insert} skip=${c.skip} reject=${c.reject}`)
    if (report.aborted || report.items.some((i) => i.action === 'reject')) process.exitCode = 1
  } finally {
    legacy.close()
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message)
  process.exit(1)
})
