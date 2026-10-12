import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssetListItem } from '@shared/api'
import { ApiError } from '../../web/src/api'
import { desktopCallTransport } from '../../agent/renderer-src/desktopApiAdapter'

/**
 * W9.6: the desktop agent's `CallTransport` -- the adapter `AssetsPage.tsx` actually calls through
 * once `main.tsx` installs it. No Electron runtime needed: `window.agent` is a plain stub here,
 * exactly the shape the real preload bridge exposes (`agent/ipcContract.ts`'s `AgentApi`).
 */

const sample = (id: string, assetCode: string, overrides: Partial<AssetListItem> = {}): AssetListItem => ({
  id, assetCode, categoryName: 'Laptop', assetDomain: 'it', manufacturer: 'Dell', modelName: 'Latitude', serialNumber: 'SN-1',
  lifecycleStatus: 'active', operationalStatus: 'ready', condition: 'good', locationPath: 'Pune / Floor 3', warrantyEnd: null, updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const originalWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

function stubLocalAssets(items: AssetListItem[]) {
  ;(globalThis as unknown as { window: { agent: { assets: { listLocal: () => Promise<unknown> } } } }).window = {
    agent: { assets: { listLocal: async () => ({ items, lastSyncedAt: '2026-10-12T09:00:00.000Z', scopeLeaseId: 'lease-1', snapshotId: 'snap-1' }) } }
  }
}

describe('desktop agent CallTransport (W9.6)', () => {
  beforeEach(() => stubLocalAssets([sample('a1', 'AST-000002'), sample('a2', 'AST-000001', { lifecycleStatus: 'retired' })]))

  it('serves assets.search from the local cache: filters by lifecycle, sorts by code, and paginates', async () => {
    const page = await desktopCallTransport('assets.search', { lifecycle: 'active', sort: 'code', direction: 'asc', page: 1, pageSize: 50 } as never)
    expect(page.items.map((i) => i.assetCode)).toEqual(['AST-000002'])
    expect(page.total).toBe(1)
  })

  it('serves assets.search unfiltered by lifecycle "all", sorted ascending by code', async () => {
    const page = await desktopCallTransport('assets.search', { lifecycle: 'all', sort: 'code', direction: 'asc', page: 1, pageSize: 50 } as never)
    expect(page.items.map((i) => i.assetCode)).toEqual(['AST-000001', 'AST-000002'])
  })

  it('paginates the local cache the same way the real server would', async () => {
    const page = await desktopCallTransport('assets.search', { lifecycle: 'all', sort: 'code', direction: 'asc', page: 2, pageSize: 1 } as never)
    expect(page).toMatchObject({ items: [{ assetCode: 'AST-000002' }], total: 2, page: 2, pageSize: 1 })
  })

  it('serves assets.get from the local cache as a best-effort AssetDetail, with cost/documents/history explicitly empty, never guessed', async () => {
    const detail = await desktopCallTransport('assets.get', { id: 'a1' } as never)
    expect(detail).toMatchObject({ id: 'a1', assetCode: 'AST-000002', costVisible: false, acquisitionCostMinor: null, documents: [], history: [] })
  })

  it('rejects assets.get for an asset outside the downloaded scope', async () => {
    await expect(desktopCallTransport('assets.get', { id: 'not-cached' } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses every other command as not available offline, never silently no-oping or faking a result', async () => {
    const anyTransport = desktopCallTransport as (command: string, ...args: unknown[]) => Promise<unknown>
    await expect(anyTransport('assets.create', {})).rejects.toBeInstanceOf(ApiError)
    await expect(anyTransport('categories.list', {})).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('not available while working offline') })
  })
})
