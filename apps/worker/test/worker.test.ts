import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SQL } from 'bun'
import { migrate, openDb, json } from '../../../packages/db/src/index.ts'
import {
  LocalNetworkStore, createSwarmClient, fetchPackFromSwarm, generateDeviceKey, grantContext, isSerializedEnvelope, isolatedGitEnvironment,
  openRepoKey, privateRepoArkivId, sha256, type ActivityInput, type Grant, type Hex, type RepositoryManifest, type SwarmClient, type SwarmPackRefs,
} from '../../../packages/sdk/src/index.ts'
import { startMockBee, type MockBee } from '../../../packages/sdk/src/testing/mock-bee.ts'
import { openPrivateBody, isPrivateBody } from '../../../packages/indexer/src/private-body.ts'
import { claimJob, createWorker, failJob, tick, type WorkerArkiv, type WorkerDeps } from '../src/jobs.ts'
import { deploymentHandlers } from '../src/deployments.ts'
import { networkOf } from '../../../deployments/networks.ts'

const root = mkdtempSync(join(tmpdir(), 'dithub-worker-'))
const reposDir = join(root, 'repos')
const BATCH = 'ab'.repeat(32)
const REGISTRY = `0x${'11'.repeat(20)}` as Hex
const server = generateDeviceKey()
const member = generateDeviceKey()
let sql: SQL
let bee: MockBee
let swarm: SwarmClient
let n = 0
const fakeHash = () => sha256(`entity-${++n}`)

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, env: isolatedGitEnvironment(), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/** A bare repo at reposDir/<hex>.git with one commit on main; returns its head oid and subject. */
function makeRepo(hex: string, subject: string, file: string) {
  const work = join(root, `work-${hex.slice(0, 8)}`)
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T')
  writeFileSync(join(work, file), `secret contents of ${file}\n`)
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', subject)
  git(root, 'clone', '-q', '--bare', work, join(reposDir, `${hex}.git`))
  return git(work, 'rev-parse', 'HEAD')
}

function mockArkiv() {
  const calls = { activity: [] as ActivityInput[], names: [] as string[], manifests: [] as Array<{ manifest: RepositoryManifest; swarm?: SwarmPackRefs; uploadChunks: boolean }>,
    deviceKeys: [] as unknown[], grants: [] as Grant[] }
  const result = () => ({ entityKey: fakeHash(), txHash: fakeHash(), expiresAt: 1000n })
  const arkiv: WorkerArkiv = {
    relayer: `0x${'22'.repeat(20)}`,
    recordActivity: async (input) => { calls.activity.push(input); return result() },
    claimName: async (name) => { calls.names.push(name); return result() },
    uploadManifest: async (a) => { calls.manifests.push(a); return { manifestEntityKey: fakeHash(), transactionHashes: [fakeHash()], chunkEntities: 0, uploadedChunkHashes: [], expiresAt: 1000n } },
    publishDeviceKey: async (input) => { calls.deviceKeys.push(input); return result() },
    publishGrant: async (g) => { calls.grants.push(g); return result() },
    head: async () => 0n,
    renew: async () => [],
  }
  return { arkiv, calls }
}

function setup(over: Partial<WorkerDeps> = {}) {
  const { arkiv, calls } = mockArkiv()
  const anchors: Array<{ refName: string; gitOid: string; manifestRoot: Hex; refRegistry: Hex }> = []
  const logs: string[] = []
  const worker = createWorker({
    sql, arkiv, store: new LocalNetworkStore(join(root, `store-${++n}`)), reposDir, l1ChainId: 8453, defaultRegistry: REGISTRY,
    anchor: async (a) => { anchors.push(a); return { transactionHash: fakeHash(), sequence: 7n, refRoot: fakeHash(), oid: fakeHash(), alreadyAnchored: false } },
    publishCode: true, codeMaxBytes: 2_000_000, swarmMaxBytes: 50_000_000, maxCommits: 50, swarm,
    deviceKey: server.privateKey.slice(2), privateIdSecret: server.privateKey, log: (m) => logs.push(m), ...over,
  })
  return { worker, calls, anchors, logs }
}

