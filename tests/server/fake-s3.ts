import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * Minimal S3-API-compatible test double (path-style `/bucket/key`): PUT/GET/HEAD/DELETE against
 * an in-memory object store. It does not validate SigV4 signatures or any other AWS-specific
 * behavior -- it exists only to exercise `S3Storage`'s real HTTP request/response handling
 * (byte-identical round trip, 404 mapping, error propagation) without a live cloud account.
 * This is NOT a substitute for testing against the actual chosen provider before go-live.
 */
export interface FakeS3 {
  url: string
  objects: Map<string, Buffer>
  close(): Promise<void>
}

export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!
    const key = decodeURIComponent(path.replace(/^\/[^/]+\//, ''))
    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks))
        res.writeHead(200, { etag: '"fake"' })
        res.end()
      })
      return
    }
    if (req.method === 'HEAD') {
      const body = objects.get(key)
      if (!body) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'content-length': String(body.byteLength) })
      return res.end()
    }
    if (req.method === 'GET') {
      const body = objects.get(key)
      if (!body) {
        res.writeHead(404, { 'content-type': 'application/xml' })
        return res.end('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>')
      }
      res.writeHead(200, { 'content-length': String(body.byteLength) })
      return res.end(body)
    }
    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(405)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}
