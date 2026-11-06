// Outbox job handlers: push -> L1 anchor + Arkiv activity + Swarm pack, name claims, RBAC events, device keys and key grants.
// Every external effect goes through `WorkerDeps` so the whole path runs in tests against a temp SQLite file and a mock Bee.
import type { SQL } from 'bun'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  devicePublicKey, grantContext, openRepoKey, padOid, planRotation, privateRepoArkivId, publishPackToSwarm, publishRepository,
  reconstructBundle, sha256,
  type ActivityInput, type ArkivUploadResult, type Grant, type Hex, type LocalNetworkStore, type RefAnchorResult,
  type RepositoryManifest, type SwarmClient, type SwarmPackRefs,
} from '../../../packages/sdk/src/index.ts'
import { now, parseJson, bool, json } from '../../../packages/db/src/index.ts'
import { sealPrivateBody } from '../../../packages/indexer/src/private-body.ts'

export interface EntityResult { entityKey: string; txHash: string; expiresAt: bigint }

/** The Arkiv writes the worker makes, all from the relayer wallet. */
export interface WorkerArkiv {
  relayer: Hex
  recordActivity(input: ActivityInput): Promise<EntityResult>
  claimName(name: string, repoId: Hex): Promise<EntityResult>
  uploadManifest(args: { manifest: RepositoryManifest; skipChunks: ReadonlySet<string>; swarm?: SwarmPackRefs; uploadChunks: boolean }): Promise<ArkivUploadResult>
  publishDeviceKey(input: { wallet: string; publicKey: Hex; signature: Hex }): Promise<EntityResult>
  publishGrant(grant: Grant): Promise<EntityResult>
  head(): Promise<bigint>
  renew(entityKeys: Hex[]): Promise<Array<{ entityKey: string; expiresAt: bigint }>>
}

export type Anchor = (args: { refRegistry: Hex; refName: string; gitOid: string; manifestRoot: Hex }) => Promise<RefAnchorResult>

export interface WorkerDeps {
  sql: SQL
  arkiv: WorkerArkiv
  anchor: Anchor
  store: LocalNetworkStore
  reposDir: string
  l1ChainId: number
  defaultRegistry?: Hex | undefined
  publishCode: boolean
  codeMaxBytes: number
  swarmMaxBytes: number
  maxCommits: number
  swarm: SwarmClient | null
  swarmPin?: boolean
  /** DITHUB_DEVICE_KEY: the server's X25519 private key (hex). Empty: private pushes are kept local only. */
  deviceKey: string
  /** secret for privateRepoArkivId; must equal the API's (apps/api/src/keys.ts: '0x' + DITHUB_DEVICE_KEY, lowercase) */
  privateIdSecret: string
  log?: (msg: string) => void
}

export interface Job { id: number; kind: string; payload: unknown; aggregate_id: number; attempts: number }

const hexBuf = (v: string) => Buffer.from(v.replace(/^0x/i, ''), 'hex')
const toHex = (b: Uint8Array | null | undefined) => (b ? (`0x${Buffer.from(b).toString('hex')}` as Hex) : null)

