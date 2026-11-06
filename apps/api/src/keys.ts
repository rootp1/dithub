// Private-repo key management (docs/swarm-arkiv-design.md, "Private repos").
// One 32-byte key per private repo per epoch. The server is a member: its copy lives sealed in repo_keys,
// every other member gets a grant sealed to each registered device key. Grants and device-key registrations
// are written to Arkiv by the worker from the outbox ('grant', 'device_key'); this file only plans and queues them.
// Membership changes go through snapshotAccess() before and reconcileRepoKeys() after (same transaction):
// a lost member rotates the key (new epoch), a new member gets grants for the current epoch.
import { Hono } from 'hono'
import type { SQL } from 'bun'
import { sql, json, toHex } from './db.ts'
import { config } from './config.ts'
import { authenticate } from './auth.ts'
import { can, findRepo } from './perm.ts'
import { deviceKeyStatement, devicePublicKey, grantContext, openRepoKey, planRotation, privateRepoArkivId, sealRepoKey, verifyDeviceKey } from '../../../packages/sdk/src/keys.ts'
import type { Hex } from '../../../packages/sdk/src/types.ts'

export const keys = new Hono()

type Q = SQL
export interface KeyRepo { id: number; dheetRepoId: string }
export interface GrantJob { repo: Hex; epoch: number; recipient: Hex; sealed: Hex; server: boolean; userId?: number; repoId: number }

const KEY32 = /^0x[0-9a-fA-F]{64}$/
const SIG65 = /^0x[0-9a-fA-F]{130}$/
const lowerHex = (v: Uint8Array | Buffer) => `0x${Buffer.from(v).toString('hex')}` as Hex

let warned = false
/** The server's X25519 private key (DITHUB_DEVICE_KEY), or null when private-repo keys are disabled. */
export function serverPrivateKey(): string | null {
  const k = config.deviceKey || process.env.DITHUB_DEVICE_KEY || ''
  if (k) return k.startsWith('0x') ? k : `0x${k}`
  if (!warned) { warned = true; console.warn('DITHUB_DEVICE_KEY is not set: private repository keys are disabled') }
  return null
}
export const keysEnabled = () => serverPrivateKey() !== null

/** Opaque Arkiv id of a private repo. The server device key doubles as the secret, so the id is stable and unguessable. */
export function arkivRepoId(dheetRepoId: string): Hex {
  const secret = serverPrivateKey()
  if (!secret) throw new Error('DITHUB_DEVICE_KEY is required for private repositories')
  return privateRepoArkivId(dheetRepoId.toLowerCase(), secret.toLowerCase())
}

/** Users who can read a private repo (mirrors perm.ts for private repos; site admins are not key members). */
export async function repoMemberIds(q: Q, repoId: number): Promise<number[]> {
  const rows = await q`SELECT owner_id AS user_id FROM repos WHERE id = ${repoId} AND owner_kind = 'user'
    UNION SELECT m.user_id FROM repos r JOIN org_members m ON m.org_id = r.owner_id WHERE r.id = ${repoId} AND r.owner_kind = 'org' AND m.role = 'owner'
    UNION SELECT tm.user_id FROM repo_team_access a JOIN team_members tm ON tm.team_id = a.team_id WHERE a.repo_id = ${repoId}
    UNION SELECT user_id FROM repo_collaborators WHERE repo_id = ${repoId}`
  return rows.map((r: { user_id: number }) => Number(r.user_id)).sort((a: number, b: number) => a - b)
}

async function deviceKeysOf(q: Q, userIds: number[]): Promise<{ userId: number; publicKey: Hex }[]> {
  const out: { userId: number; publicKey: Hex }[] = []
  for (const id of userIds) {
    for (const r of await q`SELECT public_key FROM device_keys WHERE user_id = ${id} ORDER BY created_at`) out.push({ userId: id, publicKey: lowerHex(r.public_key) })
  }
  return out
}

