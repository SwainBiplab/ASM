import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

const run = promisify(execFile)

/** pg_ctl leaves the postmaster holding inherited pipes on Windows, so never capture its stdio. */
function pgCtl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_ctl', args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_ctl ${args.at(-1)} exited with ${code}`))))
  })
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/**
 * Real PostgreSQL for server integration tests (DECISIONS D31). Uses TEST_DATABASE_URL when
 * provided (CI/Docker); otherwise starts a throwaway cluster with initdb + pg_ctl.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env['TEST_DATABASE_URL']) {
    project.provide('pgAdminUrl', process.env['TEST_DATABASE_URL'])
    return async () => undefined
  }
  const dir = mkdtempSync(join(tmpdir(), 'bpoam-pg-'))
  const data = join(dir, 'data')
  const port = await freePort()
  await run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'])
  await pgCtl(['-D', data, '-l', join(dir, 'pg.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`, '-w', 'start'])
  project.provide('pgAdminUrl', `postgres://postgres@127.0.0.1:${port}/postgres`)
  return async () => {
    await pgCtl(['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string
  }
}