function dirSize(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

export function createWorker(deps: WorkerDeps) {
  const { sql, arkiv, store } = deps
  const log = deps.log ?? ((m: string) => console.log(m))
  const once = new Set<string>()
  const logOnce = (key: string, msg: string) => { if (!once.has(key)) { once.add(key); log(msg) } }

  async function trackEntity(schema: string, r: { entityKey: string; txHash: string; expiresAt: bigint }, repoId: number | null, outboxId: number | null) {
    await sql`INSERT INTO arkiv_entities (entity_key, schema, repo_id, outbox_id, tx_hash, expires_at_block)
      VALUES (${hexBuf(r.entityKey)}, ${schema}, ${repoId}, ${outboxId}, ${hexBuf(r.txHash)}, ${Number(r.expiresAt)})
      ON CONFLICT (entity_key) DO NOTHING`
  }

  const activityCount = async (repoNum: number) =>
    Number((await sql`SELECT count(*) AS n FROM arkiv_entities WHERE repo_id = ${repoNum} AND schema = 'dheet-activity-v1'`)[0]?.n ?? 0)

  async function swarmUpload(repoNum: number, pushId: number, repoId: Hex, manifest: RepositoryManifest, packBytes: Uint8Array,
    encryptWith?: { key: Uint8Array; keyEpoch: number }): Promise<SwarmPackRefs> {
    const refs = await publishPackToSwarm(deps.swarm!, { repoId, packBytes, manifest, ...(encryptWith ? { encryptWith } : {}), pin: deps.swarmPin ?? false })
    const enc = encryptWith ? 1 : 0
    await sql`INSERT INTO swarm_uploads (repo_id, push_id, kind, reference, bytes, encrypted)
      VALUES (${repoNum}, ${pushId}, 'pack', ${refs.packRef}, ${packBytes.byteLength}, ${enc}), (${repoNum}, ${pushId}, 'manifest', ${refs.manifestRef}, NULL, ${enc})`
    log(`swarm: push ${pushId} pack ${refs.packRef.slice(0, 16)}.. manifest ${refs.manifestRef.slice(0, 16)}..${enc ? ' (encrypted)' : ''}`)
    return refs
  }

  /** Snapshot the bare repo into the worker's local store: returns the manifest and the pack (git bundle) bytes. */
  function snapshot(diskPath: string, storeId: Hex) {
    try { store.createRepo(storeId, storeId) } catch { /* already registered */ }
    const published = publishRepository(diskPath, storeId, store)
    return { published, packBytes: reconstructBundle(store, published.manifest) }
  }

  /**
   * Swarm first, once per push: the bytes must be durable before L1 and Arkiv (which can fail and retry) record pointers to them.
   * A retry reuses the refs already in swarm_uploads instead of uploading again.
   */
  async function swarmOnce(push: PushRow, storeId: Hex, encryptWith?: { key: Uint8Array; keyEpoch: number }) {
    if (!push.new_oid) return undefined
    if (!deps.swarm) { logOnce(encryptWith ? 'swarm-off-private' : 'swarm-off', 'swarm: BEE_URL not set, repo bytes are not mirrored to Swarm'); return undefined }
    const diskPath = `${deps.reposDir}/${push.repo_hex}.git`
    if (!existsSync(diskPath)) { log(`repo ${push.rid} has no bare repo at ${diskPath}, skipping Swarm upload`); return undefined }
    if (dirSize(diskPath) > deps.swarmMaxBytes) { log(`repo ${push.rid} is too large for Swarm, skipping pack upload`); return undefined }
    const snap = snapshot(diskPath, storeId)
    const done = await sql`SELECT kind, reference FROM swarm_uploads WHERE push_id = ${push.id}`
    const ref = (kind: string) => done.find((r: { kind: string }) => r.kind === kind)?.reference as string | undefined
    const packRef = ref('pack'), manifestRef = ref('manifest')
    const refs = packRef && manifestRef ? { packRef, manifestRef } : await swarmUpload(push.rid, push.id, storeId, snap.published.manifest, snap.packBytes, encryptWith)
    return { refs, snap }
  }

  async function resolveRegistry(push: { owner_kind: string; owner_id: number }) {
    let registry = deps.defaultRegistry
    if (push.owner_kind === 'org') {
      // An org registry only counts on the chain it was created for (orgs made on Sepolia keep the default on Base).
      const [org] = await sql`SELECT ref_registry FROM orgs WHERE id = ${push.owner_id} AND chain_id = ${deps.l1ChainId}`
      if (org?.ref_registry) registry = toHex(org.ref_registry)!
    }
    return registry
  }

  /** One L1 transaction per ref update (not per commit). Returns the tx hash (null when nothing was sent). */
  async function anchorPush(push: PushRow, refName: string, gitOid: string, manifestRoot: Hex, registry: Hex | undefined): Promise<Hex | null> {
    const [done] = await sql`SELECT l1_tx FROM commit_anchors WHERE push_id = ${push.id} AND l1_tx IS NOT NULL LIMIT 1`
    if (done?.l1_tx) return toHex(done.l1_tx)
    if (!registry || !push.new_oid) return null
    const res = await deps.anchor({ refRegistry: registry, refName, gitOid, manifestRoot })
    const l1Tx = res.transactionHash
    if (l1Tx) await sql`INSERT INTO chain_anchors (repo_id, ref_name, chain_id, contract, tx_hash, ref_sequence, ref_root, writer)
      VALUES (${push.rid}, ${push.ref_name}, ${deps.l1ChainId}, ${hexBuf(registry)}, ${hexBuf(l1Tx)}, ${Number(res.sequence)}, ${hexBuf(res.refRoot)}, ${hexBuf(arkiv.relayer)})`
    await sql`UPDATE commit_anchors SET l1_chain_id = ${deps.l1ChainId}, l1_tx = ${l1Tx ? hexBuf(l1Tx) : null}, ref_sequence = ${Number(res.sequence)}
      WHERE push_id = ${push.id}`
    return l1Tx
  }

  interface PushRow {
    id: number; rid: number; ref_name: string; old_oid: Uint8Array | null; new_oid: Uint8Array | null; forced: number; manifest_hash: Uint8Array | null
    name: string; owner_kind: string; owner_id: number; visibility: string; default_branch: string; repo_hex: string; owner_login: string | null
  }

  async function loadPush(pushId: number): Promise<PushRow | null> {
    const [p] = await sql`SELECT p.id, p.ref_name, p.old_oid, p.new_oid, p.forced, p.manifest_hash, r.id AS rid, r.name, r.owner_kind, r.owner_id,
        r.visibility, r.default_branch, lower(hex(r.dheet_repo_id)) AS repo_hex,
        CASE r.owner_kind WHEN 'org' THEN (SELECT login FROM orgs WHERE id = r.owner_id) ELSE (SELECT login FROM users WHERE id = r.owner_id) END AS owner_login
      FROM pushes p JOIN repos r ON r.id = p.repo_id WHERE p.id = ${pushId}`
    return p ? { ...p, id: Number(p.id), rid: Number(p.rid), owner_id: Number(p.owner_id) } as PushRow : null
  }

  async function handlePush(job: Job) {
    const payload = job.payload as { pushId: number; repoId?: string }
    const push = await loadPush(Number(payload.pushId))
    if (!push) return
    if (push.visibility !== 'public') return handlePrivatePush(job, push)
    const repoId = `0x${push.repo_hex}` as Hex
    const anchors = await sql`SELECT a.commit_oid, a.arkiv_entity, c.subject FROM commit_anchors a
      JOIN commits c ON c.repo_id = a.repo_id AND c.oid = a.commit_oid
      WHERE a.push_id = ${push.id} ORDER BY c.committed_at ASC LIMIT ${deps.maxCommits}`

    // 0. Swarm (see swarmOnce). 1. L1 anchor
    const sw = await swarmOnce(push, repoId)
    const manifestRoot = sha256(anchors.map((a: { commit_oid: Uint8Array }) => toHex(a.commit_oid)).join(','))
    const l1Tx = await anchorPush(push, `${repoId}:${push.ref_name}`, push.new_oid ? toHex(push.new_oid)!.slice(2) : '', manifestRoot, await resolveRegistry(push))

    // 2. One Arkiv activity entity per commit, each carrying the L1 transaction hash.
    let seq = await activityCount(push.rid)
    for (const a of anchors) {
      if (a.arkiv_entity) continue
      const oid = toHex(a.commit_oid)!
      const r = await arkiv.recordActivity({
        kind: 'commit', repoId, seq: ++seq, actor: arkiv.relayer, ref: push.ref_name, commitOid: padOid(oid),
        title: a.subject, ...(l1Tx ? { l1ChainId: deps.l1ChainId, l1Tx } : {}), body: { oid, subject: a.subject, ref: push.ref_name, pushId: push.id },
      })
      await sql`UPDATE commit_anchors SET arkiv_tx = ${hexBuf(r.txHash)}, arkiv_entity = ${hexBuf(r.entityKey)},
        status = ${l1Tx ? 'anchored' : 'arkiv_done'} WHERE push_id = ${push.id} AND commit_oid = ${a.commit_oid}`
      await trackEntity('dheet-activity-v1', r, push.rid, job.id)
    }

    // 3. Code: the pack is on Swarm already (step 0); the manifest entity pointing at it goes to Arkiv (default branch only).
    if (push.manifest_hash || !push.new_oid) return
    const wantManifest = deps.publishCode && push.ref_name === `refs/heads/${push.default_branch}`
    if (!wantManifest && !sw) return
    const [already] = await sql`SELECT 1 AS x FROM arkiv_entities WHERE outbox_id = ${job.id} AND schema = 'dheet-manifest-v1'`
    if (already) return
    const diskPath = `${deps.reposDir}/${push.repo_hex}.git`
    if (!existsSync(diskPath)) { log(`repo ${repoId} has no bare repo at ${diskPath}, skipping code upload`); return }
    const chunksFit = dirSize(diskPath) <= deps.codeMaxBytes
    if (!chunksFit && !sw) { log(`repo ${repoId} is too large for Arkiv chunks and Swarm is off, skipping code upload`); return }
    const { published } = sw?.snap ?? snapshot(diskPath, repoId)
    const refs = sw?.refs
    let manifestEntity: string | undefined
    if (wantManifest) {
      const known = new Set<string>((await sql`SELECT lower(hex(chunk_hash)) AS h FROM arkiv_chunks WHERE repo_id = ${push.rid}`).map((r: { h: string }) => `0x${r.h}`))
      const up = await arkiv.uploadManifest({ manifest: published.manifest, skipChunks: known, ...(refs ? { swarm: refs } : {}), uploadChunks: chunksFit })
      for (const h of up.uploadedChunkHashes) await sql`INSERT INTO arkiv_chunks (repo_id, chunk_hash) VALUES (${push.rid}, ${hexBuf(h)}) ON CONFLICT DO NOTHING`
      await trackEntity('dheet-manifest-v1', { entityKey: up.manifestEntityKey, txHash: up.transactionHashes.at(-1)!, expiresAt: up.expiresAt }, push.rid, job.id)
      manifestEntity = up.manifestEntityKey
    }
    const r = await arkiv.recordActivity({
      kind: 'push', repoId, seq: ++seq, actor: arkiv.relayer, ref: push.ref_name, title: `push ${push.ref_name}`,
      manifestHash: published.manifestHash, ...(l1Tx ? { l1ChainId: deps.l1ChainId, l1Tx } : {}),
      body: { pushId: push.id, ...(manifestEntity ? { manifestEntity } : {}), ...(refs ? { swarmManifestRef: refs.manifestRef, swarmPackRef: refs.packRef } : {}) },
    })
    await trackEntity('dheet-activity-v1', r, push.rid, job.id)
    await sql`UPDATE pushes SET manifest_hash = ${hexBuf(published.manifestHash)} WHERE id = ${push.id}`
  }

  // ---------- private repos ----------

  const privateEnabled = () => !!deps.deviceKey && !!deps.privateIdSecret
  const arkivIdOf = (repoHex: string) => privateRepoArkivId(`0x${repoHex.toLowerCase()}`, deps.privateIdSecret.toLowerCase())
  /** Keyed hash so ref names / oids anchored on L1 for a private repo cannot be confirmed by guessing. */
  const blind = (label: string, arkivId: Hex, value: string) => sha256(`dithub-private-${label}:${deps.privateIdSecret}:${arkivId}:${value}`)

  /** Device keys of everyone who can read the repo (same set as apps/api/src/keys.ts repoMemberIds): owner, org owners, teams, collaborators. */
  async function memberKeys(repoNum: number) {
    const rows = await sql`SELECT DISTINCT lower(hex(public_key)) AS pk, user_id FROM device_keys WHERE user_id IN (
        SELECT owner_id FROM repos WHERE id = ${repoNum} AND owner_kind = 'user'
        UNION SELECT m.user_id FROM org_members m JOIN repos r ON r.owner_kind = 'org' AND r.owner_id = m.org_id WHERE r.id = ${repoNum} AND m.role = 'owner'
        UNION SELECT user_id FROM repo_collaborators WHERE repo_id = ${repoNum}
        UNION SELECT tm.user_id FROM team_members tm JOIN repo_team_access ta ON ta.team_id = tm.team_id WHERE ta.repo_id = ${repoNum})`
    return rows.map((r: { pk: string; user_id: number }) => ({ publicKey: `0x${r.pk}` as Hex, userId: String(r.user_id) }))
  }

  /**
   * Repo key of the latest epoch, opened with the server device key. A repo without one (created before keys existed, or the
   * API has not made one yet) gets epoch 0 here: sealed to the server in repo_keys, and a 'grant' outbox job for every member.
   */
  async function repoKey(repoNum: number, arkivId: Hex): Promise<{ key: Uint8Array; epoch: number }> {
    const [row] = await sql`SELECT epoch, sealed FROM repo_keys WHERE repo_id = ${repoNum} ORDER BY epoch DESC LIMIT 1`
    if (row) {
      const epoch = Number(row.epoch)
      return { epoch, key: openRepoKey(new Uint8Array(row.sealed), deps.deviceKey, grantContext(arkivId, epoch)) }
    }
    const plan = planRotation({ members: await memberKeys(repoNum), serverPublicKey: devicePublicKey(deps.deviceKey), epoch: 0, repo: arkivId })
    const created = await sql.begin(async (tx) => {
      const ins = await tx`INSERT INTO repo_keys (repo_id, epoch, sealed) VALUES (${repoNum}, 0, ${Buffer.from(plan.serverSealed)})
        ON CONFLICT (repo_id, epoch) DO NOTHING RETURNING epoch`
      if (!ins.length) return false
      const grants = plan.grants.map((g) => ({ repo: g.repo, epoch: g.epoch, recipient: g.recipient, sealed: toHex(g.sealed) }))
      await tx`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('repo', ${repoNum}, 'grant', ${json({ repoId: repoNum, grants })})`
      return true
    })
    if (!created) return repoKey(repoNum, arkivId)
    log(`private repo ${repoNum}: created key epoch 0 (${plan.grants.length} grants queued)`)
    return { epoch: 0, key: plan.repoKey }
  }

  async function handlePrivatePush(job: Job, push: PushRow) {
    if (!privateEnabled()) {
      logOnce('private-off', 'private repos: DITHUB_DEVICE_KEY not set, private pushes stay local (no Swarm, Arkiv or L1)')
      await sql`UPDATE commit_anchors SET status = 'done_private' WHERE push_id = ${push.id}`
      return
    }
    const arkivId = arkivIdOf(push.repo_hex)
    const { key, epoch } = await repoKey(push.rid, arkivId)
    const sw = await swarmOnce(push, arkivId, { key, keyEpoch: epoch })   // Swarm first: sealed with the repo key
    const anchors = await sql`SELECT a.commit_oid, a.arkiv_entity, c.subject FROM commit_anchors a
      JOIN commits c ON c.repo_id = a.repo_id AND c.oid = a.commit_oid
      WHERE a.push_id = ${push.id} ORDER BY c.committed_at ASC LIMIT ${deps.maxCommits}`
    const newOid = push.new_oid ? toHex(push.new_oid)! : null

    // 1. L1: opaque id + blinded ref name, oid and root. Always the shared default registry, so an org's registry does not tie it to the repo.
    const oids = anchors.map((a: { commit_oid: Uint8Array }) => toHex(a.commit_oid)!)
    const l1Tx = await anchorPush(push, `${arkivId}:${blind('ref', arkivId, push.ref_name)}`,
      newOid ? blind('oid', arkivId, newOid).slice(2) : '', blind('root', arkivId, oids.join(',')), deps.defaultRegistry)

    if (anchors.some((a: { arkiv_entity: unknown }) => a.arkiv_entity) || push.manifest_hash) return   // already mirrored

    // 2. Swarm: done first in swarmOnce (pack and manifest sealed with the repo key; the local store is keyed by the opaque id).
    const refs = sw?.refs
    const manifestHash: Hex | undefined = sw?.snap.published.manifestHash

    // 3. Arkiv: one activity entity per push. Clear fields carry only the opaque id, kind, seq and L1 tx; the rest is sealed.
    const body = sealPrivateBody({
      repo: { id: `0x${push.repo_hex}`, owner: push.owner_login, ownerKind: push.owner_kind, name: push.name },
      push: { id: push.id, ref: push.ref_name, oldOid: toHex(push.old_oid), newOid, forced: bool(push.forced) },
      commits: anchors.map((a: { commit_oid: Uint8Array; subject: string }) => ({ oid: toHex(a.commit_oid), subject: a.subject })),
      ...(refs ? { swarmManifestRef: refs.manifestRef, swarmPackRef: refs.packRef } : {}),
      ...(manifestHash ? { manifestHash } : {}),
    }, key, arkivId, epoch)
    const seq = (await activityCount(push.rid)) + 1
    const r = await arkiv.recordActivity({ kind: 'push', repoId: arkivId, seq, actor: arkiv.relayer, ...(l1Tx ? { l1ChainId: deps.l1ChainId, l1Tx } : {}), body })
    await trackEntity('dheet-activity-v1', r, push.rid, job.id)
    await sql`UPDATE commit_anchors SET status = 'done_private', arkiv_entity = ${hexBuf(r.entityKey)}, arkiv_tx = ${hexBuf(r.txHash)} WHERE push_id = ${push.id}`
    if (manifestHash) await sql`UPDATE pushes SET manifest_hash = ${hexBuf(manifestHash)} WHERE id = ${push.id}`
  }

  // ---------- other jobs ----------

  async function handleNameClaim(job: Job) {
    const p = job.payload as { repoId: string; name: string }
    const [claim] = await sql`SELECT n.arkiv_entity, r.visibility FROM name_claims n LEFT JOIN repos r ON r.dheet_repo_id = n.dheet_repo_id
      WHERE n.dheet_repo_id = ${hexBuf(p.repoId)} AND n.name = ${p.name}`
    if (!claim || claim.arkiv_entity) return   // renamed or deleted since the job was queued, or already claimed
    if (claim.visibility !== 'public') return   // private names never leave SQLite
    const r = await arkiv.claimName(p.name, p.repoId as Hex)
    await sql`UPDATE name_claims SET arkiv_entity = ${hexBuf(r.entityKey)} WHERE dheet_repo_id = ${hexBuf(p.repoId)} AND name = ${p.name}`
    await trackEntity('dheet-name-v1', r, job.aggregate_id, job.id)
  }

  /** Public-org RBAC change -> one Arkiv entity carrying the hash-chain link, so the log can be audited without trusting the server. */
  async function handleRbac(job: Job) {
    const p = job.payload as { eventId: number }
    const [ev] = await sql`SELECT e.*, o.login AS org_login FROM rbac_events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ${p.eventId}`
    if (!ev || !bool(ev.public) || ev.arkiv_entity) return
    const orgKey = sha256(`dheet:org:${ev.org_login}`)
    const r = await arkiv.recordActivity({
      kind: 'rbac', repoId: orgKey, seq: Number(ev.seq), actor: arkiv.relayer, ref: ev.actor_login, title: `${ev.action} (${ev.org_login})`,
      body: { org: ev.org_login, seq: Number(ev.seq), action: ev.action, actor: ev.actor_login, payload: parseJson(ev.payload),
        prevHash: toHex(ev.prev_hash), hash: toHex(ev.hash) },
    })
    await sql`UPDATE rbac_events SET arkiv_entity = ${hexBuf(r.entityKey)}, arkiv_tx = ${hexBuf(r.txHash)} WHERE id = ${ev.id}`
    await trackEntity('dheet-activity-v1', r, null, job.id)
  }

  /** payload: { userId?, wallet?, publicKey, signature }. The signature is re-verified by publishDeviceKey before anything is written. */
  async function handleDeviceKey(job: Job) {
    const p = job.payload as { userId?: number; wallet?: string; publicKey: Hex; signature: Hex }
    const [done] = await sql`SELECT 1 AS x FROM arkiv_entities WHERE outbox_id = ${job.id} AND schema = 'dheet-devicekey-v1'`
    if (done) return
    let wallet = p.wallet
    if (!wallet && p.userId !== undefined) {
      const [w] = await sql`SELECT lower(hex(address)) AS a FROM wallets WHERE user_id = ${p.userId} ORDER BY is_primary DESC, id LIMIT 1`
      if (w) wallet = `0x${w.a}`
    }
    if (!wallet) throw new Error('device_key job has no wallet')
    const r = await arkiv.publishDeviceKey({ wallet, publicKey: p.publicKey, signature: p.signature })
    await trackEntity('dheet-devicekey-v1', r, null, job.id)
  }

  /** payload: one grant { repo, epoch, recipient, sealed (hex) } or { repoId?, grants: [...] }. Resumes after the grants already written. */
  async function handleGrant(job: Job) {
    const p = job.payload as { repoId?: number; grants?: Array<{ repo: Hex; epoch: number; recipient: Hex; sealed: string }> } & Partial<{ repo: Hex; epoch: number; recipient: Hex; sealed: string }>
    const list = p.grants ?? [{ repo: p.repo!, epoch: p.epoch!, recipient: p.recipient!, sealed: p.sealed! }]
    const done = Number((await sql`SELECT count(*) AS n FROM arkiv_entities WHERE outbox_id = ${job.id} AND schema = 'dheet-grant-v1'`)[0]?.n ?? 0)
    for (const g of list.slice(done)) {
      if (!g.repo || !g.recipient || !g.sealed || !Number.isSafeInteger(Number(g.epoch))) throw new Error('malformed grant payload')
      const r = await arkiv.publishGrant({ repo: g.repo, epoch: Number(g.epoch), recipient: g.recipient, sealed: new Uint8Array(hexBuf(g.sealed)) })
      await trackEntity('dheet-grant-v1', r, p.repoId ?? null, job.id)
    }
  }

  const handlers: Record<string, (job: Job) => Promise<void>> = {
    push: handlePush, name_claim: handleNameClaim, rbac: handleRbac, device_key: handleDeviceKey, grant: handleGrant,
  }

  return { handlers, repoKey, arkivIdOf, memberKeys }
}

// ---------- outbox ----------

/** Claim the oldest due job. SQLite has no SKIP LOCKED: the claim is one UPDATE ... RETURNING inside a write transaction. */
export async function claimJob(sql: SQL): Promise<Job | null> {
  const rows = await sql.begin(async (tx) => tx`UPDATE outbox SET status = 'processing', attempts = attempts + 1
    WHERE id = (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= ${now()} ORDER BY id LIMIT 1)
    RETURNING id, kind, payload, aggregate_id, attempts`)
  const j = rows[0]
  if (!j) return null
  return { id: Number(j.id), kind: j.kind, payload: parseJson(j.payload), aggregate_id: Number(j.aggregate_id), attempts: Number(j.attempts) }
}

export async function completeJob(sql: SQL, id: number) {
  await sql`UPDATE outbox SET status = 'done', done_at = ${now()}, last_error = NULL WHERE id = ${id}`
}

export async function failJob(sql: SQL, job: Job, error: unknown) {
  const dead = job.attempts >= 8
  const delay = Math.min(3600, 2 ** job.attempts * 5)
  await sql`UPDATE outbox SET status = ${dead ? 'dead' : 'pending'}, last_error = ${String(error).slice(0, 500)},
    next_attempt_at = ${now(delay * 1000)} WHERE id = ${job.id}`
}

/** Jobs left 'processing' by a crash go back to the queue. */
export async function requeueStale(sql: SQL) {
  await sql`UPDATE outbox SET status = 'pending' WHERE status = 'processing'`
}

/** Run one job. `lock` serialises Arkiv writes with the deployments mirror. Returns false when the queue is empty. */
export async function tick(sql: SQL, handlers: Record<string, (job: Job) => Promise<void>>, lock: <T>(work: () => Promise<T>) => Promise<T> = (w) => w()): Promise<boolean> {
  const job = await claimJob(sql)
  if (!job) return false
  try {
    const run = handlers[job.kind]
    if (!run) throw new Error(`no handler for ${job.kind}`)
    await lock(() => run(job))
    await completeJob(sql, job.id)
    console.log(`outbox ${job.id} ${job.kind} done`)
  } catch (error) {
    await failJob(sql, job, error)
    console.error(`outbox ${job.id} ${job.kind} failed (attempt ${job.attempts}): ${error}`)
  }
  return true
}

/** Extend Arkiv entities with under ~30 days left. */
export async function renewal(sql: SQL, arkiv: Pick<WorkerArkiv, 'head' | 'renew'>, lock: <T>(work: () => Promise<T>) => Promise<T> = (w) => w()) {
  const horizon = (await arkiv.head()) + 1_296_000n
  const rows = await sql`SELECT lower(hex(entity_key)) AS k FROM arkiv_entities WHERE expires_at_block < ${Number(horizon)} ORDER BY expires_at_block LIMIT 20`
  if (rows.length === 0) return 0
  const results = await lock(() => arkiv.renew(rows.map((r: { k: string }) => `0x${r.k}` as Hex)))
  for (const r of results) await sql`UPDATE arkiv_entities SET expires_at_block = ${Number(r.expiresAt)}, last_extended_at = ${now()} WHERE entity_key = ${hexBuf(r.entityKey)}`
  console.log(`renewed ${results.length} Arkiv entities`)
  return results.length
}