async function seedPush(opts: { login: string; name: string; visibility: 'public' | 'private'; subject: string; file: string }) {
  const repoHex = sha256(`${opts.login}/${opts.name}`).slice(2)
  const head = makeRepo(repoHex, opts.subject, opts.file)
  const [u] = await sql`INSERT INTO users (login) VALUES (${opts.login}) RETURNING id`
  const userId = Number(u.id)
  await sql`INSERT INTO wallets (user_id, address, is_primary, verified_at) VALUES (${userId}, ${Buffer.from('33'.repeat(20), 'hex')}, 1, ${new Date().toISOString()})
    ON CONFLICT DO NOTHING`
  const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name, visibility) VALUES (${Buffer.from(repoHex, 'hex')}, 'user', ${userId}, ${opts.name}, ${opts.visibility}) RETURNING id`
  const repoNum = Number(r.id)
  const oid = Buffer.from(head, 'hex')
  const [p] = await sql`INSERT INTO pushes (repo_id, pusher_id, ref_name, new_oid) VALUES (${repoNum}, ${userId}, 'refs/heads/main', ${oid}) RETURNING id`
  const pushId = Number(p.id)
  await sql`INSERT INTO commits (repo_id, oid, tree_oid, parent_oids, authored_at, committed_at, message, subject)
    VALUES (${repoNum}, ${oid}, ${oid}, '[]', ${new Date().toISOString()}, ${new Date().toISOString()}, ${opts.subject}, ${opts.subject})`
  await sql`INSERT INTO commit_anchors (repo_id, commit_oid, push_id, ref_name) VALUES (${repoNum}, ${oid}, ${pushId}, 'refs/heads/main')`
  await sql`INSERT INTO name_claims (name, dheet_repo_id, claimant) VALUES (${`${opts.login}/${opts.name}`}, ${Buffer.from(repoHex, 'hex')}, ${Buffer.alloc(20)})`
  const [job] = await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('push', ${pushId}, 'push', ${json({ pushId, repoId: `0x${repoHex}` })}) RETURNING id`
  return { repoHex, repoNum, pushId, userId, head, jobId: Number(job.id) }
}

beforeAll(async () => {
  mkdirSync(reposDir, { recursive: true })
  sql = openDb(join(root, 'db/test.sqlite'))
  await migrate(sql, { log: () => {} })
  bee = await startMockBee()
  swarm = createSwarmClient({ beeUrl: bee.url, postageBatchId: BATCH })
})
afterAll(async () => {
  bee.stop()
  await sql.close()
  rmSync(root, { recursive: true, force: true })
})

