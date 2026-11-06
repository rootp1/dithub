// Private-repo key management against a temp SQLite file: device-key registration, repo key creation,
// grants on add, rotation on removal, and the member key endpoint.
import { randomBytes } from 'node:crypto'
process.env.DITHUB_DEVICE_KEY ||= randomBytes(32).toString('hex')
import { call, createUser, setupDb } from './sqlite-testenv.ts'
import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deviceKeyStatement, generateDeviceKey, grantContext, openRepoKey } from '../../../packages/sdk/src/keys.ts'
import type { GrantJob } from './keys.ts'

const { sql, hex, now, parseJson } = await setupDb()
const { rbac } = await import('./rbac.ts')
const K = await import('./keys.ts')
const app = new Hono()
app.route('/api', rbac)
app.route('/api', K.keys)

type Member = Awaited<ReturnType<typeof createUser>> & { account: ReturnType<typeof privateKeyToAccount>; device: ReturnType<typeof generateDeviceKey> }

async function member(prefix: string, register = true): Promise<Member> {
  const u = await createUser(prefix)
  const account = privateKeyToAccount(generatePrivateKey())
  await sql`INSERT INTO wallets (user_id, address, is_primary, verified_at) VALUES (${u.id}, ${hex(account.address)}, 1, ${now()})`
  const device = generateDeviceKey()
  const m = { ...u, account, device }
  if (register) expect((await registerDevice(m)).status).toBe(201)
  return m
}
async function registerDevice(m: Member, device = m.device) {
  const signature = await m.account.signMessage({ message: deviceKeyStatement(m.account.address, device.publicKey) })
  return call(app, 'POST', '/api/user/device-keys', { cookie: m.cookie, body: { publicKey: device.publicKey, signature } })
}
async function privateRepo(owner: { id: number }, kind: 'user' | 'org' = 'user', name = `p${Date.now().toString(36)}${randomBytes(2).toString('hex')}`) {
  const idHex = `0x${randomBytes(32).toString('hex')}`
  const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name, visibility) VALUES (${hex(idHex)}, ${kind}, ${owner.id}, ${name}, 'private') RETURNING id`
  const repo = { id: Number(r.id), dheetRepoId: idHex, name }
  await sql.begin((tx) => K.initRepoKey(tx, repo))
  return repo
}
const epochs = async (repoId: number) => (await sql`SELECT epoch FROM repo_keys WHERE repo_id = ${repoId} ORDER BY epoch`).map((r: { epoch: number }) => Number(r.epoch))
async function grantJobs(repoId: number, sinceId = 0) {
  const rows = await sql`SELECT id, payload FROM outbox WHERE kind = 'grant' AND aggregate_id = ${repoId} AND id > ${sinceId} ORDER BY id`
  return rows.map((r: { payload: string }) => parseJson<GrantJob>(r.payload)) as GrantJob[]
}
const lastOutboxId = async () => Number((await sql`SELECT coalesce(max(id), 0) AS id FROM outbox`)[0].id)
async function keyFor(m: Member, path: string, epoch?: number) {
  const res = await call(app, 'GET', `/api/repos/${path}/keys${epoch === undefined ? '' : `?epoch=${epoch}`}`, { cookie: m.cookie })
  if (res.status !== 200) return { status: res.status, key: null as string | null, data: res.data }
  const g = res.data.grants.find((x: { recipient: string }) => x.recipient === m.device.publicKey)
  return { status: 200, key: Buffer.from(openRepoKey(g.sealed, m.device.privateKey, res.data.context)).toString('hex'), data: res.data }
}

describe('device keys', () => {
  let a: Member
  beforeAll(async () => { a = await member('dka') })

  test('registers, lists and queues an Arkiv mirror job', async () => {
    const list = await call(app, 'GET', '/api/user/device-keys', { cookie: a.cookie })
    expect(list.data.deviceKeys.map((d: { publicKey: string }) => d.publicKey)).toEqual([a.device.publicKey])
    const [job] = await sql`SELECT payload FROM outbox WHERE kind = 'device_key' AND aggregate_id = ${a.id}`
    expect(parseJson<{ publicKey: string; wallet: string }>(job.payload)).toMatchObject({ publicKey: a.device.publicKey, wallet: a.account.address })
    expect((await registerDevice(a)).data.existing).toBe(true)
  })

  test('rejects bad input, foreign signatures and stolen keys', async () => {
    expect((await call(app, 'POST', '/api/user/device-keys', { body: {} })).status).toBe(401)
    expect((await call(app, 'POST', '/api/user/device-keys', { cookie: a.cookie, body: { publicKey: '0x12', signature: '0x' } })).status).toBe(400)
    const other = privateKeyToAccount(generatePrivateKey())
    const d = generateDeviceKey()
    const signature = await other.signMessage({ message: deviceKeyStatement(other.address, d.publicKey) })
    const res = await call(app, 'POST', '/api/user/device-keys', { cookie: a.cookie, body: { publicKey: d.publicKey, signature } })
    expect(res.status).toBe(400)
    const b = await member('dkb', false)
    expect((await registerDevice(b, a.device)).status).toBe(409)
  })
})

describe('private repo keys', () => {
  let a: Member, b: Member, c: Member
  let repo: { id: number; dheetRepoId: string; name: string }
  beforeAll(async () => {
    a = await member('pka'); b = await member('pkb'); c = await member('pkc', false)
    repo = await privateRepo(a)
  })
  const path = () => `${a.login}/${repo.name}`

  test('creation seals epoch 0 to the server and grants the owner', async () => {
    expect(await epochs(repo.id)).toEqual([0])
    const jobs = await grantJobs(repo.id)
    expect(jobs.map((j) => j.server)).toEqual([true, false])
    expect(jobs[1]!.recipient).toBe(a.device.publicKey)
    expect(jobs.every((j) => j.repo === K.arkivRepoId(repo.dheetRepoId) && j.epoch === 0)).toBe(true)
    // the queued grant opens to the same key the server holds
    const server = await K.repoKey(sql, repo)
    expect(Buffer.from(openRepoKey(jobs[1]!.sealed, a.device.privateKey, grantContext(jobs[1]!.repo, 0))).equals(Buffer.from(server!.key))).toBe(true)
    const own = await keyFor(a, path())
    expect(own.key).toBe(Buffer.from(server!.key).toString('hex'))
    expect(own.data.epoch).toBe(0)
  })

  test('adding a collaborator grants the current epoch without rotating', async () => {
    const since = await lastOutboxId()
    expect((await keyFor(b, path())).status).toBe(404)
    expect((await call(app, 'PUT', `/api/repos/${path()}/collaborators/${b.login}`, { cookie: a.cookie, body: { permission: 'write' } })).status).toBe(200)
    expect(await epochs(repo.id)).toEqual([0])
    const jobs = await grantJobs(repo.id, since)
    expect(jobs.map((j) => [j.recipient, j.epoch, j.userId])).toEqual([[b.device.publicKey, 0, b.id]])
    expect((await keyFor(b, path())).key).toBe((await keyFor(a, path())).key)
  })

  test('a member without a device key gets a grant when registering one', async () => {
    await call(app, 'PUT', `/api/repos/${path()}/collaborators/${c.login}`, { cookie: a.cookie, body: { permission: 'read' } })
    expect((await keyFor(c, path())).status).toBe(409)
    const since = await lastOutboxId()
    const res = await registerDevice(c)
    expect(res.data.grants).toBe(1)
    expect((await grantJobs(repo.id, since)).map((j) => j.recipient)).toEqual([c.device.publicKey])
  })

  test('removing a collaborator rotates to a new epoch without them', async () => {
    const old = (await keyFor(a, path())).key
    const since = await lastOutboxId()
    expect((await call(app, 'DELETE', `/api/repos/${path()}/collaborators/${b.login}`, { cookie: a.cookie })).status).toBe(200)
    expect(await epochs(repo.id)).toEqual([0, 1])
    const jobs = await grantJobs(repo.id, since)
    expect(jobs.every((j) => j.epoch === 1)).toBe(true)
    expect(new Set(jobs.map((j) => j.recipient))).toEqual(new Set([jobs[0]!.recipient, a.device.publicKey, c.device.publicKey]))
    expect(jobs[0]!.server).toBe(true)
    expect(jobs.some((j) => j.recipient === b.device.publicKey)).toBe(false)
    expect((await keyFor(b, path())).status).toBe(404)
    const fresh = await keyFor(a, path())
    expect(fresh.data.epoch).toBe(1)
    expect(fresh.key).not.toBe(old)
    expect((await keyFor(a, path(), 0)).key).toBe(old)            // old epochs stay readable for current members
    expect((await keyFor(a, path(), 5)).status).toBe(400)
  })

  test('public repos have no keys', async () => {
    const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name) VALUES (${randomBytes(32)}, 'user', ${a.id}, 'pub') RETURNING id`
    expect((await call(app, 'GET', `/api/repos/${a.login}/pub/keys`, { cookie: a.cookie })).status).toBe(400)
    expect(await epochs(Number(r.id))).toEqual([])
  })
})

