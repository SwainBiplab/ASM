import { randomUUID } from 'node:crypto'
import type { CreateAssetInput } from '../../src/shared/assetSchemas'
import type { IssueInput } from '../../src/shared/allocationSchemas'
import type { CreateEmployeeInput } from '../../src/shared/orgSchemas'
import { ORIGIN } from './api-helpers'
import type { ApiSession } from './session-helpers'

export const asset = (categoryId: string, extra: Partial<CreateAssetInput> = {}): CreateAssetInput => ({
  categoryId, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: null, specifications: null, condition: 'good', operationalStatus: 'ready',
  locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null, ...extra
})

export const emp = (employeeCode: string, fullName: string): CreateEmployeeInput => ({
  employeeCode, fullName, email: null, phone: null, jobTitle: null, departmentId: null, teamId: null, managerEmployeeId: null,
  workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null
})

/** Organization structure, a category, `n` ready assets and two employees. */
export async function w4Setup(a: ApiSession, n = 3) {
  const category = await a.ok('categories.create', { code: 'LAP', name: 'Laptop', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  const site = await a.ok('locations.create', { locationType: 'site', name: 'Pune', code: 'PUN', parentLocationId: null, notes: null })
  const bldg = await a.ok('locations.create', { locationType: 'building', name: 'Tower A', code: null, parentLocationId: site.id, notes: null })
  const floor = await a.ok('locations.create', { locationType: 'floor', name: 'Floor 3', code: null, parentLocationId: bldg.id, notes: null })
  const store = await a.ok('locations.create', { locationType: 'storage', name: 'IT Store', code: 'STORE', parentLocationId: bldg.id, notes: null })
  const dept = await a.ok('departments.create', { code: 'OPS', name: 'Operations', managerEmployeeId: null, notes: null })
  const pool = await a.ok('pools.create', { code: null, name: 'Spare laptops', purpose: null, responsibleDepartmentId: dept.id, responsibleTeamId: null, defaultLocationId: null })
  const desk = await a.ok('workstations.create', { code: 'PUN-3A-001', kind: 'workstation', locationId: floor.id, label: null, notes: null })
  const ravi = await a.ok('employees.create', emp('E100', 'Ravi Kumar'))
  const asha = await a.ok('employees.create', emp('E200', 'Asha Menon'))
  const assets = []
  for (let i = 0; i < n; i++) assets.push(await a.ok('assets.create', asset(category.id, { serialNumber: `SN-${i}-${randomUUID().slice(0, 6)}` })))
  return { category, site, floor, store, dept, pool, desk, ravi, asha, assets }
}

export const issue = (assetIds: string[], target: IssueInput['target'], extra: Partial<IssueInput> = {}): IssueInput => ({
  target, lines: assetIds.map((assetId) => ({ assetId, condition: 'good', accessories: null })), locationId: null, expectedReturnDate: null, notes: null,
  acknowledgment: { acknowledgedByName: 'Recipient Name' }, ...extra
})

/** Raw RPC with an explicit Idempotency-Key, for retry tests. */
export async function rpcWithKey(a: ApiSession, command: string, body: unknown, key: string) {
  const res = await a.s.app.inject({
    method: 'POST',
    url: `/api/v1/rpc/${command}`,
    headers: { 'content-type': 'application/json', 'x-bpoam-request': '1', origin: ORIGIN, cookie: `${a.s.config.cookieName}=${a.cookie}`, 'idempotency-key': key },
    payload: JSON.stringify(body)
  })
  return { status: res.statusCode, body: res.json() as { ok: boolean; data?: { id: string }; error?: { code: string; message: string } } }
}

export const count = async (a: ApiSession, sql: string, params: unknown[] = []) => Number((await a.sql<{ n: string }>(sql, params))[0]!.n)
