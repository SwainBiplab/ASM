import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, resetCallTransport, setCallTransport } from '../../web/src/api'

/**
 * W9.6: the adapter boundary `web/src/api.ts` gained so the desktop agent can host the real
 * `AssetsPage` -- `call()` must keep using the real browser HTTP transport by default (nothing in
 * `web/` ever touches `setCallTransport`), and must delegate correctly once something does. The
 * browser transport's actual HTTP behavior is already proven for real by `test:web-e2e` (52/52);
 * this covers only the swap mechanism itself, which that suite can't exercise in isolation.
 */

afterEach(() => resetCallTransport())

describe('web/src/api.ts call transport boundary (W9.6)', () => {
  it('uses the real browser transport (a fetch to /api/v1/rpc/...) by default, unless something installs another one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { status: 'ready' } }), { status: 200 }))
    const result = await call('system.getStartupState')
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/api/v1/rpc/system.getStartupState'), expect.objectContaining({ method: 'POST' }))
    expect(result).toEqual({ status: 'ready' })
    fetchSpy.mockRestore()
  })

  it('delegates every call to an installed transport instead of making any HTTP request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const transport = vi.fn(async () => ({ status: 'ready' }) as never)
    setCallTransport(transport as never)

    const result = await call('system.getStartupState')
    expect(transport).toHaveBeenCalledWith('system.getStartupState')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'ready' })
    fetchSpy.mockRestore()
  })

  it('restores the real browser transport after resetCallTransport', async () => {
    setCallTransport((async () => ({ status: 'ready' }) as never) as never)
    resetCallTransport()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { status: 'ready' } }), { status: 200 }))
    await call('system.getStartupState')
    expect(fetchSpy).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
