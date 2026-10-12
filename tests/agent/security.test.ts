import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_APP_ORIGIN, buildWebPreferences, isTrustedOrigin, resolveBundlePath } from '../../agent/main/origin'

describe('agent shell security configuration', () => {
  it('builds webPreferences with context isolation on, Node integration off, sandbox on, and devTools gated on packaging', () => {
    const packaged = buildWebPreferences('/preload/index.js', false)
    expect(packaged).toMatchObject({
      preload: '/preload/index.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false
    })
    const dev = buildWebPreferences('/preload/index.js', true)
    expect(dev.devTools).toBe(true)
    // The security-critical flags never depend on the devTools toggle.
    expect(dev).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  })

  it('only trusts frame URLs matching the agent\'s own origin', () => {
    const allowed = new Set([AGENT_APP_ORIGIN])
    expect(isTrustedOrigin(`${AGENT_APP_ORIGIN}/index.html`, allowed)).toBe(true)
    expect(isTrustedOrigin('https://evil.example/index.html', allowed)).toBe(false)
    expect(isTrustedOrigin(undefined, allowed)).toBe(false)
  })

  it('refuses to resolve a renderer path outside its own directory (path traversal)', () => {
    const root = '/app/renderer'
    expect(resolveBundlePath(root, '/')).toBe(resolve(root, 'index.html'))
    expect(resolveBundlePath(root, '/../../etc/passwd')).toBeNull()
  })
})
