import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { count, rpcWithKey } from './w4-helpers'
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

/** Category, location, and supplier shared by every W6 test (admin session, created up front). */
async function w6Setup(a: ApiSession) {
  const category = await a.ok('categories.create', { code: 'LAP', name: 'Laptop', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })
  const bulkCategory = await a.ok('categories.create', { code: 'CBL', name: 'Cables', description: null, assetDomain: 'it', trackingMode: 'bulk', serialRequired: false, serialUnique: false })
  const site = await a.ok('locations.create', { locationType: 'site', name: 'Pune', code: 'PUN', parentLocationId: null, notes: null })
  const store = await a.ok('locations.create', { locationType: 'storage', name: 'IT Store', code: 'STORE', parentLocationId: site.id, notes: null })
  const supplier = await a.ok('suppliers.create', { code: 'SUP1', name: 'Acme Supplies', contactName: null, email: null, phone: null, address: null, taxReference: null, notes: null })
  return { category, bulkCategory, site, store, supplier }
}

const draftInput = (categoryId: string, extra: Partial<Record<string, unknown>> = {}) => ({
  requestId: null, departmentId: null, teamId: null, justification: 'New laptops for the onboarding batch', requiredByDate: null,
  currency: 'INR', items: [{ description: 'Laptop', categoryId, modelId: null, quantity: 3, estimatedUnitCost: '45000.00' }], ...extra
})

describe('purchase requests and configurable approvals', () => {
  it('fails safely when no approval policy is configured, then routes through a configured role-based step with self-approval blocked', async () => {
    const a = await session()
    const { category } = await w6Setup(a)

    const draft = await a.ok('procurement.saveDraft', draftInput(category.id) as never)
    expect(draft.status).toBe('draft')
    expect(draft.totalMinor).toBe(3 * 4500000)
    expect(await a.call('procurement.submit', { requestId: draft.id })).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('approval policy') } })

    const policy = await a.ok('approvals.savePolicy', {
      policyGroupId: null, transactionType: 'purchase_request', name: 'Standard PR approval', minAmount: null, currency: null,
      preventSelfApproval: true, isActive: true, steps: [{ requiredRoleKey: 'department_manager', requiredUserId: null }]
    } as never)
    expect(policy.version).toBe(1)

    await a.becomeNewUser('mgr1', ['department_manager'])
    const draft2 = await a.ok('procurement.saveDraft', draftInput(category.id) as never)
    const submitted = await a.ok('procurement.submit', { requestId: draft2.id })
    expect(submitted.status).toBe('submitted')
    expect(submitted.approval).toMatchObject({ status: 'pending', currentStep: 1, totalSteps: 1, policyVersion: 1 })
    const instanceId = submitted.approval!.id

    // mgr1 both requested and holds the required role: self-approval is blocked.
    expect(await a.call('approvals.decide', { instanceId, decision: 'approved', reason: null })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    // Editing the policy now (new version, different step) must not change mgr2's in-flight decision below.
    await a.becomeAdmin()
    await a.ok('approvals.savePolicy', {
      policyGroupId: policy.policyGroupId, transactionType: 'purchase_request', name: 'Standard PR approval', minAmount: null, currency: null,
      preventSelfApproval: true, isActive: true, steps: [{ requiredRoleKey: 'finance_officer', requiredUserId: null }]
    } as never)

    await a.becomeNewUser('mgr2', ['department_manager'])
    const approved = await a.ok('approvals.decide', { instanceId, decision: 'approved', reason: 'Looks good' })
    expect(approved.status).toBe('approved')
    expect(approved.approval).toMatchObject({ status: 'approved', policyVersion: 1 })
  })
})