async function loadKeyRepo(q: Q, repoId: number): Promise<KeyRepo | null> {
  const [r] = await q`SELECT id, dheet_repo_id FROM repos WHERE id = ${repoId} AND visibility = 'private' AND deleted_at IS NULL`
  return r ? { id: Number(r.id), dheetRepoId: lowerHex(r.dheet_repo_id) } : null
}

/** Latest epoch number of a repo, or null when it has no key yet. */
export async function currentEpoch(q: Q, repoId: number): Promise<number | null> {
  const [r] = await q`SELECT max(epoch) AS epoch FROM repo_keys WHERE repo_id = ${repoId}`
  return r?.epoch === null || r?.epoch === undefined ? null : Number(r.epoch)
}

/** Open the server's sealed copy of a repo key (latest epoch unless one is given). */
export async function repoKey(q: Q, repo: KeyRepo, epoch?: number): Promise<{ epoch: number; key: Uint8Array } | null> {
  const priv = serverPrivateKey(); if (!priv) return null
  const e = epoch ?? (await currentEpoch(q, repo.id)); if (e === null) return null
  const [r] = await q`SELECT sealed FROM repo_keys WHERE repo_id = ${repo.id} AND epoch = ${e}`
  if (!r) return null
  return { epoch: e, key: openRepoKey(new Uint8Array(r.sealed), priv, grantContext(arkivRepoId(repo.dheetRepoId), e)) }
}

async function enqueueGrant(q: Q, job: GrantJob) {
  await q`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('repo', ${job.repoId}, 'grant', ${json(job)})`
}

async function newEpoch(q: Q, repo: KeyRepo, epoch: number): Promise<number> {
  const priv = serverPrivateKey()!
  const members = await deviceKeysOf(q, await repoMemberIds(q, repo.id))
  const arkiv = arkivRepoId(repo.dheetRepoId)
  const plan = planRotation({ members: members.map((m) => ({ publicKey: m.publicKey, userId: String(m.userId) })), serverPublicKey: devicePublicKey(priv), epoch, repo: arkiv })
  await q`INSERT INTO repo_keys (repo_id, epoch, sealed) VALUES (${repo.id}, ${epoch}, ${Buffer.from(plan.serverSealed)})`
  for (const g of plan.grants) await enqueueGrant(q, {
    repoId: repo.id, repo: arkiv, epoch, recipient: g.recipient, sealed: lowerHex(g.sealed), server: g.server, ...(g.userId ? { userId: Number(g.userId) } : {}),
  })
  return plan.grants.length
}

/** Create epoch 0 for a private repo (no-op when it already has a key or keys are disabled). Returns the epoch or null. */
export async function initRepoKey(q: Q, repo: KeyRepo): Promise<number | null> {
  if (!keysEnabled()) return null
  const cur = await currentEpoch(q, repo.id)
  if (cur !== null) return cur
  await newEpoch(q, repo, 0)
  return 0
}

/** Start a new epoch with a fresh key, granted to the current members only. Returns the new epoch or null. */
export async function rotateRepoKey(q: Q, repo: KeyRepo): Promise<number | null> {
  if (!keysEnabled()) return null
  const cur = await currentEpoch(q, repo.id)
  const next = cur === null ? 0 : cur + 1
  await newEpoch(q, repo, next)
  return next
}

/** Queue grants of the current epoch for one user (all their device keys, or just `publicKey`). Returns how many. */
export async function grantUser(q: Q, repo: KeyRepo, userId: number, publicKey?: Hex): Promise<number> {
  const k = await repoKey(q, repo); if (!k) return 0
  const arkiv = arkivRepoId(repo.dheetRepoId)
  const ctx = grantContext(arkiv, k.epoch)
  let n = 0
  for (const d of await deviceKeysOf(q, [userId])) {
    if (publicKey && d.publicKey !== publicKey.toLowerCase()) continue
    await enqueueGrant(q, { repoId: repo.id, repo: arkiv, epoch: k.epoch, recipient: d.publicKey, sealed: lowerHex(sealRepoKey(k.key, d.publicKey, ctx)), server: false, userId })
    n++
  }
  return n
}

