import { buildApp } from './app'
import { loadConfig } from './config'
import { createDb } from './db/sql'
import { migrate } from './db/migrator'
import { MIGRATIONS } from './db/migrations'
import { syncPermissionCatalog } from './services/foundation'
import { loadEnvFile } from './envFile'

/**
 * Server entry point. In production run `npm run server:migrate` as a release step; set
 * MIGRATE_ON_START=true only for single-instance or development deployments.
 */
async function main(): Promise<void> {
  loadEnvFile()
  const config = loadConfig()
  const db = createDb(config.DATABASE_URL)
  if (config.APP_ENV !== 'production' || process.env['MIGRATE_ON_START'] === 'true') {
    await migrate(db, MIGRATIONS, process.env['npm_package_version'] ?? '0.1.0')
  }
  await syncPermissionCatalog(db)
  const app = await buildApp({ config, db })
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down')
    await app.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  await app.listen({ host: config.HOST, port: config.PORT })
}

main().catch((err: unknown) => {
  console.error('Server failed to start:', (err as Error).message)
  process.exit(1)
})
