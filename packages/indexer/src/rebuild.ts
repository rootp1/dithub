#!/usr/bin/env bun
// Rebuild the SQLite read index from Arkiv into an empty DATABASE_PATH.
//
//   DATABASE_PATH=.data/dithub.sqlite ARKIV_RELAYER=0x... [DITHUB_DEVICE_KEY=..] bun packages/indexer/src/rebuild.ts
//
// Rebuilt: users/orgs (logins from name claims and the RBAC log), public repos and their name claims, commits, pushes,
// commit anchors (L1 tx + Arkiv entity), the activity feed, the latest refs + default branch from manifest entities,
// Swarm references, public-org RBAC events (and org/team membership replayed from them), deployments + attestations,
// issues/PRs/comments that were mirrored as activity. With DITHUB_DEVICE_KEY: private repos too, by opening the server's
// grants (dheet-grant-v1) and decrypting their push bodies; repo_keys gets the server's sealed key per epoch.
//
// Not rebuildable (never leaves the server): PATs (access_tokens), SIWE nonces, CLI device codes, wallets and user
// profiles, sessions (stateless anyway), webhooks and their secrets, task sessions, assistant calls, notifications,
// audit log, stars/watches, the outbox. Device keys are on Arkiv but keyed by wallet, which cannot be linked back to a
// login, so device_keys stays empty until users re-register. Without DITHUB_DEVICE_KEY private repos and their keys
// are lost (their names were only ever in SQLite). Commit rows carry only oid + subject; tree/author/message come from git.
import type { SQL } from 'bun'
import { and, asc, eq } from '@arkiv-network/sdk/query'
import { key } from '@arkiv-network/sdk/schema'
import type { Hex as ViemHex } from 'viem'
import {
  ArkivActivitySchema, ArkivGrantSchema, ArkivManifestSchema, ArkivNameSchema, createArkivConnection, devicePublicKey, grantContext,
  openRepoKey, parseArkivManifestContent, type Hex,
} from '../../sdk/src/index.ts'
import { migrate, openDb, json } from '../../db/src/index.ts'
import { isPrivateBody, openPrivateBody } from './private-body.ts'

export interface NameEntity { entityKey: string; name: string; repo: Hex; owner: Hex; ctime: number }
export interface ActivityEntity {
  entityKey: string; kind: string; repo: Hex; seq: number; actor: Hex; ctime: number; ref: string; commitOid: Hex; title: string
  l1ChainId: number; l1Tx: Hex; manifestHash: Hex; content: Uint8Array
}
export interface ManifestEntity { entityKey: string; repo: Hex; seq: number; oid: Hex; ctime: number; content: Uint8Array }
export interface GrantEntity { entityKey: string; repo: Hex; epoch: number; recipient: Hex; sealed: Uint8Array; ctime: number }

/** Everything the rebuild reads from Arkiv. `arkivSource` is the real one; tests pass arrays. */
export interface ArkivSource {
  names(): AsyncIterable<NameEntity> | Iterable<NameEntity>
  activity(): AsyncIterable<ActivityEntity> | Iterable<ActivityEntity>
  manifests(): AsyncIterable<ManifestEntity> | Iterable<ManifestEntity>
  grants(recipient: Hex): AsyncIterable<GrantEntity> | Iterable<GrantEntity>
}

const ZERO = /^0x0*$/
const lc = (v: unknown) => String(v ?? '').toLowerCase() as Hex
const buf = (v: string) => Buffer.from(v.replace(/^0x/i, ''), 'hex')
const iso = (sec: number) => new Date(sec * 1000).toISOString()
function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string') return new Uint8Array(buf(v))
  if (v && typeof v === 'object' && 'value' in v) return bytesOf((v as { value: unknown }).value)
  return new Uint8Array()
}

/** Pages through every entity of a schema created by the relayer (Arkiv caps a page at 100). */
async function* pages<T>(fetchPage: (offset: number) => Promise<{ entities: readonly unknown[]; skipped: number }>): AsyncGenerator<T> {
  for (let offset = 0; ;) {
    const page = await fetchPage(offset)
    for (const e of page.entities) yield e as T
    const covered = page.entities.length + page.skipped
    if (covered < 100) return
    offset += covered
  }
}

