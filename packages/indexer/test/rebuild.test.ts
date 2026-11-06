// Round trip: the worker publishes to a capturing fake Arkiv (+ mock Bee), then the index is rebuilt from those entities
// into a fresh SQLite file and compared with the original.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SQL } from 'bun'
import { migrate, openDb, json } from '../../db/src/index.ts'
import {
  LocalNetworkStore, arkivManifestContent, canonicalJson, createSwarmClient, generateDeviceKey, isolatedGitEnvironment, sha256, ZERO_KEY, type Hex,
} from '../../sdk/src/index.ts'
import { startMockBee, type MockBee } from '../../sdk/src/testing/mock-bee.ts'
import { createWorker, tick, type WorkerArkiv } from '../../../apps/worker/src/jobs.ts'
import { rebuildIndex, type ActivityEntity, type ArkivSource, type GrantEntity, type ManifestEntity, type NameEntity } from '../src/rebuild.ts'

const root = mkdtempSync(join(tmpdir(), 'dithub-rebuild-'))
const reposDir = join(root, 'repos')
const server = generateDeviceKey()
const RELAYER = `0x${'22'.repeat(20)}` as Hex
let sql: SQL
let bee: MockBee
let n = 0
const h = () => sha256(`e${++n}`)

const names: NameEntity[] = [], activity: ActivityEntity[] = [], manifests: ManifestEntity[] = [], grants: GrantEntity[] = []
const source: ArkivSource = { names: () => names, activity: () => activity, manifests: () => manifests, grants: (r) => grants.filter((g) => g.recipient === r) }
let clock = 1_700_000_000
const res = (entityKey: string) => ({ entityKey, txHash: h(), expiresAt: 10n })

