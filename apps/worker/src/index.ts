import { SQL } from 'bun'
import { withArkivLock } from './arkiv-lock.ts'
import { mkdirSync } from 'node:fs'
import {
  LocalNetworkStore, anchorRef, claimName, createArkivConnection, publishRepository, recordActivity,
  renewArkivEntities, sha256, uploadManifestToArkiv, padOid,
} from '../../../packages/sdk/src/index.ts'
import { startDeploymentMirror } from './deployments.ts'
import { startSnapshotWorker } from './snapshots.ts'

const env = process.env
const sql = new SQL(env.DATABASE_URL ?? '')
const REPOS_DIR = env.REPOS_DIR ?? `${process.cwd()}/.data/repos`
const WORK_DIR = env.WORKER_DIR ?? `${process.cwd()}/.data/worker`
const L1_RPC = env.L1_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const L1_CHAIN = Number(env.L1_CHAIN_ID ?? 11155111)
const DEFAULT_REF_REGISTRY = env.REF_REGISTRY as `0x${string}` | undefined
const PUBLISH_CODE = env.ARKIV_PUBLISH_CODE !== '0'
const CODE_MAX_BYTES = Number(env.ARKIV_CODE_MAX_BYTES ?? 2_000_000)
const MAX_COMMITS_PER_PUSH = Number(env.MAX_COMMITS_PER_PUSH ?? 50)

const key = env.DHEET_PRIVATE_KEY as `0x${string}` | undefined
if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('DHEET_PRIVATE_KEY (relayer) is required')
const arkiv = createArkivConnection({ privateKey: key, accessKey: env.ARKIV_ACCESS_KEY ?? '' })
const relayer = arkiv.account.address
const hexBuf = (v: string) => Buffer.from(v.replace(/^0x/, ''), 'hex')
const toHex = (b: Uint8Array | null | undefined) => (b ? (`0x${Buffer.from(b).toString('hex')}` as `0x${string}`) : null)
mkdirSync(WORK_DIR, { recursive: true })
const store = new LocalNetworkStore(`${WORK_DIR}/network`)

async function trackEntity(schema: string, entityKey: string, txHash: string, expiresAt: bigint, repoId: number | null, outboxId: number) {
  await sql`INSERT INTO arkiv_entities (entity_key, schema, repo_id, outbox_id, tx_hash, expires_at_block)
    VALUES (${hexBuf(entityKey)}, ${schema}, ${repoId}, ${outboxId}, ${hexBuf(txHash)}, ${expiresAt.toString()})
    ON CONFLICT (entity_key) DO NOTHING`
}

async function handleNameClaim(job: { id: number; payload: { repoId: string; name: string }; aggregate_id: number }) {
  const [claim] = await sql`SELECT arkiv_entity FROM name_claims WHERE dheet_repo_id = ${hexBuf(job.payload.repoId)}`
  if (claim?.arkiv_entity) return
  const r = await claimName(arkiv, job.payload.name, job.payload.repoId as `0x${string}`)
  await sql`UPDATE name_claims SET arkiv_entity = ${hexBuf(r.entityKey)} WHERE dheet_repo_id = ${hexBuf(job.payload.repoId)}`
  await trackEntity('dheet-name-v1', r.entityKey, r.txHash, r.expiresAt, job.aggregate_id, job.id)
}

