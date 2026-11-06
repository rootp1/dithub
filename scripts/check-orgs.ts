// Checks GET /api/me/orgs: lists exactly the orgs the caller belongs to, with role and counts.
import { createSiweMessage } from 'viem/siwe'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const BASE = process.env.BASE_URL ?? 'http://localhost:3000', host = new URL(BASE).host
const ok = (c: unknown, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1 }
class U {
  cookie = ''; acct = privateKeyToAccount(generatePrivateKey()); login = ''
  async req(path: string, init: RequestInit = {}) { const r = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie: this.cookie, ...(init.headers ?? {}) } }); const s = r.headers.get('set-cookie'); if (s) this.cookie = s.split(';')[0]!; return r }
  async signIn() { const { nonce } = await (await this.req('/api/auth/nonce')).json() as { nonce: string }; const message = createSiweMessage({ address: this.acct.address, chainId: 11155111, domain: host, nonce, uri: BASE, version: '1' }); const r = await (await this.req('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await this.acct.signMessage({ message }) }) })).json() as { user: { login: string } }; this.login = r.user.login }
  orgs = async () => (await (await this.req('/api/me/orgs')).json() as { orgs: { login: string; visibility: string; role: string; members: number; repos: number }[] }).orgs
}
const a = new U(), b = new U(); await a.signIn(); await b.signIn()
const sfx = Date.now().toString(36)
ok((await new U().req('/api/me/orgs')).status === 401, 'anonymous gets 401')
ok((await a.orgs()).length === 0, 'new user has no organisations')
const pub = `col-pub-${sfx}`, priv = `col-priv-${sfx}`
await a.req('/api/orgs', { method: 'POST', body: JSON.stringify({ login: pub, visibility: 'public' }) })
await a.req('/api/orgs', { method: 'POST', body: JSON.stringify({ login: priv, visibility: 'private' }) })
await a.req('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'one', org: pub }) })
await a.req('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'two', org: pub }) })
const mine = await a.orgs()
ok(mine.length === 2, 'creator sees both organisations (public and private)')
const p = mine.find((o) => o.login === pub), q = mine.find((o) => o.login === priv)
ok(p?.role === 'owner' && p.visibility === 'public' && p.members === 1 && p.repos === 2, `public org: owner, 1 member, 2 repos (${JSON.stringify(p)})`)
ok(q?.role === 'owner' && q.visibility === 'private' && q.repos === 0, 'private org: owner, 0 repos')
ok((await b.orgs()).length === 0, 'another user sees none of them')
await a.req(`/api/orgs/${priv}/members/${b.login}`, { method: 'PUT', body: '{"role":"member"}' })
const bOrgs = await b.orgs()
ok(bOrgs.length === 1 && bOrgs[0]!.login === priv && bOrgs[0]!.role === 'member' && bOrgs[0]!.members === 2, 'added member sees the private org with role member and 2 members')
await a.req(`/api/orgs/${priv}/members/${b.login}`, { method: 'DELETE' })
ok((await b.orgs()).length === 0, 'removed member no longer sees it')
