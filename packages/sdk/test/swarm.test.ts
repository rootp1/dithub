import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { arkivManifestContent, parseArkivManifestContent, recoverRepositoryFromManifestContent } from '../src/arkiv.ts'
import { canonicalJson } from '../src/canonical.ts'
import { sha256 } from '../src/hash.ts'
import { LocalNetworkStore } from '../src/local-store.ts'
import { isolatedGitEnvironment } from '../src/process.ts'
import { cloneRepository, initialiseRepository, publishRepository, reconstructBundle, verifyRepository } from '../src/repository.ts'
import {
  createSwarmClient,
  deserializeEnvelope,
  fetchPackFromSwarm,
  publishPackToSwarm,
  serializeEnvelope,
  swarmConfigFromEnv,
  type SwarmClient,
} from '../src/swarm.ts'
import { encryptPrivateChunk } from '../src/private.ts'
import { startMockBee, type MockBee } from '../src/testing/mock-bee.ts'
import type { Hex } from '../src/types.ts'

const BATCH = 'ab'.repeat(32)
const repoId = sha256('swarm-test-repo')
let bee: MockBee
let client: SwarmClient
const roots: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: isolatedGitEnvironment(), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

beforeAll(async () => {
  bee = await startMockBee()
  client = createSwarmClient({ beeUrl: bee.url, postageBatchId: BATCH })
})
afterAll(() => {
  bee.stop()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('swarm client', () => {
  test('upload/download round trip with content addressing', async () => {
    const data = new TextEncoder().encode('hello swarm')
    const { reference } = await client.uploadBytes(data, { pin: true })
    expect(reference).toMatch(/^[0-9a-f]{64}$/)
    expect(await client.downloadBytes(reference)).toEqual(data)
    expect((await client.uploadBytes(data)).reference).toBe(reference)
    const encrypted = await client.uploadBytes(data, { encrypt: true })
    expect(encrypted.reference).toMatch(/^[0-9a-f]{128}$/)
    expect(await client.health()).toBe(true)
  })

  test('clear errors: missing batch, unknown ref, unreachable node', async () => {
    await expect(createSwarmClient({ beeUrl: bee.url }).uploadBytes(new Uint8Array([1]))).rejects.toThrow(/postage batch/)
    await expect(client.downloadBytes('00'.repeat(32))).rejects.toThrow(/HTTP 404/)
    await expect(client.downloadBytes('nope')).rejects.toThrow(/Invalid Swarm reference/)
    const dead = createSwarmClient({ beeUrl: 'http://127.0.0.1:1', postageBatchId: BATCH, downloadTimeoutMs: 2000 })
    await expect(dead.downloadBytes('00'.repeat(32))).rejects.toThrow(/Swarm download/)
    expect(await dead.health()).toBe(false)
  })

  test('GET is retried once on a 5xx', async () => {
    let calls = 0
    const flaky = createSwarmClient({
      beeUrl: 'http://bee.test',
      fetch: (async () => (++calls === 1 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array([7])))) as unknown as typeof fetch,
    })
    expect(await flaky.downloadBytes('11'.repeat(32))).toEqual(new Uint8Array([7]))
    expect(calls).toBe(2)
  })

  test('upload times out with a clear error', async () => {
    const slow = createSwarmClient({
      beeUrl: 'http://bee.test',
      postageBatchId: BATCH,
      uploadTimeoutMs: 50,
      fetch: ((_: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch,
    })
    await expect(slow.uploadBytes(new Uint8Array([1]))).rejects.toThrow(/timed out/)
  })

  test('config from env', () => {
    expect(swarmConfigFromEnv({})).toBeNull()
    expect(swarmConfigFromEnv({ BEE_URL: 'http://bee:1633', BEE_POSTAGE_BATCH_ID: BATCH })).toEqual({ beeUrl: 'http://bee:1633', postageBatchId: BATCH })
  })

  test('envelope serialization is deterministic and reversible', () => {
    const envelope = encryptPrivateChunk({ plaintext: new Uint8Array([1, 2, 3]), key: new Uint8Array(32).fill(1), repoId, keyEpoch: 2, nonce: new Uint8Array(24).fill(3) })
    const bytes = serializeEnvelope(envelope)
    expect(serializeEnvelope(deserializeEnvelope(bytes))).toEqual(bytes)
    expect(deserializeEnvelope(bytes).ciphertext).toEqual(envelope.ciphertext)
  })
})

describe('packs on swarm', () => {
  const packBytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256)
  const manifest = { name: 'demo', refs: [{ name: 'refs/heads/main', oid: 'a'.repeat(40) }] }

  test('public round trip', async () => {
    const refs = await publishPackToSwarm(client, { repoId, packBytes, manifest })
    const fetched = await fetchPackFromSwarm(client, refs.manifestRef)
    expect(fetched.packBytes).toEqual(packBytes)
    expect(fetched.manifest).toEqual(manifest)
    expect(fetched.packRef).toBe(refs.packRef)
    expect(fetched.encrypted).toBe(false)
  })

  test('encrypted round trip; Swarm only sees ciphertext', async () => {
    const key = new Uint8Array(32).fill(9)
    const refs = await publishPackToSwarm(client, { repoId, packBytes, manifest, encryptWith: { key, keyEpoch: 4 } })
    const storedManifest = new TextDecoder().decode(bee.stored.get(refs.manifestRef))
    expect(storedManifest).not.toContain('demo')
    expect(storedManifest).not.toContain('refs/heads/main')
    expect(bee.stored.get(refs.packRef)?.byteLength).toBeGreaterThan(packBytes.byteLength)
    const fetched = await fetchPackFromSwarm(client, refs.manifestRef, key)
    expect(fetched.packBytes).toEqual(packBytes)
    expect(fetched.manifest).toEqual(manifest)
    expect(fetched.encrypted).toBe(true)
    expect(fetched.keyEpoch).toBe(4)
  })

  test('wrong or missing key fails', async () => {
    const refs = await publishPackToSwarm(client, { repoId, packBytes, manifest, encryptWith: { key: new Uint8Array(32).fill(9), keyEpoch: 1 } })
    await expect(fetchPackFromSwarm(client, refs.manifestRef, new Uint8Array(32).fill(8))).rejects.toThrow(/Cannot decrypt/)
    await expect(fetchPackFromSwarm(client, refs.manifestRef)).rejects.toThrow(/repository key is required/)
  })

  test('tampered pack is rejected', async () => {
    const refs = await publishPackToSwarm(client, { repoId, packBytes, manifest })
    const stored = bee.stored.get(refs.packRef)!
    stored[0] = (stored[0] ?? 0) ^ 1
    await expect(fetchPackFromSwarm(client, refs.manifestRef)).rejects.toThrow(/failed verification/)
    stored[0] = (stored[0] ?? 0) ^ 1
  })
})

describe('recovery from an Arkiv manifest', () => {
  async function published() {
    const work = tempDir('swarm-work-')
    git(work, 'init', '-q', '-b', 'main')
    writeFileSync(join(work, 'README.md'), '# swarm recovery\n')
    writeFileSync(join(work, 'big.bin'), new Uint8Array(150_000).map((_, i) => i % 7))
    git(work, 'add', '.')
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
    const source = new LocalNetworkStore(tempDir('swarm-src-'))
    initialiseRepository(work, 'demo', source)
    const result = publishRepository(work, 'demo', source)
    return { work, source, ...result }
  }

  test('manifest content carries refs and stays backward compatible', async () => {
    const { manifest, manifestHash } = await published()
    const plain = arkivManifestContent(manifest)
    expect(new TextDecoder().decode(plain)).toBe(canonicalJson(manifest))
    expect(parseArkivManifestContent(plain, manifestHash)).toEqual({ manifest, swarm: null })
    const refs = { packRef: 'aa'.repeat(32), manifestRef: 'bb'.repeat(32) }
    expect(parseArkivManifestContent(arkivManifestContent(manifest, refs), manifestHash)).toEqual({ manifest, swarm: refs })
    expect(() => parseArkivManifestContent(arkivManifestContent({ ...manifest, sequence: 99 }, refs), manifestHash)).toThrow(/hash mismatch/)
  })

  test('prefers Swarm bytes, no Arkiv chunk reads', async () => {
    const { work, source, manifest, manifestHash } = await published()
    const refs = await publishPackToSwarm(client, { repoId: manifest.repoId, packBytes: reconstructBundle(source, manifest), manifest })
    const store = new LocalNetworkStore(tempDir('swarm-dst-'))
    let arkivReads = 0
    const result = await recoverRepositoryFromManifestContent({
      repoId: manifest.repoId,
      manifestHash,
      content: arkivManifestContent(manifest, refs),
      store,
      swarm: client,
      fetchChunk: async (hash) => { arkivReads += 1; return source.getChunk(hash) },
    })
    expect(result.source).toBe('swarm')
    expect(arkivReads).toBe(0)
    expect(verifyRepository(manifest.repoId, store).valid).toBe(true)
    const clone = join(tempDir('swarm-clone-'), 'out')
    cloneRepository(manifest.repoId, clone, store)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'HEAD'))
  })

  test('pointer-only content (manifest too big to inline) recovers from Swarm', async () => {
    const { source, manifest, manifestHash } = await published()
    const refs = await publishPackToSwarm(client, { repoId: manifest.repoId, packBytes: reconstructBundle(source, manifest), manifest })
    const store = new LocalNetworkStore(tempDir('swarm-dst-'))
    const result = await recoverRepositoryFromManifestContent({
      repoId: manifest.repoId,
      manifestHash,
      content: new TextEncoder().encode(canonicalJson({ swarmManifestRef: refs.manifestRef, swarmPackRef: refs.packRef })),
      store,
      swarm: client,
      fetchChunk: async () => { throw new Error('no Arkiv') },
    })
    expect(result.manifest).toEqual(manifest)
    expect(verifyRepository(manifest.repoId, store).valid).toBe(true)
  })

  test('private pack recovers with the repo key', async () => {
    const { source, manifest, manifestHash } = await published()
    const key = new Uint8Array(32).fill(5)
    const refs = await publishPackToSwarm(client, { repoId: manifest.repoId, packBytes: reconstructBundle(source, manifest), manifest, encryptWith: { key, keyEpoch: 0 } })
    const store = new LocalNetworkStore(tempDir('swarm-dst-'))
    const result = await recoverRepositoryFromManifestContent({
      repoId: manifest.repoId, manifestHash, content: arkivManifestContent(manifest, refs), store, swarm: client, swarmKey: key,
      fetchChunk: async () => { throw new Error('no Arkiv') },
    })
    expect(result.source).toBe('swarm')
  })

  test('falls back to Arkiv chunks when Swarm is down or absent', async () => {
    const { source, manifest, manifestHash } = await published()
    const refs = { packRef: 'cd'.repeat(32), manifestRef: 'ef'.repeat(32) }    // never uploaded
    for (const swarm of [client, null]) {
      const store = new LocalNetworkStore(tempDir('swarm-dst-'))
      const logs: string[] = []
      const result = await recoverRepositoryFromManifestContent({
        repoId: manifest.repoId,
        manifestHash,
        content: arkivManifestContent(manifest, refs),
        store,
        swarm,
        fetchChunk: async (hash: Hex) => source.getChunk(hash),
        log: (message) => logs.push(message),
      })
      expect(result.source).toBe('arkiv')
      expect(logs.length).toBe(1)
      expect(verifyRepository(manifest.repoId, store).valid).toBe(true)
    }
  })
})
