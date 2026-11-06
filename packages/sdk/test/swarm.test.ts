import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmStore, publishSnapshot, restoreSnapshot, snapshotGit, fileDigest, readSnapshot } from '../src/index.ts'
import { beeFixture, sampleRepo } from './swarm-fixture.ts'
import { recover, parseRecoverArgs } from '../../dit/src/cmd/recover.ts'

const repoId = `0x${'12'.repeat(32)}`

test('large snapshot round trip restores branches, annotated tags and bytes; recovery file works with no API or Arkiv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-roundtrip-')), bee = beeFixture(), reader = beeFixture()
  try {
    const repoPath = await sampleRepo(dir)
    // Independent reader serves the same simulated network without hitting uploader on GET.
    const readServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      const ref = new URL(request.url).pathname.slice(7)
      reader.calls.push(`GET ${ref}`)
      return bee.data.has(ref) ? new Response(Buffer.from(bee.data.get(ref)!)) : new Response('', { status: 404 })
    } })
    try {
      const stages: string[] = [], work = join(dir, 'publish')
      await mkdir(work)
      const swarm = new SwarmStore({ url: bee.url, batchId: 'aa'.repeat(32), readUrl: readServer.url.origin })
      const result = await publishSnapshot({ repoPath, repoId, name: 'alice/repo', sequence: 1, defaultBranch: 'main', dir: work, swarm, onStage: async (stage) => { stages.push(stage) } })
      expect(stages).toEqual(['preparing', 'uploading', 'verifying'])
      expect(result.manifest.bundle.size).toBeGreaterThan(2_000_000)
      expect(result.manifest.refs.map((r) => r.name)).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/tags/v1'])
      expect(bee.calls.filter((call) => call.startsWith('GET /bytes/'))).toHaveLength(0)
      expect(reader.calls.length).toBe(2)
      const file = join(dir, 'instructions.json')
      await writeFile(file, JSON.stringify({ version: 1, repoId, name: 'alice/repo', pointer: result.pointer }))
      const args = parseRecoverArgs([repoId, join(dir, 'recovered'), '--recovery-file', file, '--bee-url', readServer.url.origin, '--json'], {})
      const restored = await recover(args)
      expect(restored).toMatchObject({ backend: 'swarm', fsck: 'ok', repoId })
      expect(await fileDigest(join(dir, 'recovered', 'large.bin'))).toEqual(await fileDigest(join(repoPath, 'large.bin')))
      expect(await snapshotGit(['for-each-ref', '--format=%(refname)'], join(dir, 'recovered'))).toBe('refs/heads/feature\nrefs/heads/main\nrefs/tags/v1')
      expect(await snapshotGit(['remote'], join(dir, 'recovered'))).toBe('')
      const secret = await snapshotGit(['rev-parse', 'refs/dheet/private-session'], repoPath)
      await expect(snapshotGit(['cat-file', '-e', secret], join(dir, 'recovered'))).rejects.toThrow()
      await expect(recover({ ...args, target: `0x${'34'.repeat(32)}`, dir: join(dir, 'wrong') })).rejects.toThrow('does not match')
    } finally { readServer.stop(true) }
  } finally { bee.stop(); reader.stop(); await rm(dir, { recursive: true, force: true }) }
}, 30_000)

test('SHA-256 Git repositories restore with their original object format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-sha256-')), bee = beeFixture()
  try {
    const source = await sampleRepo(dir, 'sha256'), pub = join(dir, 'pub'), rec = join(dir, 'rec')
    await mkdir(pub); await mkdir(rec)
    const swarm = new SwarmStore({ url: bee.url, batchId: 'aa'.repeat(32) })
    const result = await publishSnapshot({ swarm, repoPath: source, repoId, name: 'alice/sha256', sequence: 1, defaultBranch: 'main', dir: pub })
    const dest = join(dir, 'restored')
    await restoreSnapshot({ swarm, pointer: result.pointer, repoId, dir: rec, destination: dest })
    expect(await snapshotGit(['rev-parse', '--show-object-format'], dest)).toBe('sha256')
    expect(await snapshotGit(['rev-parse', 'HEAD'], dest)).toBe(await snapshotGit(['rev-parse', 'HEAD'], source))
  } finally { bee.stop(); await rm(dir, { recursive: true, force: true }) }
}, 30_000)

test('corruption, missing data, oversized downloads, wrong repository and upload failures do not produce a usable backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-invalid-')), bee = beeFixture()
  try {
    const swarm = new SwarmStore({ url: bee.url, batchId: 'aa'.repeat(32) })
    const path = join(dir, 'data'); await writeFile(path, 'original')
    const digest = await fileDigest(path), reference = await swarm.uploadFile(path)
    await expect(swarm.downloadFile(reference, path, digest)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('original')
    bee.corrupt(true)
    await expect(swarm.downloadFile(reference, join(dir, 'bad'), digest)).rejects.toThrow('mismatch')
    expect(existsSync(join(dir, 'bad'))).toBe(false)
    bee.corrupt(false)
    await expect(swarm.downloadFile(reference, join(dir, 'oversize'), { ...digest, size: 1 })).rejects.toThrow('exceeds')
    await expect(swarm.downloadFile('ff'.repeat(32), join(dir, 'missing'), digest)).rejects.toThrow('HTTP 404')
    bee.failNextUpload()
    await expect(swarm.uploadFile(path)).rejects.toThrow('HTTP 503')
    await expect(swarm.downloadFile('aa'.repeat(64), join(dir, 'encrypted'), digest)).rejects.toThrow('Invalid public')
    const repoPath = await sampleRepo(dir), pubDir = join(dir, 'pub'); await mkdir(pubDir)
    const result = await publishSnapshot({ repoPath, repoId, name: 'alice/repo', sequence: 1, defaultBranch: 'main', dir: pubDir, swarm })
    const readDir = join(dir, 'read'); await mkdir(readDir)
    await expect(readSnapshot(swarm, result.pointer, `0x${'ab'.repeat(32)}`, readDir)).rejects.toThrow('repo ID mismatch')
    bee.setTTL(0)
    await expect(swarm.batchStatus()).rejects.toThrow('expired')
  } finally { bee.stop(); await rm(dir, { recursive: true, force: true }) }
}, 30_000)