const arkiv: WorkerArkiv = {
  relayer: RELAYER,
  async recordActivity(i) {
    const e: ActivityEntity = { entityKey: h(), kind: i.kind, repo: i.repoId.toLowerCase() as Hex, seq: i.seq, actor: i.actor, ctime: ++clock, ref: i.ref ?? '',
      commitOid: i.commitOid ?? ZERO_KEY, title: i.title ?? '', l1ChainId: i.l1ChainId ?? 0, l1Tx: i.l1Tx ?? ZERO_KEY, manifestHash: i.manifestHash ?? ZERO_KEY,
      content: new TextEncoder().encode(JSON.stringify(i.body ?? {})) }
    activity.push(e); return res(e.entityKey)
  },
  async claimName(name, repo) { const e = { entityKey: h(), name, repo: repo.toLowerCase() as Hex, owner: RELAYER, ctime: ++clock }; names.push(e); return res(e.entityKey) },
  async uploadManifest(a) {
    const e = { entityKey: h(), repo: a.manifest.repoId.toLowerCase() as Hex, seq: a.manifest.sequence, oid: sha256(canonicalJson(a.manifest)), ctime: ++clock,
      content: arkivManifestContent(a.manifest, a.swarm) }
    manifests.push(e)
    return { manifestEntityKey: e.entityKey as `0x${string}`, transactionHashes: [h() as `0x${string}`], chunkEntities: 0, uploadedChunkHashes: [], expiresAt: 10n }
  },
  async publishDeviceKey() { return res(h()) },
  async publishGrant(g) { const e = { entityKey: h(), repo: g.repo.toLowerCase() as Hex, epoch: g.epoch, recipient: g.recipient.toLowerCase() as Hex, sealed: g.sealed, ctime: ++clock }; grants.push(e); return res(e.entityKey) },
  head: async () => 0n,
  renew: async () => [],
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, env: isolatedGitEnvironment(), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

async function seed(login: string, name: string, visibility: 'public' | 'private', subject: string) {
  const repoHex = sha256(`${login}/${name}`).slice(2)
  const work = join(root, `w-${login}`)
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main'); git(work, 'config', 'user.email', 'a@b.c'); git(work, 'config', 'user.name', 'A')
  writeFileSync(join(work, 'f.txt'), subject); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', subject)
  git(root, 'clone', '-q', '--bare', work, join(reposDir, `${repoHex}.git`))
  const head = Buffer.from(git(work, 'rev-parse', 'HEAD'), 'hex')
  const [u] = await sql`INSERT INTO users (login) VALUES (${login}) RETURNING id`
  const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name, visibility) VALUES (${Buffer.from(repoHex, 'hex')}, 'user', ${u.id}, ${name}, ${visibility}) RETURNING id`
  const [p] = await sql`INSERT INTO pushes (repo_id, ref_name, new_oid) VALUES (${r.id}, 'refs/heads/main', ${head}) RETURNING id`
  const t = new Date().toISOString()
  await sql`INSERT INTO commits (repo_id, oid, tree_oid, authored_at, committed_at, message, subject) VALUES (${r.id}, ${head}, ${head}, ${t}, ${t}, ${subject}, ${subject})`
  await sql`INSERT INTO commit_anchors (repo_id, commit_oid, push_id, ref_name) VALUES (${r.id}, ${head}, ${p.id}, 'refs/heads/main')`
  await sql`INSERT INTO name_claims (name, dheet_repo_id, claimant) VALUES (${`${login}/${name}`}, ${Buffer.from(repoHex, 'hex')}, ${Buffer.alloc(20)})`
  await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('repo', ${r.id}, 'name_claim', ${json({ repoId: `0x${repoHex}`, name: `${login}/${name}` })})`
  await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('push', ${p.id}, 'push', ${json({ pushId: Number(p.id) })})`
  return { repoHex, head: head.toString('hex') }
}

beforeAll(async () => {
  mkdirSync(reposDir, { recursive: true })
  sql = openDb(join(root, 'orig.sqlite'))
  await migrate(sql, { log: () => {} })
  bee = await startMockBee()
})
afterAll(async () => { bee.stop(); await sql.close(); rmSync(root, { recursive: true, force: true }) })

describe('rebuildIndex', () => {
  test('rebuilds public + private repos, commits, pushes, RBAC and deployments from Arkiv', async () => {
    const pub = await seed('alice', 'hello', 'public', 'first public commit')
    const priv = await seed('bob', 'vault', 'private', 'secret commit')
    const worker = createWorker({
      sql, arkiv, store: new LocalNetworkStore(join(root, 'store')), reposDir, l1ChainId: 8453, defaultRegistry: `0x${'11'.repeat(20)}`,
      anchor: async () => ({ transactionHash: h() as `0x${string}`, sequence: 1n, refRoot: h() as `0x${string}`, oid: h() as `0x${string}`, alreadyAnchored: false }),
      publishCode: true, codeMaxBytes: 2_000_000, swarmMaxBytes: 50_000_000, maxCommits: 50,
      swarm: createSwarmClient({ beeUrl: bee.url, postageBatchId: 'ab'.repeat(32) }), deviceKey: server.privateKey.slice(2), privateIdSecret: server.privateKey, log: () => {},
    })
    while (await tick(sql, worker.handlers)) { /* drain, including the queued grant job */ }
    expect((await sql`SELECT count(*) AS c FROM outbox WHERE status <> 'done'`)[0].c).toBe(0)
    expect(names.map((x) => x.name)).toEqual(['alice/hello'])   // the private name never left SQLite

    // extra entities the API/mirror would have produced
    const orgKey = sha256('dheet:org:acme')
    const ev = (seq: number, action: string, payload: object) => ({ entityKey: h(), kind: 'rbac', repo: orgKey, seq, actor: RELAYER, ctime: ++clock, ref: 'alice', commitOid: ZERO_KEY,
      title: action, l1ChainId: 0, l1Tx: ZERO_KEY, manifestHash: ZERO_KEY,
      content: new TextEncoder().encode(JSON.stringify({ org: 'acme', seq, action, actor: 'alice', payload, prevHash: seq ? sha256(`h${seq - 1}`) : null, hash: sha256(`h${seq}`) })) })
    activity.push(ev(0, 'org.create', { org: 'acme', visibility: 'public' }), ev(1, 'member.add', { user: 'carol', role: 'member' }))
    activity.push({ entityKey: h(), kind: 'deploy', repo: sha256('dheet:deployments:8453'), seq: 1, actor: RELAYER, ctime: ++clock, ref: 'https://x', commitOid: sha256('c'),
      title: 'release #1', l1ChainId: 8453, l1Tx: h(), manifestHash: sha256('b'),
      content: new TextEncoder().encode(JSON.stringify({ releaseId: 1, commit: sha256('c'), bundleHash: sha256('b'), url: 'https://x', publisher: RELAYER, publishedAt: new Date(0).toISOString() })) })
    activity.push({ entityKey: h(), kind: 'issue', repo: `0x${pub.repoHex}`, seq: 99, actor: RELAYER, ctime: ++clock, ref: '', commitOid: ZERO_KEY, title: 'bug', l1ChainId: 0,
      l1Tx: ZERO_KEY, manifestHash: ZERO_KEY, content: new TextEncoder().encode(JSON.stringify({ number: 1, title: 'bug', body: 'it breaks', author: 'alice' })) })

    const fresh = openDb(join(root, 'rebuilt.sqlite'))
    const stats = await rebuildIndex({ sql: fresh, source, deviceKey: server.privateKey, log: () => {} })
    expect(stats).toMatchObject({ repos: 1, privateRepos: 1, commits: 2, pushes: 2, rbacEvents: 2, deployments: 1, issues: 1 })

    const repos = await fresh`SELECT r.name, r.visibility, r.default_branch, u.login FROM repos r JOIN users u ON u.id = r.owner_id ORDER BY r.name`
    expect(repos).toEqual([
      { name: 'hello', visibility: 'public', default_branch: 'main', login: 'alice' },
      { name: 'vault', visibility: 'private', default_branch: 'main', login: 'bob' },
    ])
    const commits = await fresh`SELECT lower(hex(c.oid)) AS oid, c.subject, a.status FROM commits c JOIN commit_anchors a ON a.repo_id = c.repo_id AND a.commit_oid = c.oid ORDER BY c.subject`
    expect(commits).toEqual([
      { oid: pub.head, subject: 'first public commit', status: 'anchored' },
      { oid: priv.head, subject: 'secret commit', status: 'done_private' },
    ])
    const [ref] = await fresh`SELECT g.name, lower(hex(g.oid)) AS oid FROM git_refs g JOIN repos r ON r.id = g.repo_id WHERE r.name = 'hello'`
    expect(ref).toEqual({ name: 'refs/heads/main', oid: pub.head })
    expect((await fresh`SELECT count(*) AS c FROM swarm_uploads`)[0].c).toBe(4)

    // the server's repo key is restored and matches the original
    const [orig] = await sql`SELECT k.epoch, k.sealed FROM repo_keys k JOIN repos r ON r.id = k.repo_id WHERE r.name = 'vault'`
    const [back] = await fresh`SELECT k.epoch, k.sealed FROM repo_keys k JOIN repos r ON r.id = k.repo_id WHERE r.name = 'vault'`
    expect(Number(back.epoch)).toBe(Number(orig.epoch))
    expect(Buffer.from(back.sealed).equals(Buffer.from(orig.sealed))).toBe(true)

    const members: unknown = await fresh`SELECT o.login, u.login AS member, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id ORDER BY member`
    expect(members).toEqual([{ login: 'acme', member: 'alice', role: 'owner' }, { login: 'acme', member: 'carol', role: 'member' }])
    expect((await fresh`SELECT rbac_seq FROM orgs WHERE login = 'acme'`)[0].rbac_seq).toBe(2)
    expect((await fresh`SELECT url, lower(hex("commit")) AS c FROM deployments WHERE chain_id = 8453 AND id = 1`)[0]).toEqual({ url: 'https://x', c: sha256('c').slice(2) })
    expect((await fresh`SELECT title, body FROM issues`)[0]).toEqual({ title: 'bug', body: 'it breaks' })

    // without the server key the private repo is not recoverable; a non-empty database is refused
    await expect(rebuildIndex({ sql: fresh, source, log: () => {} })).rejects.toThrow(/not empty/)
    const nokey = openDb(join(root, 'nokey.sqlite'))
    expect((await rebuildIndex({ sql: nokey, source, log: () => {} })).privateRepos).toBe(0)
    await fresh.close(); await nokey.close()
  })
})
