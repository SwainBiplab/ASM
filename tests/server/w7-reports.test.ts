import { afterEach, describe, expect, it } from 'vitest'
import { createApiSession, type ApiSession } from './session-helpers'

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})
const session = async () => {
  const a = await createApiSession()
  sessions.push(a)
  return a
}

describe('asset acquisition and valuation report', () => {
  it('groups totals by currency, never sums across currencies, filters by date range, and hides cost without finance permission', async () => {
    const a = await session()
    const category = await a.ok('categories.create', { code: 'LAP', name: 'Laptop', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const inr1 = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: 'R7-INR-1', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: '2026-01-10', acquisitionCost: '50000.00', invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)
    const inr2 = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: 'R7-INR-2', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: '2026-06-01', acquisitionCost: '30000.00', invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)
    // A second currency must never be summed into the first currency's total.
    await a.sql('UPDATE assets SET currency = $1, acquisition_cost_minor = $2 WHERE id = $3', ['USD', 600 * 100, inr2.id])

    const all = await a.ok('reports.assetValuation', { lifecycle: 'all', page: 1, pageSize: 50 } as never)
    expect(all.costVisible).toBe(true)
    const inrTotal = all.totalsByCurrency.find((t) => t.currency === 'INR')
    const usdTotal = all.totalsByCurrency.find((t) => t.currency === 'USD')
    expect(inrTotal).toMatchObject({ totalMinor: 50000 * 100, count: 1 })
    expect(usdTotal).toMatchObject({ totalMinor: 600 * 100, count: 1 })
    // No combined/cross-currency total is ever exposed.
    expect(Object.keys(all)).not.toContain('grandTotalMinor')

    // Date-range filter on purchase date.
    const earlyOnly = await a.ok('reports.assetValuation', { lifecycle: 'all', fromDate: '2026-01-01', toDate: '2026-03-01', page: 1, pageSize: 50 } as never)
    expect(earlyOnly.items.map((i) => i.id)).toEqual([inr1.id])

    await a.becomeNewUser('noncost', ['it_technician'])
    const hidden = await a.ok('reports.assetValuation', { lifecycle: 'all', page: 1, pageSize: 50 } as never)
    expect(hidden.costVisible).toBe(false)
    expect(hidden.totalsByCurrency).toEqual([])
    expect(hidden.items.every((i) => i.acquisitionCostMinor === null)).toBe(true)
  })

  it('flags assets missing acquisition cost or purchase date, and refuses viewers without reports.view', async () => {
    const a = await session()
    const category = await a.ok('categories.create', { code: 'PHN', name: 'Phone', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const incomplete = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: null, modelName: null, serialNumber: null, specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)
    const report = await a.ok('reports.assetValuation', { lifecycle: 'all', onlyMissingFinancialMetadata: true, page: 1, pageSize: 50 } as never)
    expect(report.items.map((i) => i.id)).toContain(incomplete.id)
    expect(report.items.every((i) => i.missingFinancialMetadata)).toBe(true)

    await a.becomeNewUser('noreports', ['employee'])
    expect(await a.call('reports.assetValuation', { lifecycle: 'all', page: 1, pageSize: 50 } as never)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })
})

describe('maintenance cost report', () => {
  it('totals parts and labor cost by currency and ranks the highest-expenditure assets', async () => {
    const a = await session()
    const category = await a.ok('categories.create', { code: 'PRN', name: 'Printer', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const asset = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: 'HP', modelName: 'LaserJet', serialNumber: 'R7-PRN-1', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)
    const ticket = await a.ok('maintenance.create', {
      assetId: asset.id, category: 'hardware', priority: 'medium', description: 'Jam', targetResolutionDate: null, assignedTechnicianId: null, vendorName: 'FixIt Co', vendorReference: null, forceAdditional: false, justification: null
    } as never)
    await a.ok('maintenance.update', {
      ticketId: ticket.id, priority: 'medium', description: 'Jam', diagnosis: 'Worn roller', workPerformed: 'Replaced', vendorName: 'FixIt Co', vendorReference: null,
      partsCost: '1500.00', laborCost: '500.00', downtimeMinutes: 120, targetResolutionDate: null, notes: null
    } as never)
    await a.ok('maintenance.resolve', { ticketId: ticket.id, diagnosis: 'Worn roller', workPerformed: 'Replaced', downtimeMinutes: 120, notes: null } as never)

    const report = await a.ok('reports.maintenanceCost', { page: 1, pageSize: 50 } as never)
    expect(report.costVisible).toBe(true)
    expect(report.totalsByCurrency[0]).toMatchObject({ totalMinor: 2000 * 100, count: 1 })
    expect(report.topAssets[0]).toMatchObject({ assetId: asset.id, ticketCount: 1, totalCostMinor: 2000 * 100 })
  })
})

async function approvedRequest(a: ApiSession, categoryId: string, unitCost = '45000.00') {
  await a.ok('approvals.savePolicy', {
    policyGroupId: null, transactionType: 'purchase_request', name: 'Simple approval', minAmount: null, currency: null,
    preventSelfApproval: false, isActive: true, steps: [{ requiredRoleKey: 'super_admin', requiredUserId: null }]
  } as never)
  const draft = await a.ok('procurement.saveDraft', {
    requestId: null, departmentId: null, teamId: null, justification: 'Replacement equipment', requiredByDate: null, currency: 'INR',
    items: [{ description: 'Item', categoryId, modelId: null, quantity: 3, estimatedUnitCost: unitCost }]
  } as never)
  const submitted = await a.ok('procurement.submit', { requestId: draft.id })
  return a.ok('approvals.decide', { instanceId: submitted.approval!.id, decision: 'approved', reason: null })
}

describe('procurement summary report', () => {
  it('totals requests and orders by status/currency, tracks received vs. outstanding value, and excludes rejected goods from received value', async () => {
    const a = await session()
    const category = await a.ok('categories.create', { code: 'MON', name: 'Monitor', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })
    const supplier = await a.ok('suppliers.create', { code: null, name: 'Acme', contactName: null, email: null, phone: null, address: null, taxReference: null, notes: null })
    const location = await a.ok('locations.create', { locationType: 'site', name: 'HQ', code: null, parentLocationId: null, notes: null })
    const request = await approvedRequest(a, category.id, '1000.00')
    const reqItemId = request.items[0]!.id
    const po = await a.ok('orders.create', {
      requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
      items: [{ requestItemId: reqItemId, description: 'Monitor', categoryId: category.id, modelId: null, quantity: 3, unitPrice: '1000.00' }]
    } as never)
    const poItemId = po.items[0]!.id

    const summaryBefore = await a.ok('reports.procurementSummary', { page: 1, pageSize: 50 } as never)
    expect(summaryBefore.costVisible).toBe(true)
    expect(summaryBefore.requestTotals.find((t) => t.status === 'approved')).toMatchObject({ totalMinor: 3000 * 100, count: 1 })
    expect(summaryBefore.orderTotals.find((t) => t.status === 'open')).toMatchObject({ totalMinor: 3000 * 100, count: 1 })

    // Receive 1 accepted, 1 damaged, 1 rejected: rejected must not count as received value nor reduce outstanding below what's truly owed.
    await a.ok('receipts.create', {
      poId: po.id, supplierReference: null, notes: null,
      items: [{
        poItemId,
        units: [{ serialNumber: 'R7-MON-1', disposition: 'accepted' }, { serialNumber: 'R7-MON-2', disposition: 'damaged' }, { serialNumber: null, disposition: 'rejected' }],
        locationId: location.id, discrepancyNotes: 'One damaged, one short-shipped'
      }]
    } as never)

    const summaryAfter = await a.ok('reports.procurementSummary', { page: 1, pageSize: 50 } as never)
    // Accepted (1000) + damaged (1000) reduce outstanding; rejected (1000) stays outstanding.
    const inr = summaryAfter.receivedTotals.find((t) => t.currency === 'INR')!
    expect(inr.receivedMinor).toBe(1000 * 100)
    expect(inr.outstandingMinor).toBe(1000 * 100)
    expect(summaryAfter.openDiscrepancies.length).toBeGreaterThanOrEqual(1)
    expect(summaryAfter.openDiscrepancies[0]).toMatchObject({ damagedQuantity: 1, rejectedQuantity: 1, poNumber: po.poNumber })
  })
})

describe('warranty and disposal reports', () => {
  it('lists warranties expiring within a configurable window, expired, and missing, and reports disposals with proceeds', async () => {
    const a = await session()
    const category = await a.ok('categories.create', { code: 'TAB', name: 'Tablet', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const today = new Date().toISOString().slice(0, 10)
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
    const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
    const expiring = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: null, modelName: null, serialNumber: 'R7-TAB-1', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: today, warrantyEnd: soon, notes: null
    } as never)
    const expired = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: null, modelName: null, serialNumber: 'R7-TAB-2', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: past, warrantyEnd: past, notes: null
    } as never)
    const toDispose = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: null, modelName: null, serialNumber: 'R7-TAB-3', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)

    const expiringReport = await a.ok('reports.warranty', { filter: 'expiring', windowDays: 30, page: 1, pageSize: 50 } as never)
    expect(expiringReport.items.map((i) => i.id)).toContain(expiring.id)
    expect(expiringReport.items.map((i) => i.id)).not.toContain(expired.id)

    const expiredReport = await a.ok('reports.warranty', { filter: 'expired', page: 1, pageSize: 50 } as never)
    expect(expiredReport.items.map((i) => i.id)).toContain(expired.id)

    await a.ok('assets.changeLifecycle', { id: toDispose.id, toStatus: 'retired', reason: 'End of life', effectiveDate: today, disposalMethod: null, disposalProceeds: null } as never)
    await a.ok('assets.changeLifecycle', { id: toDispose.id, toStatus: 'disposed', reason: 'Disposed after retirement', effectiveDate: today, disposalMethod: 'sold', disposalProceeds: '200.00' } as never)
    const disposals = await a.ok('reports.disposals', { page: 1, pageSize: 50 } as never)
    const row = disposals.items.find((i) => i.id === toDispose.id)
    expect(row).toMatchObject({ disposalMethod: 'sold', disposalProceedsMinor: 200 * 100 })
    expect(disposals.totalsByCurrency.some((t) => t.totalMinor >= 200 * 100)).toBe(true)
  })
})

describe('report exports', () => {
  it('produces formula-injection-safe CSV and enforces organization ownership', async () => {
    const a = await session()
    const category = await a.ok('categories.create', { code: 'INJ', name: '=cmd|/c calc', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: null, modelName: null, serialNumber: 'R7-INJ-1', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: '2026-01-01', acquisitionCost: '100.00', invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)
    const res = await a.get('/api/v1/exports/reports/asset-valuation.csv?lifecycle=all')
    expect(res.status).toBe(200)
    const text = res.raw.toString('utf8')
    expect(text).toContain("'=cmd")

    const other = await session()
    const otherRes = await other.get('/api/v1/exports/reports/asset-valuation.csv?lifecycle=all')
    const otherText = otherRes.raw.toString('utf8')
    expect(otherText).not.toContain('cmd|/c calc')
  })
})