export function arkivSource(conn: ReturnType<typeof createArkivConnection>, relayer: Hex): ArkivSource {
  const c = conn.publicClient
  const by = relayer as ViemHex
  return {
    async *names() {
      for await (const e of pages<Record<string, unknown>>((o) => c.select({ $key: true, name: true, repo: true, owner: true, ctime: true })
        .from(ArkivNameSchema, { onMismatch: 'skip' }).createdBy(by).orderBy(asc('$key')).limit(100).offset(o).fetch()))
        yield { entityKey: lc(e.$key), name: String(e.name), repo: lc(e.repo), owner: lc(e.owner), ctime: Number(e.ctime) }
    },
    async *activity() {
      for await (const e of pages<Record<string, unknown>>((o) => c.select({ $key: true, kind: true, repo: true, seq: true, actor: true, ctime: true, ref: true,
        commitOid: true, title: true, l1ChainId: true, l1Tx: true, manifestHash: true, content: true })
        .from(ArkivActivitySchema, { onMismatch: 'skip' }).createdBy(by).orderBy(asc('$key')).limit(100).offset(o).fetch()))
        yield {
          entityKey: lc(e.$key), kind: String(e.kind), repo: lc(e.repo), seq: Number(e.seq), actor: lc(e.actor), ctime: Number(e.ctime), ref: String(e.ref ?? ''),
          commitOid: lc(e.commitOid), title: String(e.title ?? ''), l1ChainId: Number(e.l1ChainId ?? 0), l1Tx: lc(e.l1Tx), manifestHash: lc(e.manifestHash),
          content: bytesOf(e.content),
        }
    },
    async *manifests() {
      for await (const e of pages<Record<string, unknown>>((o) => c.select({ $key: true, repo: true, seq: true, oid: true, ctime: true, content: true })
        .from(ArkivManifestSchema, { onMismatch: 'skip' }).createdBy(by).orderBy(asc('$key')).limit(100).offset(o).fetch()))
        yield { entityKey: lc(e.$key), repo: lc(e.repo), seq: Number(e.seq), oid: lc(e.oid), ctime: Number(e.ctime), content: bytesOf(e.content) }
    },
    async *grants(recipient: Hex) {
      for await (const e of pages<Record<string, unknown>>((o) => c.select({ $key: true, repo: true, epoch: true, recipient: true, sealed: true, ctime: true })
        .from(ArkivGrantSchema, { onMismatch: 'skip' }).where(and(eq('recipient', key(recipient.toLowerCase() as ViemHex)))).createdBy(by)
        .orderBy(asc('$key')).limit(100).offset(o).fetch()))
        yield { entityKey: lc(e.$key), repo: lc(e.repo), epoch: Number(e.epoch), recipient: lc(e.recipient), sealed: bytesOf(e.sealed), ctime: Number(e.ctime) }
    },
  }
}