describe('outbox', () => {
  test('claims the oldest due job once, backs off on failure, goes dead after 8 attempts', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload, next_attempt_at) VALUES ('x', 1, 'later', '{}', ${future})`
    const [a] = await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('x', 1, 'noop', ${json({ a: 1 })}) RETURNING id`
    const job = await claimJob(sql)
    expect(job?.id).toBe(Number(a.id))
    expect(job?.payload).toEqual({ a: 1 })
    expect(job?.attempts).toBe(1)
    expect(await claimJob(sql)).toBeNull()   // the other one is processing or not due
    await failJob(sql, job!, new Error('boom'))
    const [row] = await sql`SELECT status, last_error, next_attempt_at FROM outbox WHERE id = ${job!.id}`
    expect(row.status).toBe('pending')
    expect(row.last_error).toContain('boom')
    expect(row.next_attempt_at > new Date().toISOString()).toBe(true)
    await failJob(sql, { ...job!, attempts: 8 }, 'x')
    expect((await sql`SELECT status FROM outbox WHERE id = ${job!.id}`)[0].status).toBe('dead')
    await sql`DELETE FROM outbox`
  })

  test('tick runs a handler and marks the job done; unknown kinds fail', async () => {
    await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('x', 1, 'ok', '{}'), ('x', 1, 'nope', '{}')`
    const seen: number[] = []
    expect(await tick(sql, { ok: async (j) => { seen.push(j.id) } })).toBe(true)
    expect(await tick(sql, {})).toBe(true)
    expect(await tick(sql, {})).toBe(false)
    const rows = await sql`SELECT kind, status, last_error FROM outbox ORDER BY id`
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['done', 'pending'])
    expect(rows[1].last_error).toContain('no handler')
    expect(seen.length).toBe(1)
    await sql`DELETE FROM outbox`
  })
})

describe('public push', () => {
  test('anchors, records commits, uploads the pack to Swarm and points the Arkiv manifest at it', async () => {
    const s = await seedPush({ login: 'alice', name: 'pub', visibility: 'public', subject: 'add readme', file: 'README.md' })
    const { worker, calls, anchors } = setup()
    expect(await tick(sql, worker.handlers)).toBe(true)
    expect((await sql`SELECT status, last_error FROM outbox WHERE id = ${s.jobId}`)[0]).toEqual({ status: 'done', last_error: null })

    expect(anchors[0]!.refName).toBe(`0x${s.repoHex}:refs/heads/main`)
    expect(anchors[0]!.gitOid).toBe(s.head)
    const ca = (await sql`SELECT status, l1_tx, arkiv_entity FROM commit_anchors WHERE push_id = ${s.pushId}`)[0]
    expect(ca.status).toBe('anchored')
    expect(ca.arkiv_entity).toBeTruthy()

    const uploads = await sql`SELECT kind, reference, encrypted FROM swarm_uploads WHERE push_id = ${s.pushId} ORDER BY id`
    expect(uploads.map((u: { kind: string }) => u.kind)).toEqual(['pack', 'manifest'])
    expect(uploads.every((u: { encrypted: number }) => u.encrypted === 0)).toBe(true)
    const manifestRef = uploads[1].reference
    expect(calls.manifests[0]!.swarm).toEqual({ packRef: uploads[0].reference, manifestRef })
    expect(calls.manifests[0]!.uploadChunks).toBe(true)

    const fetched = await fetchPackFromSwarm<RepositoryManifest>(swarm, manifestRef)
    expect(fetched.encrypted).toBe(false)
    expect(sha256(fetched.packBytes)).toBe(fetched.manifest.bundleHash)
    expect(fetched.manifest.refs.map((r) => r.name)).toContain('refs/heads/main')

    const kinds = calls.activity.map((a) => a.kind)
    expect(kinds).toEqual(['commit', 'push'])
    expect((calls.activity[1]!.body as { swarmManifestRef: string }).swarmManifestRef).toBe(manifestRef)
    expect((await sql`SELECT manifest_hash FROM pushes WHERE id = ${s.pushId}`)[0].manifest_hash).toBeTruthy()

    // a retry of the same job is a no-op
    await worker.handlers.push!({ id: s.jobId, kind: 'push', payload: { pushId: s.pushId }, aggregate_id: s.pushId, attempts: 2 })
    expect(calls.activity.length).toBe(2)
    expect(anchors.length).toBe(1)
    expect((await sql`SELECT count(*) AS c FROM swarm_uploads WHERE push_id = ${s.pushId}`)[0].c).toBe(2)

    // the name claim goes to Arkiv for a public repo
    await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('repo', ${s.repoNum}, 'name_claim', ${json({ repoId: `0x${s.repoHex}`, name: 'alice/pub' })})`
    await tick(sql, worker.handlers)
    expect(calls.names).toEqual(['alice/pub'])
    expect((await sql`SELECT arkiv_entity FROM name_claims WHERE name = 'alice/pub'`)[0].arkiv_entity).toBeTruthy()
  })

  test('bytes reach Swarm even when Arkiv is down, and the retry does not upload again', async () => {
    const s = await seedPush({ login: 'erin', name: 'arkivdown', visibility: 'public', subject: 'init', file: 'x.txt' })
    const { worker, calls } = setup()
    const real = worker.handlers.push!
    const arkivDown = setup({ arkiv: { ...mockArkiv().arkiv, recordActivity: async () => { throw new Error('arkiv unreachable') } } })
    const job = { id: s.jobId, kind: 'push', payload: { pushId: s.pushId }, aggregate_id: s.pushId, attempts: 1 }
    await expect(arkivDown.worker.handlers.push!(job)).rejects.toThrow('arkiv unreachable')
    const first = await sql`SELECT kind, reference FROM swarm_uploads WHERE push_id = ${s.pushId} ORDER BY id`
    expect(first.map((u: { kind: string }) => u.kind)).toEqual(['pack', 'manifest'])
    const stored = bee.stored.size
    await real({ ...job, attempts: 2 })
    expect(bee.stored.size).toBe(stored)
    expect((await sql`SELECT count(*) AS c FROM swarm_uploads WHERE push_id = ${s.pushId}`)[0].c).toBe(2)
    expect(calls.manifests[0]!.swarm).toEqual({ packRef: first[0].reference, manifestRef: first[1].reference })
    await sql`UPDATE outbox SET status = 'done' WHERE id = ${s.jobId}`   // arkiv_entities reference it
  })

  test('without Swarm it logs once and keeps the Arkiv-only path', async () => {
    const s = await seedPush({ login: 'bob', name: 'noswarm', visibility: 'public', subject: 'init', file: 'a.txt' })
    const { worker, calls, logs } = setup({ swarm: null })
    await tick(sql, worker.handlers)
    expect((await sql`SELECT status FROM outbox WHERE id = ${s.jobId}`)[0].status).toBe('done')
    expect((await sql`SELECT count(*) AS c FROM swarm_uploads WHERE push_id = ${s.pushId}`)[0].c).toBe(0)
    expect(calls.manifests.length).toBe(1)
    expect(calls.manifests[0]!.swarm).toBeUndefined()
    expect(logs.filter((l) => l.includes('BEE_URL not set')).length).toBe(1)
  })
})

