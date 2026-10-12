import type { AssetDetail, AssetListItem, CommandMap, CommandName, Page } from '@shared/api'
import { qrPayloadFor } from '@shared/assets'
import { ApiError, type CallTransport } from '../../web/src/api'

/**
 * W9.6: the desktop agent's `CallTransport` -- the only two commands `AssetsPage.tsx` needs for
 * read-only browsing (`assets.search`, `assets.get`) are served from the local cache
 * (`window.agent.assets.listLocal()`, W9.4/W9.5). Everything else `AssetsPage.tsx` can call
 * (`assets.create`, `assets.update`, `assets.changeLifecycle`, `documents.removeLink`,
 * `categories.list`/`models.list`/`suppliers.list`/`locations.list` for its lookups and dialogs) is
 * refused with a clear "not available offline" error -- never silently ignored, never faked. The
 * mutation commands are additionally unreachable through the UI itself, since the offline session
 * passed to `AssetsPage` holds only `assets.view` (see `main.tsx`): the existing permission-gated
 * hiding in the component (`has('assets.update')` etc.) is what actually keeps edit/create/retire
 * controls off screen, not this adapter.
 */

/** Best-effort `AssetDetail` from the cached list row -- cost, specifications, documents and history
 *  genuinely don't exist in the local cache (W9.4 deliberately caches list fields only), so they are
 *  explicit nulls/empties, not guessed values, and `notes` says so instead of showing stale text. */
function toOfflineDetail(item: AssetListItem): AssetDetail {
  return {
    ...item,
    qrPayload: qrPayloadFor(item.id),
    categoryId: '',
    serialRequired: false,
    modelId: null,
    locationId: null,
    supplierId: null,
    supplierName: null,
    purchaseDate: null,
    costVisible: false,
    acquisitionCostMinor: null,
    disposalProceedsMinor: null,
    currency: '—',
    invoiceReference: null,
    purchaseReference: null,
    warrantyStart: null,
    warrantyState: 'none',
    disposalDate: null,
    disposalMethod: null,
    specifications: null,
    notes: 'Showing the downloaded offline snapshot. Specifications, cost, documents and history are only available online.',
    createdAt: item.updatedAt,
    documents: [],
    history: []
  }
}

function sortKey(sort: CommandMap['assets.search']['input']['sort']): keyof AssetListItem {
  if (sort === 'category') return 'categoryName'
  if (sort === 'warranty') return 'warrantyEnd'
  if (sort === 'created') return 'updatedAt'
  return 'assetCode'
}

/** Client-side filter/sort/paginate over the local snapshot -- `categoryId`/`locationId`/`supplierId`
 *  filters are accepted but cannot be honored offline (the cache stores names/paths, not ids) and are
 *  ignored; their filter dropdowns have nothing to populate them offline anyway (`categories.list`
 *  etc. are refused below), so the UI never actually offers a value for them while offline. */
async function searchLocal(input: CommandMap['assets.search']['input']): Promise<Page<AssetListItem>> {
  const { items } = await window.agent.assets.listLocal()
  let filtered = items
  if (input.query) {
    const q = input.query.toLowerCase()
    filtered = filtered.filter((a) => [a.assetCode, a.categoryName, a.manufacturer, a.modelName, a.serialNumber].some((v) => v?.toLowerCase().includes(q)))
  }
  if (input.lifecycle && input.lifecycle !== 'all') filtered = filtered.filter((a) => a.lifecycleStatus === input.lifecycle)
  if (input.operational) filtered = filtered.filter((a) => a.operationalStatus === input.operational)
  if (input.condition) filtered = filtered.filter((a) => a.condition === input.condition)
  const key = sortKey(input.sort)
  const dir = input.direction === 'desc' ? -1 : 1
  filtered = [...filtered].sort((a, b) => (String(a[key] ?? '') < String(b[key] ?? '') ? -1 : 1) * dir)
  const page = input.page ?? 1
  const pageSize = input.pageSize ?? 50
  const start = (page - 1) * pageSize
  return { items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize }
}

async function getLocal(assetId: string): Promise<AssetDetail> {
  const { items } = await window.agent.assets.listLocal()
  const item = items.find((a) => a.id === assetId)
  if (!item) throw new ApiError({ code: 'NOT_FOUND', message: 'This asset is not part of the currently downloaded work package.', correlationId: '-' })
  return toOfflineDetail(item)
}

function offlineUnavailable(command: CommandName): never {
  throw new ApiError({ code: 'NETWORK_ERROR', message: `"${command}" needs a live connection to the server and is not available while working offline.`, correlationId: '-' })
}

export const desktopCallTransport: CallTransport = (async (command: CommandName, ...args: unknown[]) => {
  if (command === 'assets.search') return searchLocal(args[0] as CommandMap['assets.search']['input'])
  if (command === 'assets.get') return getLocal((args[0] as { id: string }).id)
  return offlineUnavailable(command)
}) as CallTransport
