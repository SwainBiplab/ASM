import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { S3Storage } from '../../server/src/storage/storage'
import { startFakeS3, type FakeS3 } from './fake-s3'

/**
 * Exercises S3Storage's actual HTTP request/response handling against a local S3-API-compatible
 * test double (see fake-s3.ts). This verifies the driver's own code -- key validation, byte-exact
 * round trip, 404 mapping, delete semantics -- against real HTTP, not a mock of the AWS SDK.
 * It does NOT verify behavior against a live cloud provider; that remains unverified until a
 * provider is chosen and credentials are available (see DECISIONS.md D47 / PROJECT_STATUS.md).
 */
describe('S3Storage (against a local S3-API-compatible test double)', () => {
  let fake: FakeS3
  let storage: S3Storage
  beforeAll(async () => {
    fake = await startFakeS3()
    storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', endpoint: fake.url, accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true })
  })
  afterAll(() => fake.close())

  const key = () => `${randomUUID()}/assets/2026/10/${randomUUID()}.pdf`

  it('round-trips bytes exactly', async () => {
    const k = key()
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 255, 0, 128])
    await storage.put(k, data)
    const back = await storage.get(k)
    expect(Buffer.from(data).equals(back)).toBe(true)
  })

  it('reports existence correctly before and after put, and after delete', async () => {
    const k = key()
    expect(await storage.exists(k)).toBe(false)
    await storage.put(k, new Uint8Array([1, 2, 3]))
    expect(await storage.exists(k)).toBe(true)
    await storage.delete(k)
    expect(await storage.exists(k)).toBe(false)
  })

  it('throws on get for a missing key rather than returning empty data', async () => {
    await expect(storage.get(key())).rejects.toThrow()
  })

  it('deleting a key that was never written does not throw (idempotent)', async () => {
    await expect(storage.delete(key())).resolves.toBeUndefined()
  })

  it('rejects a key that does not match the server-generated key format', async () => {
    await expect(storage.put('../escape', new Uint8Array([1]))).rejects.toThrow('Invalid storage key')
    await expect(storage.get('not-a-valid-key')).rejects.toThrow('Invalid storage key')
  })
})