async function handlePush(job: { id: number; payload: { pushId: number; repoId: string } }) {
  const [push] = await sql`SELECT p.*, r.id AS rid, r.name, r.owner_kind, r.owner_id, r.visibility FROM pushes p JOIN repos r ON r.id = p.repo_id WHERE p.id = ${job.payload.pushId}`
  if (!push) return
  const repoId = job.payload.repoId as `0x${string}`
  const repoNum = Number(push.rid)
  if (push.visibility !== 'public') {          // private repos: nothing is mirrored to the public ledger
    await sql`UPDATE commit_anchors SET status = 'done_private' WHERE push_id = ${push.id}`
    return
  }
  const anchors = await sql`SELECT a.commit_oid, a.status, a.arkiv_entity, c.subject FROM commit_anchors a
    JOIN commits c ON c.repo_id = a.repo_id AND c.oid = a.commit_oid
    WHERE a.push_id = ${push.id} ORDER BY c.committed_at ASC LIMIT ${MAX_COMMITS_PER_PUSH}`

  // 1. One L1 transaction per ref update (not per commit): cheap and authoritative.
  let l1Tx: `0x${string}` | null = null
  const [existing] = await sql`SELECT encode(tx_hash,'hex') AS tx FROM chain_anchors WHERE repo_id = ${repoNum} AND ref_name = ${push.ref_name}
    AND ref_root IS NOT NULL AND id IN (SELECT id FROM chain_anchors WHERE repo_id = ${repoNum}) ORDER BY id DESC LIMIT 1`
  void existing
  const [done] = await sql`SELECT l1_tx FROM commit_anchors WHERE push_id = ${push.id} AND l1_tx IS NOT NULL LIMIT 1`
  let registry = DEFAULT_REF_REGISTRY
  if (push.owner_kind === 'org') {
    const [org] = await sql`SELECT ref_registry FROM orgs WHERE id = ${push.owner_id}`
    if (org?.ref_registry) registry = toHex(org.ref_registry) as `0x${string}`
  }
  if (done?.l1_tx) l1Tx = toHex(done.l1_tx)
  else if (registry && push.new_oid) {
    const manifestRoot = sha256(anchors.map((a: { commit_oid: Buffer }) => toHex(a.commit_oid)).join(','))
    const res = await anchorRef({
      rpcUrl: L1_RPC, chainId: L1_CHAIN, privateKey: key!, refRegistry: registry,
      refName: `${repoId}:${push.ref_name}`, gitOid: toHex(push.new_oid)!.slice(2), manifestRoot, force: true,
    })
    l1Tx = res.transactionHash
    if (l1Tx) await sql`INSERT INTO chain_anchors (repo_id, ref_name, chain_id, contract, tx_hash, ref_sequence, ref_root, writer)
      VALUES (${repoNum}, ${push.ref_name}, ${L1_CHAIN}, ${hexBuf(registry)}, ${hexBuf(l1Tx)}, ${res.sequence.toString()}, ${hexBuf(res.refRoot)}, ${hexBuf(relayer)})`
    await sql`UPDATE commit_anchors SET l1_chain_id = ${L1_CHAIN}, l1_tx = ${l1Tx ? hexBuf(l1Tx) : null}, ref_sequence = ${res.sequence.toString()}
      WHERE push_id = ${push.id}`
  }

  // 2. One Arkiv activity entity per commit, each carrying the L1 transaction hash.
  let seq = Number((await sql`SELECT count(*) AS n FROM arkiv_entities WHERE repo_id = ${repoNum} AND schema = 'dheet-activity-v1'`)[0]?.n ?? 0)
  for (const a of anchors) {
    if (a.arkiv_entity) continue
    const oid = toHex(a.commit_oid)!
    const r = await recordActivity(arkiv, {
      kind: 'commit', repoId, seq: ++seq, actor: relayer, ref: push.ref_name, commitOid: padOid(oid),
      title: a.subject, ...(l1Tx ? { l1ChainId: L1_CHAIN, l1Tx } : {}), body: { oid, subject: a.subject, ref: push.ref_name, pushId: Number(push.id) },
    })
    await sql`UPDATE commit_anchors SET arkiv_tx = ${hexBuf(r.txHash)}, arkiv_entity = ${hexBuf(r.entityKey)},
      status = ${l1Tx ? 'anchored' : 'arkiv_done'} WHERE push_id = ${push.id} AND commit_oid = ${a.commit_oid}`
    await trackEntity('dheet-activity-v1', r.entityKey, r.txHash, r.expiresAt, repoNum, job.id)
  }

  // 3. Code on Arkiv: publish the repo's packfile manifest + chunks (small repos, default branch only).
  if (PUBLISH_CODE && !(env.SWARM_BEE_URL && env.SWARM_BATCH_ID && env.SWARM_READ_URL) && push.ref_name === `refs/heads/${(await sql`SELECT default_branch FROM repos WHERE id = ${repoNum}`)[0]?.default_branch}`) {
    const diskPath = `${REPOS_DIR}/${repoId.slice(2)}.git`
    const size = Number((await sql`SELECT coalesce(sum(1),0) AS n FROM commits WHERE repo_id = ${repoNum}`)[0]?.n ?? 0)
    void size
    const [already] = await sql`SELECT 1 FROM arkiv_entities WHERE outbox_id = ${job.id} AND schema = 'dheet-manifest-v1'`
    if (!already) {
      const proc = Bun.spawn(['du', '-sk', diskPath], { stdout: 'pipe' })
      const kb = Number((await new Response(proc.stdout).text()).split('\t')[0])
      if (kb * 1024 <= CODE_MAX_BYTES) {
        try { store.createRepo(`${repoId}`, repoId) } catch { /* already registered */ }
        const published = publishRepository(diskPath, repoId, store)
        const known = new Set<string>((await sql`SELECT encode(chunk_hash,'hex') AS h FROM arkiv_chunks WHERE repo_id = ${repoNum}`).map((r: { h: string }) => `0x${r.h}`))
        const up = await uploadManifestToArkiv({ manifest: published.manifest, localStore: store, connection: arkiv, skipChunks: known })
        for (const h of up.uploadedChunkHashes) await sql`INSERT INTO arkiv_chunks (repo_id, chunk_hash) VALUES (${repoNum}, ${hexBuf(h)}) ON CONFLICT DO NOTHING`
        await trackEntity('dheet-manifest-v1', up.manifestEntityKey, up.transactionHashes.at(-1)!, up.expiresAt, repoNum, job.id)
        await recordActivity(arkiv, { kind: 'push', repoId, seq: ++seq, actor: relayer, ref: push.ref_name, title: `push ${push.ref_name}`,
          manifestHash: published.manifestHash, ...(l1Tx ? { l1ChainId: L1_CHAIN, l1Tx } : {}), body: { manifestEntity: up.manifestEntityKey } })
      } else console.log(`repo ${repoId} is ${kb} KiB, skipping code upload to Arkiv`)
    }
  }
}

