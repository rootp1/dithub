// End-to-end check of phases 1-2 against a running API + worker. Keys come from the environment; nothing is printed.
import { SQL } from 'bun'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createSiweMessage } from 'viem/siwe'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const host = new URL(BASE).host
const sql = new SQL(process.env.DATABASE_URL!)
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1 }

class Client {
  cookie = ''
  constructor(readonly key: `0x${string}`) {}
  async req(path: string, init: RequestInit = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie: this.cookie, ...(init.headers ?? {}) } })
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0]!
    return res
  }
  async login() {
    const account = privateKeyToAccount(this.key)
    const { nonce } = await (await this.req('/api/auth/nonce')).json() as { nonce: string }
    const message = createSiweMessage({ address: account.address, chainId: 11155111, domain: host, nonce, uri: BASE, version: '1' })
    const res = await this.req('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) })
    return (await res.json()) as { user?: { id: number; login: string }; error?: string }
  }
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', '-c', 'credential.helper=', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}


const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
const suffix = Date.now().toString(36)
const owner = new Client(process.env.DHEET_SEAT_KEY as `0x${string}`)
const other = new Client(process.env.DHEET_STRANGER_KEY as `0x${string}`)
const A = await owner.login(), B = await other.login()
ok(A.user?.id && B.user?.id, 'SIWE wallet login for two users')
const bLogin = B.user!.login

// ---- a PUBLIC org with a repo ----
const pub = `pub-${suffix}`, priv = `priv-${suffix}`
ok((await owner.req('/api/orgs', { method: 'POST', body: JSON.stringify({ login: pub, visibility: 'public' }) })).status === 201, 'public org created')
const repoRes = await owner.req('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'hello', org: pub }) })
const repo = await repoRes.json() as { repoId: string; cloneUrl: string }
ok(repoRes.status === 201, 'org repo created')
const tokA = (await (await owner.req('/api/tokens', { method: 'POST', body: '{"name":"e2e"}' })).json() as { token: string }).token
const tokB = (await (await other.req('/api/tokens', { method: 'POST', body: '{"name":"e2e"}' })).json() as { token: string }).token
const urlWith = (t: string) => repo.cloneUrl.replace('http://', `http://x:${t}@`)

const work = mkdtempSync(join(tmpdir(), 'dheet-e2e-'))
git(work, 'init', '-q', '-b', 'main')
const commit = (file: string, msg: string) => { writeFileSync(join(work, file), `${msg}\n`); git(work, 'add', '.'); git(work, 'commit', '-qm', msg) }
commit('README.md', 'first commit'); commit('main.ts', 'add main.ts')

ok(git(work, 'push', repo.cloneUrl, 'main').code !== 0, 'anonymous push refused')
ok(git(work, 'push', urlWith(tokB), 'main').code !== 0, 'user with no access cannot push')
ok((await other.req(`/api/orgs/${pub}/members/${bLogin}`, { method: 'PUT', body: '{"role":"owner"}' })).status === 403, 'non-owner cannot promote themselves')
ok(git(work, 'push', urlWith(tokA), 'main').code === 0, 'org owner pushes')

// ---- RBAC as a web2 feature ----
const setPerm = (perm: string) => owner.req(`/api/repos/${pub}/hello/collaborators/${bLogin}`, { method: 'PUT', body: JSON.stringify({ permission: perm }) })
ok((await setPerm('read')).status === 200, 'owner grants collaborator READ via API')
commit('b.txt', 'b: read-only attempt')
ok(git(work, 'push', urlWith(tokB), 'main').code !== 0, 'read-only collaborator cannot push')
ok((await setPerm('write')).status === 200, 'owner raises collaborator to WRITE')
ok(git(work, 'push', urlWith(tokB), 'main').code === 0, 'write collaborator pushes')

const prot = await owner.req(`/api/repos/${pub}/hello/protections`, { method: 'PUT', body: JSON.stringify({ pattern: 'main', requirePr: true }) })
ok(prot.status === 200, 'owner protects main (PR required)')
commit('c.txt', 'c: direct push to protected branch')
const direct = git(work, 'push', urlWith(tokB), 'main'); if (direct.code === 0 || !/pull request/i.test(direct.err)) console.log('DEBUG protected push ->', direct.code, direct.err.slice(0, 400)); ok(direct.code !== 0 && /pull request/i.test(direct.err), 'protected branch rejects direct push from a writer')
ok(git(work, 'push', urlWith(tokB), 'HEAD:refs/heads/feature').code === 0, 'writer can push a feature branch')
ok((await other.req(`/api/repos/${pub}/hello/protections`)).status === 403, 'non-admin cannot read or change protections')
ok((await owner.req(`/api/repos/${pub}/hello/collaborators/${bLogin}`, { method: 'DELETE' })).status === 200, 'owner removes collaborator')
commit('d.txt', 'd: after removal')
ok(git(work, 'push', urlWith(tokB), 'HEAD:refs/heads/feature2').code !== 0, 'removed collaborator can no longer push')

// ---- the verifiable log (public org) ----
const log = await (await owner.req(`/api/orgs/${pub}/rbac-log`)).json() as { verifiable: boolean; head: string; events: any[] }
ok(log.verifiable && log.events.length >= 5, `public org has a verifiable RBAC log (${log.events.length} events)`)
let prev = Buffer.alloc(32), chainOk = true
for (const e of log.events) {
  const { at, ...payload } = e.payload as Record<string, unknown>
  const h = createHash('sha256').update(Buffer.concat([prev, Buffer.from(canonical({ seq: e.seq, action: e.action, actor: e.actor, payload, at }))])).digest()
  if (`0x${h.toString('hex')}` !== e.hash) chainOk = false
  prev = h
}
ok(chainOk && `0x${prev.toString('hex')}` === log.head, 'hash chain recomputes independently and matches the head')

// ---- a PRIVATE org: same RBAC, nothing on-chain ----
ok((await owner.req('/api/orgs', { method: 'POST', body: JSON.stringify({ login: priv, visibility: 'private' }) })).status === 201, 'private org created')
const pr = await (await owner.req('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'secret', org: priv, visibility: 'public' }) })).json() as { cloneUrl: string }
ok(pr.cloneUrl, 'repo in a private org is created')
ok((await other.req(`/api/repos/${priv}/secret`)).status === 404, 'private org repo is invisible to non-members')
ok((await other.req(`/api/orgs/${priv}/rbac-log`)).status === 404, 'private org RBAC log is hidden from non-members')
await owner.req(`/api/orgs/${priv}/members/${bLogin}`, { method: 'PUT', body: '{"role":"member"}' })
const privLog = await (await owner.req(`/api/orgs/${priv}/rbac-log`)).json() as { verifiable: boolean; events: any[] }
ok(!privLog.verifiable && privLog.events.length >= 2, 'private org log is marked NOT verifiable (Postgres only)')

console.log('waiting for the worker: Arkiv mirror of public RBAC events and L1/Arkiv anchors (up to 8 min)…')
const [pubOrg] = await sql`SELECT id FROM orgs WHERE login = ${pub}`
const [privOrg] = await sql`SELECT id FROM orgs WHERE login = ${priv}`
const [repoRow] = await sql`SELECT id FROM repos WHERE dheet_repo_id = ${Buffer.from(repo.repoId.slice(2), 'hex')}`
const deadline = Date.now() + 480_000
let mirrored = 0, anchored = 0, total = 0
while (Date.now() < deadline) {
  mirrored = Number((await sql`SELECT count(*) AS n FROM rbac_events WHERE org_id = ${pubOrg.id} AND arkiv_tx IS NOT NULL`)[0].n)
  const rows = await sql`SELECT status FROM commit_anchors WHERE repo_id = ${repoRow.id}`
  total = rows.length; anchored = rows.filter((r: { status: string }) => r.status === 'anchored').length
  if (mirrored >= log.events.length && total > 0 && anchored === total) break
  await Bun.sleep(6000)
}
ok(mirrored >= log.events.length, `all ${log.events.length} public-org RBAC events are mirrored to Arkiv`)
ok(total > 0 && anchored === total, `all ${total} pushed commits are anchored (Arkiv + L1)`)
const [leak] = await sql`SELECT count(*)::int AS n FROM rbac_events WHERE org_id = ${privOrg.id} AND (arkiv_tx IS NOT NULL OR public)`
const [queued] = await sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'rbac' AND (payload->>'eventId')::bigint IN (SELECT id FROM rbac_events WHERE org_id = ${privOrg.id})`
ok(leak.n === 0 && queued.n === 0, 'private org events were never queued or sent on-chain')
await sql.close()