describe('purchase orders', () => {
  async function approvedRequest(a: ApiSession, categoryId: string) {
    await a.becomeAdmin()
    await a.ok('approvals.savePolicy', {
      policyGroupId: null, transactionType: 'purchase_request', name: 'Simple approval', minAmount: null, currency: null,
      preventSelfApproval: false, isActive: true, steps: [{ requiredRoleKey: 'super_admin', requiredUserId: null }]
    } as never)
    const draft = await a.ok('procurement.saveDraft', draftInput(categoryId) as never)
    const submitted = await a.ok('procurement.submit', { requestId: draft.id })
    const approved = await a.ok('approvals.decide', { instanceId: submitted.approval!.id, decision: 'approved', reason: null })
    return approved
  }

  it('blocks ordering beyond the authorized quantity without a documented amendment', async () => {
    const a = await session()
    const { category, supplier } = await w6Setup(a)
    const request = await approvedRequest(a, category.id)
    const reqItemId = request.items[0]!.id

    expect(
      await a.call('orders.create', {
        requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
        items: [{ requestItemId: reqItemId, description: 'Laptop', categoryId: category.id, modelId: null, quantity: 5, unitPrice: '45000.00' }]
      } as never)
    ).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('exceed') } })

    const po = await a.ok('orders.create', {
      requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
      items: [{ requestItemId: reqItemId, description: 'Laptop', categoryId: category.id, modelId: null, quantity: 3, unitPrice: '44500.00' }]
    } as never)
    expect(po.status).toBe('open')
    expect(po.items[0]!.outstandingQuantity).toBe(3)
    return { po, request }
  })

  it('registers individually tracked assets on acceptance, keeps rejected/damaged units out of ready stock, and is idempotent on retry', async () => {
    const a = await session()
    const { category, supplier, store } = await w6Setup(a)
    const request = await approvedRequest(a, category.id)
    const reqItemId = request.items[0]!.id
    const po = await a.ok('orders.create', {
      requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
      items: [{ requestItemId: reqItemId, description: 'Laptop', categoryId: category.id, modelId: null, quantity: 3, unitPrice: '44500.00' }]
    } as never)
    const poItemId = po.items[0]!.id

    const receiptInput = {
      poId: po.id, supplierReference: 'INV-001', notes: null,
      items: [{
        poItemId,
        units: [
          { serialNumber: 'SN-A1', disposition: 'accepted' },
          { serialNumber: 'SN-A2', disposition: 'damaged' },
          { serialNumber: null, disposition: 'rejected' }
        ],
        locationId: store.id, discrepancyNotes: 'One damaged in transit, one short-shipped unit substituted with wrong model'
      }]
    }
    const key = randomUUID()
    const r1 = await rpcWithKey(a, 'receipts.create', receiptInput, key)
    expect(r1.status).toBe(200)
    const receipt = r1.body.data as { id: string; items: Array<{ discrepancyStatus: string; units: Array<{ disposition: string; assetId: string | null }> }> }
    expect(receipt.items[0]!.discrepancyStatus).toBe('open')
    const units = receipt.items[0]!.units
    expect(units.find((u) => u.disposition === 'accepted')!.assetId).not.toBeNull()
    expect(units.find((u) => u.disposition === 'damaged')!.assetId).not.toBeNull()
    expect(units.find((u) => u.disposition === 'rejected')!.assetId).toBeNull()
    const [acceptedAsset] = await a.sql<{ s: string; c: string }>('SELECT operational_status AS s, condition AS c FROM assets WHERE serial_number = $1', ['SN-A1'])
    expect(acceptedAsset).toMatchObject({ s: 'ready', c: 'new' })
    const [damagedAsset] = await a.sql<{ s: string; c: string }>('SELECT operational_status AS s, condition AS c FROM assets WHERE serial_number = $1', ['SN-A2'])
    expect(damagedAsset).toMatchObject({ s: 'non_operational', c: 'damaged' })

    // Retrying with the same Idempotency-Key must not create duplicate assets or receipt rows.
    const r2 = await rpcWithKey(a, 'receipts.create', receiptInput, key)
    expect(r2.status).toBe(200)
    expect(r2.body.data).toEqual(r1.body.data)
    expect(await count(a, 'SELECT count(*) AS n FROM goods_receipts WHERE po_id = $1', [po.id])).toBe(1)
    expect(await count(a, 'SELECT count(*) AS n FROM assets WHERE serial_number = $1', ['SN-A1'])).toBe(1)

    const orderAfter = await a.ok('orders.get', { poId: po.id })
    expect(orderAfter.status).toBe('partially_received')
    expect(orderAfter.items[0]!.outstandingQuantity).toBe(1)
  })

  it('tracks bulk stock as a movement and balance, and prevents two concurrent receipts from over-receiving the same line', async () => {
    const a = await session()
    const { bulkCategory, supplier, store } = await w6Setup(a)
    const request = await approvedRequest(a, bulkCategory.id)
    const reqItemId = request.items[0]!.id
    const po = await a.ok('orders.create', {
      requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
      items: [{ requestItemId: reqItemId, description: 'Cables', categoryId: bulkCategory.id, modelId: null, quantity: 3, unitPrice: '100.00' }]
    } as never)
    const poItemId = po.items[0]!.id

    const results = await Promise.all(
      [2, 2].map((qty) =>
        rpcWithKey(a, 'receipts.create', { poId: po.id, supplierReference: null, notes: null, items: [{ poItemId, bulkAcceptedQuantity: qty, bulkDamagedQuantity: 0, bulkRejectedQuantity: 0, locationId: store.id, discrepancyNotes: null }] }, randomUUID())
      )
    )
    const okCount = results.filter((r) => r.status === 200).length
    expect(okCount).toBe(1)
    for (const r of results.filter((x) => x.status !== 200)) expect(r.body.error?.code).toBe('STATE_CONFLICT')

    const [balance] = await a.sql<{ q: number }>('SELECT quantity_on_hand AS q FROM bulk_stock_balances WHERE category_id = $1 AND location_id = $2', [bulkCategory.id, store.id])
    expect(balance!.q).toBe(2)
    expect(await count(a, 'SELECT count(*) AS n FROM stock_movements WHERE category_id = $1', [bulkCategory.id])).toBe(1)
  })

  it('does not let one organization version or deactivate another organization\'s approval policy by guessing its policyGroupId', async () => {
    const victim = await session()
    const policy = await victim.ok('approvals.savePolicy', {
      policyGroupId: null, transactionType: 'purchase_request', name: 'Victim policy', minAmount: null, currency: null,
      preventSelfApproval: true, isActive: true, steps: [{ requiredRoleKey: 'department_manager', requiredUserId: null }]
    } as never)

    const attacker = await session()
    const resp = await attacker.call('approvals.savePolicy', {
      policyGroupId: policy.policyGroupId, transactionType: 'purchase_request', name: 'Hijacked', minAmount: null, currency: null,
      preventSelfApproval: false, isActive: true, steps: [{ requiredRoleKey: 'super_admin', requiredUserId: null }]
    } as never)
    expect(resp).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })

    // The victim's policy is completely unaffected: still version 1, still current, still its own steps.
    const [row] = await victim.sql<{ version: number; is_current: boolean; role: string }>(
      'SELECT p.version, p.is_current, s.required_role_key AS role FROM approval_policies p JOIN approval_policy_steps s ON s.policy_id = p.id WHERE p.policy_group_id = $1',
      [policy.policyGroupId]
    )
    expect(row).toMatchObject({ version: 1, is_current: true, role: 'department_manager' })
  })
})