/** Public-org RBAC change -> one Arkiv entity carrying the hash-chain link, so the log can be audited without trusting Postgres. */
async function handleRbac(job: { id: number; payload: { eventId: number } }) {
  const [ev] = await sql`SELECT e.*, o.login AS org_login FROM rbac_events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ${job.payload.eventId}`
  if (!ev || !ev.public || ev.arkiv_entity) return
  const orgKey = sha256(`dheet:org:${ev.org_login}`)
  const r = await recordActivity(arkiv, {
    kind: 'rbac', repoId: orgKey, seq: Number(ev.seq), actor: relayer, ref: ev.actor_login, title: `${ev.action} (${ev.org_login})`,
    body: { org: ev.org_login, seq: Number(ev.seq), action: ev.action, actor: ev.actor_login, payload: typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload,
      prevHash: toHex(ev.prev_hash), hash: toHex(ev.hash) },
  })
  await sql`UPDATE rbac_events SET arkiv_entity = ${hexBuf(r.entityKey)}, arkiv_tx = ${hexBuf(r.txHash)} WHERE id = ${ev.id}`
  await trackEntity('dheet-activity-v1', r.entityKey, r.txHash, r.expiresAt, null, job.id)
}

const handlers: Record<string, (job: never) => Promise<void>> = {
  rbac: handleRbac as never,
  name_claim: handleNameClaim as never, push: handlePush as never,
}

async function tick(): Promise<boolean> {
  const jobs = await sql`UPDATE outbox SET status = 'processing', attempts = attempts + 1
    WHERE id IN (SELECT id FROM outbox WHERE status IN ('pending') AND next_attempt_at <= now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, payload, aggregate_id, attempts`
  const job = jobs[0]
  if (!job) return false
  try {
    const run = handlers[job.kind]
    if (!run) throw new Error(`no handler for ${job.kind}`)
    await withArkivLock(() => run({ ...job, id: Number(job.id), aggregate_id: Number(job.aggregate_id), payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload } as never))
    await sql`UPDATE outbox SET status = 'done', done_at = now(), last_error = NULL WHERE id = ${job.id}`
    console.log(`outbox ${job.id} ${job.kind} done`)
  } catch (error) {
    const attempts = Number(job.attempts)
    const dead = attempts >= 8
    const delay = Math.min(3600, 2 ** attempts * 5)
    await sql`UPDATE outbox SET status = ${dead ? 'dead' : 'pending'}, last_error = ${String(error).slice(0, 500)},
      next_attempt_at = now() + ${`${delay} seconds`}::interval WHERE id = ${job.id}`
    console.error(`outbox ${job.id} ${job.kind} failed (attempt ${attempts}): ${error}`)
  }
  return true
}

async function renewal() {
  const head = await arkiv.publicClient.getBlockNumber()
  const horizon = head + 1_296_000n          // renew when under ~30 days remain
  const rows = await sql`SELECT encode(entity_key,'hex') AS k, expires_at_block FROM arkiv_entities
    WHERE expires_at_block < ${horizon.toString()} ORDER BY expires_at_block LIMIT 20`
  if (rows.length === 0) return
  const results = await withArkivLock(() => renewArkivEntities({ entityKeys: rows.map((r: { k: string }) => `0x${r.k}` as `0x${string}`), connection: arkiv }))
  for (const r of results) await sql`UPDATE arkiv_entities SET expires_at_block = ${r.expiresAt.toString()}, last_extended_at = now() WHERE entity_key = ${hexBuf(r.entityKey)}`
  console.log(`renewed ${results.length} Arkiv entities`)
}

console.log(`dithub worker started, relayer ${relayer}`)
await sql`UPDATE outbox SET status = 'pending' WHERE status = 'processing'`   // crash recovery
startDeploymentMirror({ sql, arkiv, relayer })   // Sepolia DeployRegistry/Attestations -> Postgres + Arkiv (own loop)
startSnapshotWorker({ sql, arkiv, reposDir: REPOS_DIR, workDir: WORK_DIR })
let lastRenewal = 0
for (;;) {
  const worked = await tick().catch((e) => { console.error('tick error', e); return false })
  if (Date.now() - lastRenewal > 3_600_000) { lastRenewal = Date.now(); await renewal().catch((e) => console.error('renewal error', e)) }
  if (!worked) await Bun.sleep(2000)
}
