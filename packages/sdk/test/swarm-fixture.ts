import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshotGit } from '../src/snapshot.ts'

export async function sampleRepo(dir: string, format = 'sha1') {
  const path = join(dir, 'source')
  await snapshotGit(['init', '-b', 'main', `--object-format=${format}`, path])
  await snapshotGit(['config', 'user.name', 'Test'], path)
  await snapshotGit(['config', 'user.email', 'test@example.com'], path)
  await writeFile(join(path, 'large.bin'), randomBytes(3 * 1024 ** 2))
  await snapshotGit(['add', '.'], path)
  await snapshotGit(['commit', '-m', 'large public file'], path)
  await snapshotGit(['branch', 'feature'], path)
  await snapshotGit(['tag', '-a', 'v1', '-m', 'release'], path)
  const secret = await snapshotGit(['commit-tree', await snapshotGit(['rev-parse', 'HEAD^{tree}'], path), '-p', 'HEAD'], path, 'internal session commit\n')
  await snapshotGit(['update-ref', 'refs/dheet/private-session', secret], path)
  return path
}

/** In-memory Bee protocol fixture; references here are test hashes, not Swarm BMT addresses. */
export function beeFixture() {
  const data = new Map<string, Uint8Array>()
  const calls: string[] = []
  let failUploads = 0, corruptReads = false, ttl = 86400 * 30
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname
    calls.push(`${request.method} ${path}`)
    if (path.startsWith('/stamps/')) return Response.json({ usable: ttl > 0, batchTTL: ttl, expired: ttl <= 0 })
    if (request.method === 'POST' && path === '/bytes') {
      if (failUploads-- > 0) return new Response('test upload error', { status: 503 })
      if (request.headers.get('swarm-postage-batch-id') !== 'aa'.repeat(32) || request.headers.get('swarm-deferred-upload') !== 'false') return new Response('bad headers', { status: 400 })
      const bytes = new Uint8Array(await request.arrayBuffer())
      const reference = createHash('sha256').update(bytes).digest('hex')
      data.set(reference, bytes)
      return Response.json({ reference }, { status: 201 })
    }
    if (request.method === 'GET' && path.startsWith('/bytes/')) {
      const bytes = data.get(path.slice(7))
      if (!bytes) return new Response('missing', { status: 404 })
      return new Response(corruptReads ? new Uint8Array([1, 2, 3]) : Buffer.from(bytes))
    }
    return new Response('missing', { status: 404 })
  } })
  return { url: server.url.origin, data, calls, stop: () => server.stop(true), failNextUpload: () => { failUploads = 1 }, corrupt: (value: boolean) => { corruptReads = value }, setTTL: (value: number) => { ttl = value } }
}