async function collect<T>(it: AsyncIterable<T> | Iterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const bodyOf = (e: ActivityEntity): Record<string, unknown> => {
  try { return JSON.parse(new TextDecoder().decode(e.content)) as Record<string, unknown> } catch { return {} }
}

export interface RebuildStats {
  users: number; orgs: number; repos: number; privateRepos: number; commits: number; pushes: number; rbacEvents: number
  deployments: number; issues: number; skipped: number
}

/**
 * Fill an empty, migrated database from Arkiv. `deviceKey` (server X25519 private key) unlocks private repos; `privateIdSecret`
 * is not needed because private activity is matched by the opaque repo ids in the server's grants.
 */
export async function rebuildIndex(args: { sql: SQL; source: ArkivSource; deviceKey?: string; force?: boolean; log?: (m: string) => void }): Promise<RebuildStats> {
  const { sql, source } = args
  const log = args.log ?? ((m: string) => console.log(m))
  await migrate(sql, { log: () => {} })
  const [existing] = await sql`SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM repos) + (SELECT count(*) FROM orgs) AS n`
  if (Number(existing.n) > 0 && !args.force) throw new Error('database is not empty; rebuild only into an empty DATABASE_PATH')
  const stats: RebuildStats = { users: 0, orgs: 0, repos: 0, privateRepos: 0, commits: 0, pushes: 0, rbacEvents: 0, deployments: 0, issues: 0, skipped: 0 }

  const [names, activity, manifests] = await Promise.all([collect(source.names()), collect(source.activity()), collect(source.manifests())])
  activity.sort((a, b) => a.ctime - b.ctime || a.seq - b.seq)
  const byRepo = new Map<string, ActivityEntity[]>()
  for (const a of activity) byRepo.set(a.repo, [...(byRepo.get(a.repo) ?? []), a])

  // ---- owners ----
  const orgLogins = new Set<string>()
  for (const a of activity) if (a.kind === 'rbac') { const o = bodyOf(a).org; if (typeof o === 'string') orgLogins.add(o.toLowerCase()) }
  const userIds = new Map<string, number>()
  const orgIds = new Map<string, number>()
  async function userId(login: string): Promise<number> {
    const k = login.toLowerCase()
    let id = userIds.get(k)
    if (id === undefined) {
      const [r] = await sql`INSERT INTO users (login) VALUES (${login}) ON CONFLICT (login) DO UPDATE SET login = users.login RETURNING id`
      id = Number(r.id); userIds.set(k, id); stats.users++
    }
    return id
  }
  async function orgId(login: string): Promise<number> {
    const k = login.toLowerCase()
    let id = orgIds.get(k)
    if (id === undefined) {
      const [r] = await sql`INSERT INTO orgs (login) VALUES (${login}) ON CONFLICT (login) DO UPDATE SET login = orgs.login RETURNING id`
      id = Number(r.id); orgIds.set(k, id); stats.orgs++
    }
    return id
  }
  const owner = async (login: string) => orgLogins.has(login.toLowerCase())
    ? { kind: 'org' as const, id: await orgId(login) } : { kind: 'user' as const, id: await userId(login) }

  // ---- RBAC log (public orgs) + membership replay ----
  for (const [orgKey, list] of byRepo) {
    const events = list.filter((a) => a.kind === 'rbac').sort((a, b) => a.seq - b.seq)
    if (!events.length) continue
    let org: number | null = null
    let head: Buffer | null = null, seq = 0
    for (const a of events) {
      const b = bodyOf(a) as { org?: string; seq?: number; action?: string; actor?: string; payload?: Record<string, unknown>; prevHash?: string | null; hash?: string }
      if (!b.org || !b.hash || !b.action) { stats.skipped++; continue }
      org ??= await orgId(b.org)
      const actor = String(b.actor ?? '')
      const actorId = actor ? await userId(actor) : null
      await sql`INSERT INTO rbac_events (org_id, seq, actor_id, actor_login, action, payload, prev_hash, hash, public, arkiv_entity, created_at)
        VALUES (${org}, ${Number(b.seq ?? a.seq)}, ${actorId}, ${actor}, ${b.action}, ${json(b.payload ?? {})}, ${b.prevHash ? buf(b.prevHash) : null},
                ${buf(b.hash)}, 1, ${buf(a.entityKey)}, ${iso(a.ctime)}) ON CONFLICT (org_id, seq) DO NOTHING`
      head = buf(b.hash); seq = Number(b.seq ?? a.seq) + 1; stats.rbacEvents++
      await replayRbac(org, b.action, b.payload ?? {}, actorId)
    }
    if (org !== null) await sql`UPDATE orgs SET rbac_head = ${head}, rbac_seq = ${seq} WHERE id = ${org}`
    void orgKey
  }

  async function replayRbac(org: number, action: string, p: Record<string, unknown>, actorId: number | null) {
    const user = typeof p.user === 'string' ? await userId(p.user) : null
    if (action === 'org.create') {
      if (p.visibility === 'private' || p.visibility === 'public') await sql`UPDATE orgs SET visibility = ${p.visibility} WHERE id = ${org}`
      if (actorId !== null) await sql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, ${actorId}, 'owner') ON CONFLICT DO NOTHING`
    } else if ((action === 'member.add' || action === 'member.role') && user !== null) {
      const role = p.role === 'owner' ? 'owner' : 'member'
      await sql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, ${user}, ${role}) ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role`
    } else if (action === 'member.remove' && user !== null) {
      await sql`DELETE FROM org_members WHERE org_id = ${org} AND user_id = ${user}`
    } else if (action === 'team.create' && typeof p.team === 'string') {
      await sql`INSERT INTO teams (org_id, slug, name) VALUES (${org}, ${p.team}, ${p.team}) ON CONFLICT DO NOTHING`
    } else if ((action === 'team.member.add' || action === 'team.member.remove') && typeof p.team === 'string' && user !== null) {
      const [t] = await sql`SELECT id FROM teams WHERE org_id = ${org} AND slug = ${p.team}`
      if (!t) return
      if (action === 'team.member.add') await sql`INSERT INTO team_members (team_id, user_id) VALUES (${t.id}, ${user}) ON CONFLICT DO NOTHING`
      else await sql`DELETE FROM team_members WHERE team_id = ${t.id} AND user_id = ${user}`
    }
  }

  // ---- public repos from name claims (first claim of a name wins; a repo's latest claim is its current name) ----
  names.sort((a, b) => a.ctime - b.ctime)
  const claimed = new Map<string, NameEntity>()
  const latest = new Map<string, NameEntity>()
  for (const n of names) {
    if (!/^[^/]+\/[^/]+$/.test(n.name) || claimed.has(n.name.toLowerCase())) { stats.skipped++; continue }
    claimed.set(n.name.toLowerCase(), n)
    latest.set(n.repo, n)
  }
  const repoIds = new Map<string, number>()
  for (const [repoHex, n] of latest) {
    const [ownerLogin, repoName] = n.name.split('/') as [string, string]
    const o = await owner(ownerLogin)
    const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name, visibility, created_at)
      VALUES (${buf(repoHex)}, ${o.kind}, ${o.id}, ${repoName}, 'public', ${iso(n.ctime)}) ON CONFLICT DO NOTHING RETURNING id`
    if (!r) { stats.skipped++; continue }
    repoIds.set(repoHex, Number(r.id)); stats.repos++
  }
  for (const n of claimed.values()) {
    await sql`INSERT INTO name_claims (name, dheet_repo_id, claimant, arkiv_entity, claimed_at)
      VALUES (${n.name}, ${buf(n.repo)}, ${buf(n.owner)}, ${buf(n.entityKey)}, ${iso(n.ctime)}) ON CONFLICT DO NOTHING`
  }

  // ---- commits, pushes, anchors, feed (public) ----
  interface PushInfo { ref: string; commits: Array<{ oid: string; subject: string; entity: string; l1Tx: Hex; l1ChainId: number; ctime: number }>; push?: ActivityEntity; body?: Record<string, unknown> }
  async function writePushes(repoNum: number, pushes: Map<string, PushInfo>, done: boolean) {
    for (const p of pushes.values()) {
      const last = p.commits.at(-1)
      const swarmRef = p.body?.swarmManifestRef
      const ctime = p.push?.ctime ?? last?.ctime ?? 0
      const newOid = typeof p.body?.newOid === 'string' ? p.body.newOid : last?.oid ?? null
      const manifestHash = p.push && !ZERO.test(p.push.manifestHash) ? p.push.manifestHash : typeof p.body?.manifestHash === 'string' ? p.body.manifestHash : null
      const [row] = await sql`INSERT INTO pushes (repo_id, ref_name, new_oid, manifest_hash, created_at)
        VALUES (${repoNum}, ${p.ref}, ${newOid ? buf(newOid) : null}, ${manifestHash ? buf(manifestHash) : null}, ${iso(ctime)}) RETURNING id`
      const pushId = Number(row.id); stats.pushes++
      for (const c of p.commits) {
        const oid = buf(c.oid)
        await sql`INSERT INTO commits (repo_id, oid, tree_oid, parent_oids, authored_at, committed_at, message, subject)
          VALUES (${repoNum}, ${oid}, ${Buffer.alloc(oid.length)}, '[]', ${iso(c.ctime)}, ${iso(c.ctime)}, ${c.subject}, ${c.subject}) ON CONFLICT DO NOTHING`
        const anchored = !ZERO.test(c.l1Tx)
        await sql`INSERT INTO commit_anchors (repo_id, commit_oid, push_id, ref_name, l1_chain_id, l1_tx, arkiv_entity, status)
          VALUES (${repoNum}, ${oid}, ${pushId}, ${p.ref}, ${anchored ? c.l1ChainId : null}, ${anchored ? buf(c.l1Tx) : null}, ${c.entity ? buf(c.entity) : null},
                  ${done ? 'done_private' : anchored ? 'anchored' : 'arkiv_done'}) ON CONFLICT DO NOTHING`
        stats.commits++
      }
      if (typeof swarmRef === 'string' && typeof p.body?.swarmPackRef === 'string') {
        const enc = done ? 1 : 0
        await sql`INSERT INTO swarm_uploads (repo_id, push_id, kind, reference, encrypted, created_at)
          VALUES (${repoNum}, ${pushId}, 'pack', ${p.body.swarmPackRef}, ${enc}, ${iso(ctime)}), (${repoNum}, ${pushId}, 'manifest', ${swarmRef}, ${enc}, ${iso(ctime)})`
      }
      await sql`INSERT INTO activity (repo_id, kind, payload, created_at) VALUES (${repoNum}, 'push', ${json({ ref: p.ref, commits: p.commits.length, forced: false, deleted: !newOid })}, ${iso(ctime)})`
      await sql`UPDATE repos SET pushed_at = max(coalesce(pushed_at, ''), ${iso(ctime)}) WHERE id = ${repoNum}`
    }
  }

  for (const [repoHex, repoNum] of repoIds) {
    const pushes = new Map<string, PushInfo>()
    const list = (byRepo.get(repoHex) ?? []).sort((a, b) => a.seq - b.seq)
    for (const a of list) {
      const b = bodyOf(a)
      if (a.kind === 'commit') {
        const id = String(b.pushId ?? `ref:${a.ref}`)
        const p = pushes.get(id) ?? { ref: String(b.ref ?? a.ref), commits: [] }
        p.commits.push({ oid: String(b.oid ?? a.commitOid), subject: String(b.subject ?? a.title), entity: a.entityKey, l1Tx: a.l1Tx, l1ChainId: a.l1ChainId, ctime: a.ctime })
        pushes.set(id, p)
      } else if (a.kind === 'push') {
        const id = String(b.pushId ?? `entity:${a.entityKey}`)
        const p = pushes.get(id) ?? { ref: a.ref, commits: [] }
        p.push = a; p.body = b; p.ref ||= a.ref
        pushes.set(id, p)
      } else if (a.kind === 'issue' || a.kind === 'pr' || a.kind === 'comment') {
        await writeCollab(repoNum, a, b)
      }
    }
    await writePushes(repoNum, pushes, false)
  }

  /** Issues / PRs / comments mirrored as activity: body { number, title, body?, state?, author?, headRef?, headOid?, baseRef?, baseOid? }. */
  async function writeCollab(repoNum: number, a: ActivityEntity, b: Record<string, unknown>) {
    const number = Number(b.number)
    if (!Number.isSafeInteger(number) || number <= 0) { stats.skipped++; return }
    const author = typeof b.author === 'string' ? await userId(b.author) : null
    if (a.kind === 'comment') {
      const [issue] = await sql`SELECT id FROM issues WHERE repo_id = ${repoNum} AND number = ${number}`
      if (!issue || typeof b.body !== 'string') { stats.skipped++; return }
      await sql`INSERT INTO comments (repo_id, issue_id, author_id, body, created_at) VALUES (${repoNum}, ${issue.id}, ${author}, ${b.body}, ${iso(a.ctime)})`
      await sql`UPDATE issues SET comments_count = comments_count + 1 WHERE id = ${issue.id}`
      return
    }
    const state = b.state === 'closed' || b.state === 'merged' ? 'closed' : 'open'
    const [issue] = await sql`INSERT INTO issues (repo_id, number, author_id, title, body, state, created_at, updated_at)
      VALUES (${repoNum}, ${number}, ${author}, ${String(b.title ?? a.title)}, ${typeof b.body === 'string' ? b.body : null}, ${state}, ${iso(a.ctime)}, ${iso(a.ctime)})
      ON CONFLICT (repo_id, number) DO UPDATE SET title = excluded.title, body = coalesce(excluded.body, issues.body), state = excluded.state, updated_at = excluded.updated_at
      RETURNING id`
    await sql`INSERT INTO repo_counters (repo_id, last_number) VALUES (${repoNum}, ${number}) ON CONFLICT (repo_id) DO UPDATE SET last_number = max(last_number, excluded.last_number)`
    stats.issues++
    if (a.kind === 'pr' && typeof b.headRef === 'string' && typeof b.baseRef === 'string' && typeof b.headOid === 'string' && typeof b.baseOid === 'string') {
      const prState = b.state === 'merged' ? 'merged' : state
      await sql`INSERT INTO pull_requests (issue_id, repo_id, head_ref, head_oid, base_ref, base_oid, state)
        VALUES (${issue.id}, ${repoNum}, ${b.headRef}, ${buf(b.headOid)}, ${b.baseRef}, ${buf(b.baseOid)}, ${prState})
        ON CONFLICT (issue_id) DO UPDATE SET head_oid = excluded.head_oid, base_oid = excluded.base_oid, state = excluded.state`
    }
  }

  // ---- refs + default branch from the latest manifest entity of each public repo ----
  const latestManifest = new Map<string, ManifestEntity>()
  for (const m of manifests) { const cur = latestManifest.get(m.repo); if (!cur || m.seq > cur.seq || (m.seq === cur.seq && m.ctime > cur.ctime)) latestManifest.set(m.repo, m) }
  for (const [repoHex, m] of latestManifest) {
    const repoNum = repoIds.get(repoHex)
    if (repoNum === undefined) continue
    let parsed: ReturnType<typeof parseArkivManifestContent>
    try { parsed = parseArkivManifestContent(m.content, m.oid) } catch { stats.skipped++; continue }
    if (!parsed.manifest) continue
    for (const ref of parsed.manifest.refs) {
      await sql`INSERT INTO git_refs (repo_id, name, oid, updated_at) VALUES (${repoNum}, ${ref.name}, ${buf(ref.oid)}, ${iso(m.ctime)})
        ON CONFLICT (repo_id, name) DO UPDATE SET oid = excluded.oid, updated_at = excluded.updated_at`
    }
    const head = parsed.manifest.headRef?.replace(/^refs\/heads\//, '')
    if (head) await sql`UPDATE repos SET default_branch = ${head}, git_object_format = ${parsed.manifest.gitObjectFormat === 'sha256' ? 'sha256' : 'sha1'} WHERE id = ${repoNum}`
  }

  // ---- deployments ----
  for (const a of activity) {
    if (a.kind !== 'deploy' && a.kind !== 'attest') continue
    const b = bodyOf(a) as { releaseId?: number; commit?: string; bundleHash?: string; url?: string; publisher?: string; publishedAt?: string; ok?: boolean; observedAt?: number }
    const id = Number(b.releaseId ?? a.seq)
    if (a.kind === 'deploy') {
      if (!b.commit || !b.bundleHash || !b.url) { stats.skipped++; continue }
      await sql`INSERT INTO deployments (chain_id, id, "commit", bundle_hash, url, published_at, publisher, publish_tx, arkiv_entity)
        VALUES (${a.l1ChainId}, ${id}, ${buf(b.commit)}, ${buf(b.bundleHash)}, ${b.url}, ${b.publishedAt ?? iso(a.ctime)}, ${b.publisher ? buf(b.publisher) : null},
                ${ZERO.test(a.l1Tx) ? null : buf(a.l1Tx)}, ${buf(a.entityKey)}) ON CONFLICT (chain_id, id) DO NOTHING`
      stats.deployments++
    } else {
      await sql`UPDATE deployments SET attested = 1, attested_ok = ${b.ok ? 1 : 0}, attested_at = ${iso(Number(b.observedAt ?? a.ctime))},
        attest_tx = ${ZERO.test(a.l1Tx) ? null : buf(a.l1Tx)} WHERE chain_id = ${a.l1ChainId} AND id = ${id}`
    }
  }

  // ---- private repos: server grants -> repo keys -> decrypted push bodies ----
  if (args.deviceKey) {
    const priv = args.deviceKey.startsWith('0x') ? args.deviceKey : `0x${args.deviceKey}`
    const grants = await collect(source.grants(devicePublicKey(priv)))
    const keys = new Map<string, Map<number, { key: Uint8Array; sealed: Uint8Array }>>()
    for (const g of grants) {
      try {
        const k = openRepoKey(g.sealed, priv, grantContext(g.repo, g.epoch))
        const m = keys.get(g.repo) ?? new Map(); m.set(g.epoch, { key: k, sealed: g.sealed }); keys.set(g.repo, m)
      } catch { stats.skipped++ }
    }
    for (const [arkivId, epochs] of keys) {
      let repoNum: number | null = null
      const pushes = new Map<string, PushInfo>()
      for (const a of (byRepo.get(arkivId) ?? []).sort((x, y) => x.seq - y.seq)) {
        const raw = bodyOf(a)
        if (!isPrivateBody(raw)) continue
        const k = epochs.get(raw.epoch)
        if (!k) { stats.skipped++; continue }
        let b: { repo?: { id?: string; owner?: string; ownerKind?: string; name?: string }; push?: { id?: number; ref?: string; newOid?: string | null }; commits?: Array<{ oid: string; subject: string }>
          swarmManifestRef?: string; swarmPackRef?: string; manifestHash?: string }
        try { b = openPrivateBody(raw, k.key, arkivId as Hex) } catch { stats.skipped++; continue }
        if (repoNum === null && b.repo?.id && b.repo.name && b.repo.owner) {
          const o = b.repo.ownerKind === 'org' ? { kind: 'org' as const, id: await orgId(b.repo.owner) } : { kind: 'user' as const, id: await userId(b.repo.owner) }
          const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name, visibility, created_at)
            VALUES (${buf(b.repo.id)}, ${o.kind}, ${o.id}, ${b.repo.name}, 'private', ${iso(a.ctime)}) ON CONFLICT DO NOTHING RETURNING id`
          if (!r) { stats.skipped++; break }
          repoNum = Number(r.id); stats.privateRepos++
          for (const [epoch, v] of epochs) await sql`INSERT INTO repo_keys (repo_id, epoch, sealed) VALUES (${repoNum}, ${epoch}, ${Buffer.from(v.sealed)}) ON CONFLICT DO NOTHING`
        }
        const id = String(b.push?.id ?? a.entityKey)
        pushes.set(id, {
          ref: String(b.push?.ref ?? ''), push: a,
          body: { swarmManifestRef: b.swarmManifestRef, swarmPackRef: b.swarmPackRef, manifestHash: b.manifestHash, newOid: b.push?.newOid ?? undefined },
          commits: (b.commits ?? []).filter((c) => c.oid).map((c) => ({ oid: c.oid, subject: c.subject, entity: a.entityKey, l1Tx: a.l1Tx, l1ChainId: a.l1ChainId, ctime: a.ctime })),
        })
      }
      if (repoNum !== null) await writePushes(repoNum, pushes, true)
    }
  }

  // every entity we now know about, so the worker keeps renewing them (expiry is refreshed on its next renewal pass)
  for (const a of activity) await sql`INSERT INTO arkiv_entities (entity_key, schema, tx_hash, expires_at_block) VALUES (${buf(a.entityKey)}, 'dheet-activity-v1', ${Buffer.alloc(32)}, 0) ON CONFLICT DO NOTHING`
  for (const n of names) await sql`INSERT INTO arkiv_entities (entity_key, schema, tx_hash, expires_at_block) VALUES (${buf(n.entityKey)}, 'dheet-name-v1', ${Buffer.alloc(32)}, 0) ON CONFLICT DO NOTHING`
  for (const m of manifests) await sql`INSERT INTO arkiv_entities (entity_key, schema, tx_hash, expires_at_block) VALUES (${buf(m.entityKey)}, 'dheet-manifest-v1', ${Buffer.alloc(32)}, 0) ON CONFLICT DO NOTHING`

  log(`rebuilt: ${JSON.stringify(stats)}`)
  return stats
}

if (import.meta.main) {
  const env = process.env
  const relayer = (env.ARKIV_RELAYER ?? '') as Hex
  let conn: ReturnType<typeof createArkivConnection>
  if (env.DHEET_PRIVATE_KEY) conn = createArkivConnection({ privateKey: env.DHEET_PRIVATE_KEY as ViemHex, accessKey: env.ARKIV_ACCESS_KEY ?? '' })
  else throw new Error('DHEET_PRIVATE_KEY is required to connect to Arkiv (only reads are made)')
  const sql = openDb()
  const stats = await rebuildIndex({
    sql, source: arkivSource(conn, (/^0x[0-9a-f]{40}$/i.test(relayer) ? relayer : conn.account.address) as Hex),
    ...(env.DITHUB_DEVICE_KEY ? { deviceKey: env.DITHUB_DEVICE_KEY } : {}), force: process.argv.includes('--force'),
  })
  void stats
  await sql.close()
}
