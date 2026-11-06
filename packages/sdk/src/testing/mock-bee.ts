// In-process stand-in for a Bee node: POST /bytes, GET /bytes/{ref}, GET /health. Content addressed with sha256.
import { createHash } from 'node:crypto'

export interface MockBee {
  url: string
  stop(): void
  stored: Map<string, Uint8Array>
}

export async function startMockBee(): Promise<MockBee> {
  const stored = new Map<string, Uint8Array>()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', version: 'mock' })
      if (url.pathname === '/bytes' && request.method === 'POST') {
        if (!/^[0-9a-f]{64}$/i.test(request.headers.get('swarm-postage-batch-id') ?? '')) {
          return Response.json({ code: 400, message: 'invalid postage batch id' }, { status: 400 })
        }
        const data = new Uint8Array(await request.arrayBuffer())
        let reference = createHash('sha256').update(data).digest('hex')
        if (request.headers.get('swarm-encrypt') === 'true') {
          reference += createHash('sha256').update('mock-encryption-key').update(data).digest('hex')
        }
        stored.set(reference, data)
        return Response.json({ reference }, { status: 201 })
      }
      const match = /^\/bytes\/([0-9a-f]{64}(?:[0-9a-f]{64})?)$/.exec(url.pathname)
      if (match?.[1] && request.method === 'GET') {
        const data = stored.get(match[1])
        if (!data) return Response.json({ code: 404, message: 'Not Found' }, { status: 404 })
        return new Response(data as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/octet-stream' } })
      }
      return Response.json({ code: 404, message: 'Not Found' }, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true), stored }
}