export type AccessSnapshot = Map<number, Set<number>>

/** Members of each given repo that is private, taken before a membership change. */
export async function snapshotAccess(q: Q, repoIds: number[]): Promise<AccessSnapshot> {
  const snap: AccessSnapshot = new Map()
  if (!keysEnabled()) return snap
  for (const id of new Set(repoIds)) if (await loadKeyRepo(q, id)) snap.set(id, new Set(await repoMemberIds(q, id)))
  return snap
}

/** After a membership change: rotate repos that lost a member, grant the current epoch to new members. */
export async function reconcileRepoKeys(q: Q, before: AccessSnapshot): Promise<{ rotated: number[]; granted: number[] }> {
  const out = { rotated: [] as number[], granted: [] as number[] }
  for (const [id, was] of before) {
    const repo = await loadKeyRepo(q, id); if (!repo) continue
    const now = new Set(await repoMemberIds(q, id))
    if ((await currentEpoch(q, id)) === null) { await initRepoKey(q, repo); continue }
    if ([...was].some((u) => !now.has(u))) { await rotateRepoKey(q, repo); out.rotated.push(id); continue }
    const added = [...now].filter((u) => !was.has(u))
    for (const u of added) await grantUser(q, repo, u)
    if (added.length) out.granted.push(id)
  }
  return out
}

/** Private repos of an org (every org-level change can affect them). */
export async function orgPrivateRepoIds(q: Q, orgId: number): Promise<number[]> {
  return (await q`SELECT id FROM repos WHERE owner_kind = 'org' AND owner_id = ${orgId} AND visibility = 'private' AND deleted_at IS NULL`).map((r: { id: number }) => Number(r.id))
}
/** Private repos a team has access to. */
export async function teamPrivateRepoIds(q: Q, teamId: number): Promise<number[]> {
  return (await q`SELECT r.id FROM repo_team_access a JOIN repos r ON r.id = a.repo_id
    WHERE a.team_id = ${teamId} AND r.visibility = 'private' AND r.deleted_at IS NULL`).map((r: { id: number }) => Number(r.id))
}

/** Private repos (with or without a key yet) the user is a key member of. */
async function memberPrivateRepos(q: Q, userId: number): Promise<KeyRepo[]> {
  const rows = await q`SELECT r.id, r.dheet_repo_id FROM repos r WHERE r.visibility = 'private' AND r.deleted_at IS NULL AND (
      (r.owner_kind = 'user' AND r.owner_id = ${userId})
      OR (r.owner_kind = 'org' AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = r.owner_id AND m.user_id = ${userId} AND m.role = 'owner'))
      OR EXISTS (SELECT 1 FROM repo_team_access a JOIN team_members tm ON tm.team_id = a.team_id WHERE a.repo_id = r.id AND tm.user_id = ${userId})
      OR EXISTS (SELECT 1 FROM repo_collaborators rc WHERE rc.repo_id = r.id AND rc.user_id = ${userId}))`
  return rows.map((r: { id: number; dheet_repo_id: Uint8Array }) => ({ id: Number(r.id), dheetRepoId: lowerHex(r.dheet_repo_id) }))
}

// ----- routes (mounted under /api) -----

keys.get('/user/device-keys', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const rows = await sql`SELECT public_key, created_at FROM device_keys WHERE user_id = ${user.id} ORDER BY created_at`
  return c.json({ deviceKeys: rows.map((r: { public_key: Uint8Array; created_at: string }) => ({ publicKey: toHex(r.public_key), createdAt: r.created_at })) })
})

// The exact text the signed-in wallet must personal_sign to register `publicKey` (used by /settings/device-keys).
keys.get('/user/device-keys/statement', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  if (!user.wallet) return c.json({ error: 'a wallet is required to register a device key' }, 400)
  const publicKey = c.req.query('publicKey') ?? ''
  if (!KEY32.test(publicKey)) return c.json({ error: 'publicKey must be 0x + 32 bytes of hex' }, 400)
  return c.json({ wallet: user.wallet, publicKey: publicKey.toLowerCase(), statement: deviceKeyStatement(user.wallet, publicKey) })
})

