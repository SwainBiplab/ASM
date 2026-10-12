import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFile } from '../../server/src/envFile'

describe('.env loading', () => {
  it('fills only missing variables, so real environment values win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpoam-env-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, '# comment\nDATABASE_URL=postgres://file@127.0.0.1/db\nPUBLIC_ORIGIN=http://127.0.0.1:3000\nQUOTED="a b#c"\n')
      const env: NodeJS.ProcessEnv = { ENV_FILE: file, PUBLIC_ORIGIN: 'http://localhost:5173' }
      expect(loadEnvFile(env)).toBe(file)
      expect(env['DATABASE_URL']).toBe('postgres://file@127.0.0.1/db')
      expect(env['PUBLIC_ORIGIN']).toBe('http://localhost:5173')
      expect(env['QUOTED']).toBe('a b#c')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does nothing when the file is absent', () => {
    const env: NodeJS.ProcessEnv = { ENV_FILE: join(tmpdir(), 'no-such-bpoam.env') }
    expect(loadEnvFile(env)).toBeNull()
    expect(Object.keys(env)).toEqual(['ENV_FILE'])
  })
})