describe('org membership drives grants and rotation', () => {
  test('owners get grants, plain members do not, removal rotates', async () => {
    const owner = await member('oko'), m = await member('okm')
    const created = await call(app, 'POST', '/api/orgs', { cookie: owner.cookie, body: { login: `org${Date.now().toString(36)}`, visibility: 'private' } })
    expect(created.status).toBe(201)
    const org = created.data.org
    const repo = await privateRepo({ id: Number(org.id) }, 'org')
    const path = `${org.login}/${repo.name}`
    expect((await keyFor(owner, path)).status).toBe(200)

    let since = await lastOutboxId()
    await call(app, 'PUT', `/api/orgs/${org.login}/members/${m.login}`, { cookie: owner.cookie, body: { role: 'member' } })
    expect(await grantJobs(repo.id, since)).toEqual([])                // org 'member' has no access to private repos
    expect((await keyFor(m, path)).status).toBe(404)

    await call(app, 'PUT', `/api/orgs/${org.login}/members/${m.login}`, { cookie: owner.cookie, body: { role: 'owner' } })
    expect((await grantJobs(repo.id, since)).map((j) => j.recipient)).toEqual([m.device.publicKey])
    expect(await epochs(repo.id)).toEqual([0])

    since = await lastOutboxId()
    expect((await call(app, 'DELETE', `/api/orgs/${org.login}/members/${m.login}`, { cookie: owner.cookie })).status).toBe(200)
    expect(await epochs(repo.id)).toEqual([0, 1])
    expect((await grantJobs(repo.id, since)).some((j) => j.recipient === m.device.publicKey)).toBe(false)

    // team access: adding a team member grants, removing rotates
    const t = await member('okt')
    await call(app, 'PUT', `/api/orgs/${org.login}/members/${t.login}`, { cookie: owner.cookie, body: { role: 'member' } })
    await call(app, 'POST', `/api/orgs/${org.login}/teams`, { cookie: owner.cookie, body: { slug: 'core' } })
    await call(app, 'PUT', `/api/repos/${path}/teams/core`, { cookie: owner.cookie, body: { permission: 'read' } })
    since = await lastOutboxId()
    await call(app, 'PUT', `/api/orgs/${org.login}/teams/core/members/${t.login}`, { cookie: owner.cookie })
    expect((await grantJobs(repo.id, since)).map((j) => [j.recipient, j.epoch])).toEqual([[t.device.publicKey, 1]])
    await call(app, 'DELETE', `/api/orgs/${org.login}/teams/core/members/${t.login}`, { cookie: owner.cookie })
    expect(await epochs(repo.id)).toEqual([0, 1, 2])
  })

  test('rbac log payloads and protections come back as JSON / booleans', async () => {
    const owner = await member('okl')
    const login = `pub${Date.now().toString(36)}`
    await call(app, 'POST', '/api/orgs', { cookie: owner.cookie, body: { login } })
    const log = await call(app, 'GET', `/api/orgs/${login}/rbac-log`, { cookie: owner.cookie })
    expect(log.data.events[0].payload.org).toBe(login)
    const info = await call(app, 'GET', `/api/orgs/${login}`, { cookie: owner.cookie })
    expect(info.data.rbacSeq).toBe(1)
    const [r] = await sql`SELECT id FROM orgs WHERE login = ${login}`
    await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name) VALUES (${randomBytes(32)}, 'org', ${r.id}, 'x')`
    expect((await call(app, 'PUT', `/api/repos/${login}/x/protections`, { cookie: owner.cookie, body: { pattern: 'main' } })).status).toBe(200)
    const p = await call(app, 'GET', `/api/repos/${login}/x/protections`, { cookie: owner.cookie })
    expect(p.data.protections).toEqual([{ pattern: 'main', require_pr: true, required_approvals: 1, allow_force_push: false, allow_deletions: false }])
  })
})