keys.post('/user/device-keys', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  if (!user.wallet) return c.json({ error: 'a wallet is required to register a device key' }, 400)
  const b = await c.req.json<{ publicKey?: string; signature?: string }>().catch(() => ({} as { publicKey?: string; signature?: string }))
  if (!KEY32.test(b.publicKey ?? '')) return c.json({ error: 'publicKey must be 0x + 32 bytes of hex' }, 400)
  if (!SIG65.test(b.signature ?? '')) return c.json({ error: 'signature must be 0x + 65 bytes of hex' }, 400)
  const publicKey = b.publicKey!.toLowerCase() as Hex, signature = b.signature!.toLowerCase() as Hex
  if (!(await verifyDeviceKey({ wallet: user.wallet, publicKey, signature }))) return c.json({ error: 'signature does not match your wallet' }, 400)
  const pk = Buffer.from(publicKey.slice(2), 'hex')
  const [existing] = await sql`SELECT user_id FROM device_keys WHERE public_key = ${pk}`
  if (existing && Number(existing.user_id) !== user.id) return c.json({ error: 'device key is registered to another account' }, 409)
  if (existing) return c.json({ ok: true, publicKey, grants: 0, existing: true })
  const grants = await sql.begin(async (tx) => {
    await tx`INSERT INTO device_keys (user_id, public_key, signature) VALUES (${user.id}, ${pk}, ${Buffer.from(signature.slice(2), 'hex')})`
    await tx`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload)
      VALUES ('user', ${user.id}, 'device_key', ${json({ userId: user.id, wallet: user.wallet, publicKey, signature })})`
    let n = 0
    if (keysEnabled()) for (const repo of await memberPrivateRepos(tx, user.id)) {
      if ((await currentEpoch(tx, repo.id)) === null) { await initRepoKey(tx, repo); n++ }
      else n += await grantUser(tx, repo, user.id, publicKey)
    }
    return n
  })
  return c.json({ ok: true, publicKey, grants }, 201)
})

// A member's sealed copies of a private repo key, freshly sealed to each of their device keys.
// ?epoch=N for an older epoch (needed to read content written before a rotation), ?publicKey=0x.. for one device.
keys.get('/repos/:owner/:repo/keys', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const repo = await findRepo(c.req.param('owner')!, c.req.param('repo')!)
  if (!repo || !(await can(user, repo, 'read'))) return c.json({ error: 'not found' }, 404)
  if (repo.visibility !== 'private') return c.json({ error: 'repository is not private' }, 400)
  if (!keysEnabled()) return c.json({ error: 'private repository keys are not configured on this server' }, 503)
  const kr: KeyRepo = { id: Number(repo.id), dheetRepoId: lowerHex(repo.dheet_repo_id) }
  if ((await currentEpoch(sql, kr.id)) === null) await sql.begin((tx) => initRepoKey(tx, kr))
  const latest = (await currentEpoch(sql, kr.id))!
  const want = c.req.query('epoch')
  const epoch = want === undefined ? latest : Number(want)
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > latest) return c.json({ error: `epoch must be between 0 and ${latest}` }, 400)
  const k = await repoKey(sql, kr, epoch)
  if (!k) return c.json({ error: 'no key for that epoch' }, 404)
  const only = c.req.query('publicKey')?.toLowerCase()
  const devices = (await deviceKeysOf(sql, [user.id])).filter((d) => !only || d.publicKey === only)
  if (!devices.length) return c.json({ error: 'register a device key first (dit keys init)' }, 409)
  const repoArkiv = arkivRepoId(kr.dheetRepoId)
  const context = grantContext(repoArkiv, epoch)
  return c.json({
    repo: repoArkiv, epoch, latestEpoch: latest, context,
    grants: devices.map((d) => ({ recipient: d.publicKey, sealed: lowerHex(sealRepoKey(k.key, d.publicKey, context)) })),
  })
})
