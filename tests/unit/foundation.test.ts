import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/main/auth/password'
import { SessionManager } from '../../src/main/auth/session'
import { isTrustedOrigin, resolveBundlePath, PRODUCTION_CSP } from '../../src/main/app/origin'
import { redact } from '../../src/main/logging/logger'
import { resolveDataRoot } from '../../src/main/app/env'
import { COMMAND_NAMES } from '../../src/shared/api'
import { ALL_PERMISSION_KEYS, ROLE_TEMPLATES, resolveTemplatePermissions } from '../../src/shared/permissions'
import { backupIdSchema, setupInputSchema } from '../../src/shared/schemas'
import { join, resolve } from 'node:path'

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('Correct-Horse-1')
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(hash).not.toContain('Correct-Horse-1')
    expect(await verifyPassword('Correct-Horse-1', hash)).toBe(true)
    expect(await verifyPassword('correct-horse-1', hash)).toBe(false)
  })

  it('uses a unique salt per hash', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'))
  })

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false)
  })
})

describe('session idle locking', () => {
  it('locks after the idle timeout and unlocks explicitly', () => {
    let now = 0
    const s = new SessionManager(() => now)
    s.start('u1')
    now = 14 * 60_000
    expect(s.check(15).state).toBe('active')
    s.touch()
    now += 16 * 60_000
    expect(s.check(15).state).toBe('locked')
    s.touch() // activity does not unlock
    expect(s.check(15).state).toBe('locked')
    s.unlock()
    expect(s.check(15).state).toBe('active')
    s.end()
    expect(s.check(15).state).toBe('none')
  })
})

describe('permission catalog and role templates', () => {
  it('templates reference only known permissions', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of resolveTemplatePermissions(t)) expect(ALL_PERMISSION_KEYS).toContain(p)
    }
  })

  it('super admin template holds every permission', () => {
    const sa = ROLE_TEMPLATES.find((t) => t.key === 'super_admin')!
    expect(resolveTemplatePermissions(sa).sort()).toEqual([...ALL_PERMISSION_KEYS].sort())
  })

  it('auditor template is read-only', () => {
    const auditor = ROLE_TEMPLATES.find((t) => t.key === 'auditor')!
    const mutating = /\.(create|update|manage|issue|transfer|return|approve|close|dispose|retire|restore|configure|submit|resolve|record|import|export|override|assign)/
    expect(resolveTemplatePermissions(auditor).filter((p) => mutating.test(p))).toEqual([])
  })
})

describe('renderer origin and bundle path guards', () => {
  const root = resolve('/app/out/renderer')

  it('serves files inside the bundle', () => {
    expect(resolveBundlePath(root, '/')).toBe(join(root, 'index.html'))
    expect(resolveBundlePath(root, '/assets/index-abc.js')).toBe(join(root, 'assets', 'index-abc.js'))
  })

  it('refuses traversal outside the bundle', () => {
    expect(resolveBundlePath(root, '/../main/index.js')).toBeNull()
    expect(resolveBundlePath(root, '/%2e%2e/%2e%2e/secret')).toBeNull()
    expect(resolveBundlePath(root, '/%E0%A4%A')).toBeNull()
  })

  it('trusts only allow-listed origins', () => {
    const allowed = new Set(['app://bundle'])
    expect(isTrustedOrigin('app://bundle/index.html', allowed)).toBe(true)
    expect(isTrustedOrigin('https://evil.example/app://bundle', allowed)).toBe(false)
    expect(isTrustedOrigin('file:///C:/index.html', allowed)).toBe(false)
    expect(isTrustedOrigin(undefined, allowed)).toBe(false)
    expect(isTrustedOrigin('not a url', allowed)).toBe(false)
  })

  it('production CSP forbids inline and remote script', () => {
    expect(PRODUCTION_CSP).toContain("script-src 'self'")
    expect(PRODUCTION_CSP).not.toContain('unsafe-inline')
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval')
    expect(PRODUCTION_CSP).toContain("default-src 'none'")
  })
})

describe('logging redaction', () => {
  it('removes secrets from structured context', () => {
    const out = redact({ username: 'a', password: 'p', nested: { token: 't', passwordHash: 'h', ok: 1 } }) as Record<string, unknown>
    expect(out).toEqual({ username: 'a', password: '[redacted]', nested: { token: '[redacted]', passwordHash: '[redacted]', ok: 1 } })
  })
})

describe('data directory separation', () => {
  it('uses distinct folders per environment and honours an override', () => {
    const base = { appDataDir: 'C:/Users/x/AppData/Roaming', productName: 'BPO Asset Management' }
    const prod = resolveDataRoot({ ...base, environment: 'production' })
    const dev = resolveDataRoot({ ...base, environment: 'development' })
    expect(prod).not.toBe(dev)
    expect(dev).toContain('(development)')
    expect(resolveDataRoot({ ...base, environment: 'production', overrideDir: 'D:/tmp/x' })).toBe('D:/tmp/x')
  })
})

describe('shared schemas', () => {
  it('rejects unknown keys and invalid currency/timezone', () => {
    const valid = {
      organization: { legalName: 'A', displayName: 'A', baseCurrency: 'INR', timezone: 'Asia/Kolkata' },
      admin: { username: 'admin', displayName: 'A', password: 'long-enough-1' }
    }
    expect(setupInputSchema.safeParse(valid).success).toBe(true)
    expect(setupInputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(setupInputSchema.safeParse({ ...valid, organization: { ...valid.organization, baseCurrency: 'inr' } }).success).toBe(false)
    expect(setupInputSchema.safeParse({ ...valid, organization: { ...valid.organization, timezone: 'Mars/Base' } }).success).toBe(false)
  })

  it('backup ids cannot carry paths', () => {
    expect(backupIdSchema.safeParse('20261011T120000Z-manual-0a1b2c3d').success).toBe(true)
    expect(backupIdSchema.safeParse('../../etc').success).toBe(false)
    expect(backupIdSchema.safeParse('20261011T120000Z-manual-0a1b2c3d/../x').success).toBe(false)
  })

  it('command names are unique and namespaced', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length)
    for (const c of COMMAND_NAMES) expect(c).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
  })
})