describe('authorized-amount ceiling, not just quantity', () => {
  it('rejects a purchase order priced above the approved estimate, and rejects an amendment above it too', async () => {
    const a = await session()
    const { category, supplier } = await w6Setup(a)
    await a.ok('approvals.savePolicy', {
      policyGroupId: null, transactionType: 'purchase_request', name: 'Simple approval', minAmount: null, currency: null,
      preventSelfApproval: false, isActive: true, steps: [{ requiredRoleKey: 'super_admin', requiredUserId: null }]
    } as never)
    const draft = await a.ok('procurement.saveDraft', draftInput(category.id) as never)
    const submitted = await a.ok('procurement.submit', { requestId: draft.id })
    const request = await a.ok('approvals.decide', { instanceId: submitted.approval!.id, decision: 'approved', reason: null })
    const reqItemId = request.items[0]!.id

    // Approved at 45000.00/unit for 3 units; ordering at 60000.00/unit exceeds the approved amount even within the approved quantity.
    expect(
      await a.call('orders.create', {
        requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
        items: [{ requestItemId: reqItemId, description: 'Laptop', categoryId: category.id, modelId: null, quantity: 3, unitPrice: '60000.00' }]
      } as never)
    ).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('approved amount') } })

    // Ordering a different currency than the approved request is also refused.
    expect(
      await a.call('orders.create', {
        requestId: request.id, supplierId: supplier.id, currency: 'USD', orderDate: null, expectedDeliveryDate: null, notes: null,
        items: [{ requestItemId: reqItemId, description: 'Laptop', categoryId: category.id, modelId: null, quantity: 3, unitPrice: '500.00' }]
      } as never)
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })

    const po = await a.ok('orders.create', {
      requestId: request.id, supplierId: supplier.id, currency: 'INR', orderDate: null, expectedDeliveryDate: null, notes: null,
      items: [{ requestItemId: reqItemId, description: 'Laptop', categoryId: category.id, modelId: null, quantity: 3, unitPrice: '44000.00' }]
    } as never)
    // Amending the same line to a price that would exceed the approved amount is also refused.
    expect(
      await a.call('orders.amend', {
        poId: po.id, expectedDeliveryDate: null, notes: null, reason: 'Supplier repriced',
        items: [{ poItemId: po.items[0]!.id, quantity: 3, unitPrice: '60000.00' }]
      } as never)
    ).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', message: expect.stringContaining('approved amount') } })
  })
})