describe('private push', () => {
  test('creates the repo key, encrypts the pack on Swarm and writes only opaque data to Arkiv and L1', async () => {
    const s = await seedPush({ login: 'carol', name: 'topsecret-project', visibility: 'private', subject: 'confidential plan', file: 'plan.md' })
    await sql`INSERT INTO device_keys (user_id, public_key, signature) VALUES (${s.userId}, ${Buffer.from(member.publicKey.slice(2), 'hex')}, ${Buffer.alloc(65)})`
    const { worker, calls, anchors } = setup()
    const before = new Set(bee.stored.keys())
    await tick(sql, worker.handlers)
    expect((await sql`SELECT status, last_error FROM outbox WHERE id = ${s.jobId}`)[0]).toEqual({ status: 'done', last_error: null })

    const arkivId = privateRepoArkivId(`0x${s.repoHex}`, server.privateKey.toLowerCase())   // apps/api/src/keys.ts arkivRepoId()
    expect(worker.arkivIdOf(s.repoHex)).toBe(arkivId)
    // repo key epoch 0, sealed to the server and bound to the opaque id
    const [rk] = await sql`SELECT epoch, sealed FROM repo_keys WHERE repo_id = ${s.repoNum}`
    expect(Number(rk.epoch)).toBe(0)
    const repoKey = openRepoKey(new Uint8Array(rk.sealed), server.privateKey, grantContext(arkivId, 0))

    // L1: opaque id, no ref name, no real oid
    expect(anchors[0]!.refName.startsWith(`${arkivId}:`)).toBe(true)
    expect(anchors[0]!.refName).not.toContain('refs/heads')
    expect(anchors[0]!.gitOid).not.toBe(s.head)
    expect(anchors[0]!.refRegistry).toBe(REGISTRY)

    // Swarm: everything new is an encrypted envelope, no plaintext names, paths or subjects
    const uploads = await sql`SELECT kind, reference, encrypted FROM swarm_uploads WHERE push_id = ${s.pushId} ORDER BY id`
    expect(uploads.map((u: { encrypted: number }) => u.encrypted)).toEqual([1, 1])
    for (const [ref, bytes] of bee.stored) {
      if (before.has(ref)) continue
      expect(isSerializedEnvelope(bytes)).toBe(true)
      const text = Buffer.from(bytes).toString('latin1')
      for (const leak of ['topsecret-project', 'carol', 'refs/heads/main', 'confidential plan', 'plan.md', s.repoHex]) expect(text).not.toContain(leak)
    }
    await expect(fetchPackFromSwarm(swarm, uploads[1].reference)).rejects.toThrow(/repository key is required/)
    const fetched = await fetchPackFromSwarm<RepositoryManifest>(swarm, uploads[1].reference, repoKey)
    expect(fetched.encrypted).toBe(true)
    expect(fetched.repoId).toBe(arkivId)
    expect(sha256(fetched.packBytes)).toBe(fetched.manifest.bundleHash)

    // Arkiv: one push entity under the opaque id; clear fields carry nothing identifying
    expect(calls.names).toEqual([])
    expect(calls.manifests).toEqual([])
    expect(calls.activity.length).toBe(1)
    const act = calls.activity[0]!
    expect(act.repoId).toBe(arkivId)
    expect(act.kind).toBe('push')
    expect(act.ref).toBeUndefined()
    expect(act.title).toBeUndefined()
    expect(JSON.stringify(act)).not.toContain('topsecret')
    expect(isPrivateBody(act.body)).toBe(true)
    const opened = openPrivateBody<{ repo: { name: string; owner: string }; commits: Array<{ subject: string }>; swarmManifestRef: string }>(act.body as never, repoKey, arkivId)
    expect(opened.repo).toMatchObject({ name: 'topsecret-project', owner: 'carol' })
    expect(opened.commits[0]!.subject).toBe('confidential plan')
    expect(opened.swarmManifestRef).toBe(uploads[1].reference)
    expect(() => openPrivateBody(act.body as never, new Uint8Array(32), arkivId)).toThrow()

    const ca = (await sql`SELECT status, arkiv_entity, l1_tx FROM commit_anchors WHERE push_id = ${s.pushId}`)[0]
    expect(ca.status).toBe('done_private')
    expect(ca.arkiv_entity).toBeTruthy()
    expect(ca.l1_tx).toBeTruthy()

    // the name claim of a private repo never reaches Arkiv
    await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('repo', ${s.repoNum}, 'name_claim', ${json({ repoId: `0x${s.repoHex}`, name: 'carol/topsecret-project' })})`

    // the queued grant job publishes the server's and the member's grant; the member can open it
    while (await tick(sql, worker.handlers)) { /* drain */ }
    expect(calls.names).toEqual([])
    expect(calls.grants.length).toBe(2)
    expect(calls.grants.every((g) => g.repo === arkivId && g.epoch === 0)).toBe(true)
    const mine = calls.grants.find((g) => g.recipient === member.publicKey)!
    expect(Buffer.from(openRepoKey(mine.sealed, member.privateKey, grantContext(arkivId, 0))).equals(Buffer.from(repoKey))).toBe(true)
    expect((await sql`SELECT count(*) AS c FROM arkiv_entities WHERE schema = 'dheet-grant-v1' AND repo_id = ${s.repoNum}`)[0].c).toBe(2)

    // a second push reuses the epoch-0 key
    const [p2] = await sql`INSERT INTO pushes (repo_id, ref_name, new_oid) VALUES (${s.repoNum}, 'refs/heads/main', ${Buffer.from(s.head, 'hex')}) RETURNING id`
    await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('push', ${p2.id}, 'push', ${json({ pushId: Number(p2.id) })})`
    await tick(sql, worker.handlers)
    expect((await sql`SELECT count(*) AS c FROM repo_keys WHERE repo_id = ${s.repoNum}`)[0].c).toBe(1)
    expect(calls.activity.length).toBe(2)
    expect(calls.activity[1]!.seq).toBe(2)
  })

  test('without DITHUB_DEVICE_KEY private pushes stay local', async () => {
    const s = await seedPush({ login: 'dave', name: 'priv2', visibility: 'private', subject: 'x', file: 'x.txt' })
    const { worker, calls, anchors } = setup({ deviceKey: '' })
    await tick(sql, worker.handlers)
    expect(anchors.length).toBe(0)
    expect(calls.activity.length).toBe(0)
    expect((await sql`SELECT status FROM commit_anchors WHERE push_id = ${s.pushId}`)[0].status).toBe('done_private')
  })
})

