import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { E2E_BASE_URL, E2E_PORT, STATE_FILE } from './env'

/**
 * Browser E2E environment: a throwaway PostgreSQL cluster (or TEST_DATABASE_URL), test-only
 * fixtures, and the real API server process serving the built web app (web/dist) on one origin.
 * Everything is removed in teardown. No demo data reaches any non-test database.
 */
const ROOT = resolve(__dirname, '../..')
const TSX_ENV = { TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.server.json') }

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((ok, fail) => {
    // pg_ctl leaves the postmaster holding inherited pipes on Windows, so never capture stdio.
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.slice(0, 2).join(' ')} exited with ${code}`))))
  })
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      srv.close(() => ok(typeof a === 'object' && a ? a.port : 0))
    })
    srv.on('error', fail)
  })
}

async function waitReady(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`API server exited with ${server.exitCode}; see test-results/web-e2e/server.log`)
    try {
      const res = await fetch(`${url}/api/health/ready`)
      if (res.ok) return
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('API server did not become ready in 60 s')
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(ROOT, 'web/dist/index.html'))) throw new Error('web/dist is missing: run `npm run web:build` (npm run test:web-e2e does this)')
  const work = mkdtempSync(join(tmpdir(), 'bpoam-e2e-'))
  const cleanups: Array<() => Promise<void>> = []
  const teardown = async () => {
    for (const c of cleanups.reverse()) await c().catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  try {
    let adminUrl = process.env['TEST_DATABASE_URL']
    if (!adminUrl) {
      const data = join(work, 'pgdata')
      const port = await freePort()
      await run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'])
      await run('pg_ctl', ['-D', data, '-l', join(work, 'pg.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', 'start'])
      cleanups.push(() => run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']))
      adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`
    }
    const dbName = `bpoam_e2e_${randomBytes(6).toString('hex')}`
    const admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${dbName}`)
    await admin.end()
    const databaseUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`)
    cleanups.push(async () => {
      const a = new pg.Client({ connectionString: adminUrl })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      await a.end()
    })

    await run(process.execPath, ['--import', 'tsx', 'tests/web-e2e/fixtures.ts'], { ...TSX_ENV, DATABASE_URL: databaseUrl })

    const storageRoot = join(work, 'documents')
    mkdirSync(join(ROOT, 'test-results/web-e2e'), { recursive: true })
    const log = createWriteStream(join(ROOT, 'test-results/web-e2e/server.log'))
    const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...TSX_ENV,
        APP_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(E2E_PORT),
        DATABASE_URL: databaseUrl,
        PUBLIC_ORIGIN: E2E_BASE_URL,
        WEB_ROOT: join(ROOT, 'web/dist'),
        STORAGE_LOCAL_ROOT: storageRoot,
        LOG_LEVEL: 'warn',
        // The suite signs in and calls the API many times from one IP; per-account lockout still applies.
        LOGIN_RATE_LIMIT_PER_MINUTE: '200',
        RATE_LIMIT_PER_MINUTE: '2000'
      }
    })
    server.stdout?.pipe(log)
    server.stderr?.pipe(log)
    cleanups.push(
      () =>
        new Promise<void>((ok) => {
          if (server.exitCode !== null) return ok()
          server.once('exit', () => ok())
          server.kill()
          setTimeout(ok, 5000)
        })
    )
    await waitReady(E2E_BASE_URL, server)
    writeFileSync(STATE_FILE, JSON.stringify({ databaseUrl, storageRoot }))
    cleanups.push(async () => rmSync(STATE_FILE, { force: true }))
    return teardown
  } catch (err) {
    await teardown()
    throw err
  }
}
