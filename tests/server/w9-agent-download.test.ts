import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudLogin, CloudClientError, fetchLeaseScopedAssets, listMyLeases } from '../../agent/main/cloudClient'
import { ADMIN } from './api-helpers'
import { createApiSession, type ApiSession } from './session-helpers'
import { w4Setup } from './w4-helpers'

/**
 * W9.5's work-package-scoped cloud-to-local download, proven against the REAL Fastify server
 * listening on a real ephemeral port with a real PostgreSQL-backed lease-ownership check -- not a
 * fixture or a mocked transport. This is the agent's own HTTP client code (`agent/main/cloudClient.ts`,
 * zero Electron dependency) speaking the exact same `/api/v1/rpc/:command` contract the browser
 * client uses: real `session.login`, real `leases.list`/`leases.getScopedAssets`.
 */

const sessions: ApiSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
})

async function listen(a: ApiSession): Promise<string> {
  await a.s.app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = a.s.app.server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

async function enrollApproveLease(a: ApiSession, adminCookie: string | null, assetIds: string[]) {
  const device = await a.ok('devices.requestEnrollment', { deviceUuid: randomUUID(), deviceName: `Device ${randomUUID().slice(0, 8)}` })
  const approver = adminCookie ? { cookie: adminCookie, headers: { 'idempotency-key': randomUUID() } } : undefined
  if (approver) await a.s.rpc('devices.approve', { deviceId: device.id, trustNotes: 'Verified' }, approver)
  else await a.ok('devices.approve', { deviceId: device.id, trustNotes: 'Verified' })
  return a.ok('leases.request', { deviceId: device.id, scope: { kind: 'asset', assetIds }, durationHours: 4 })
}

describe('agent cloud download: work-package-scoped inventory (W9.5)', () => {
  it('downloads only the assets in the caller\'s own leased work package, via the real server and real leases.getScopedAssets', async () => {
    const a = await createApiSession()
    sessions.push(a)
    const adminCookie = a.cookie
    const f = await w4Setup(a, 3)
    const lease = await enrollApproveLease(a, null, [f.assets[0]!.id, f.assets[1]!.id])
    const baseUrl = await listen(a)

    const cookie = await cloudLogin(baseUrl, ADMIN.username, ADMIN.password)
    const leases = await listMyLeases(baseUrl, cookie)
    expect(leases.map((l) => l.id)).toContain(lease.id)

    const items = await fetchLeaseScopedAssets(baseUrl, cookie, lease.id)
    expect(items.map((i) => i.assetCode).sort()).toEqual([f.assets[0]!.assetCode, f.assets[1]!.assetCode].sort())
    // Never the whole organization: the third, unleased asset must be absent.
    expect(items.map((i) => i.assetCode)).not.toContain(f.assets[2]!.assetCode)
    void adminCookie
  })

  it('refuses to return another user\'s leased inventory even when the caller supplies that exact leaseId', async () => {
    const a = await createApiSession()
    sessions.push(a)
    const adminCookie = a.cookie
    const f = await w4Setup(a, 1)

    await a.becomeNewUser('otheragent', ['asset_manager'])
    const otherLease = await enrollApproveLease(a, adminCookie, [f.assets[0]!.id])
    const baseUrl = await listen(a)

    // The admin account is a different user from the lease's actual owner.
    const adminSessionCookie = await cloudLogin(baseUrl, ADMIN.username, ADMIN.password)
    await expect(fetchLeaseScopedAssets(baseUrl, adminSessionCookie, otherLease.id)).rejects.toThrow(/different user/)
  })

  it('refuses a download with the wrong password, the same as the real server would for any client', async () => {
    const a = await createApiSession()
    sessions.push(a)
    const baseUrl = await listen(a)
    await expect(cloudLogin(baseUrl, ADMIN.username, 'definitely-wrong-password')).rejects.toThrow(CloudClientError)
  })
})