describe('key jobs', () => {
  test('device_key looks up the primary wallet and records the entity once', async () => {
    const [u] = await sql`SELECT id FROM users WHERE login = 'alice'`
    const [job] = await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('user', ${u.id}, 'device_key',
      ${json({ userId: Number(u.id), publicKey: member.publicKey, signature: `0x${'00'.repeat(65)}` })}) RETURNING id`
    const { worker, calls } = setup()
    await tick(sql, worker.handlers)
    expect(calls.deviceKeys).toEqual([{ wallet: `0x${'33'.repeat(20)}`, publicKey: member.publicKey, signature: `0x${'00'.repeat(65)}` }])
    await worker.handlers.device_key!({ id: Number(job.id), kind: 'device_key', payload: {}, aggregate_id: 0, attempts: 2 })
    expect(calls.deviceKeys.length).toBe(1)
  })
})

describe('deployments mirror', () => {
  test('writes the reserved "commit" column and mirrors release + attestation once', async () => {
    const records: ActivityInput[] = []
    const h = deploymentHandlers({ sql, relayer: `0x${'22'.repeat(20)}`, network: networkOf('base'),
      record: async (i) => { records.push(i); return { entityKey: fakeHash(), txHash: fakeHash(), expiresAt: 5n } } })
    const commit = sha256('c1'), bundleHash = sha256('b1'), tx = fakeHash()
    const ev = { id: 3n, commit, bundleHash, url: 'https://x.example', publisher: `0x${'44'.repeat(20)}` as Hex, publishedAt: new Date(), txHash: tx }
    await h.release(ev)
    expect(await h.release(ev)).toBeNull()
    await h.attest({ releaseId: 3n, bundleHash, ok: true, observedAt: 1_700_000_000n, logIndex: 0, txHash: fakeHash() })
    const [row] = await sql`SELECT lower(hex("commit")) AS c, attested, attested_ok, attested_at FROM deployments WHERE chain_id = 8453 AND id = 3`
    expect(`0x${row.c}`).toBe(commit)
    expect(row.attested).toBe(1)
    expect(row.attested_ok).toBe(1)
    expect(row.attested_at).toBe(new Date(1_700_000_000_000).toISOString())
    expect(records.map((r) => r.kind)).toEqual(['deploy', 'attest'])
    await h.saveCursor('deploy-registry', 100n)
    await h.saveCursor('deploy-registry', 50n)
    expect(await h.cursor('deploy-registry', 0n)).toBe(101n)
  })
})
