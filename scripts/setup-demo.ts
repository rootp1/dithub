// Sets up the maintainer + intern demo on a Dithub host. Idempotent: safe to re-run.
//   - signs in as the maintainer (DHEET_PRIVATE_KEY, the rootp1 wallet)
//   - creates a private repo with a small realistic codebase and pushes it over git smart HTTP
//   - creates a set of open issues (skips ones that already exist by title)
//   - if act2_priv_key is set: signs the intern in (creating the account) and sets the intern's username
// Nothing secret is printed; the push token is passed to git through environment config, never argv or the URL.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSiweMessage } from 'viem/siwe'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE_URL ?? 'https://dithub.app'
const host = new URL(BASE).host
const REPO = process.env.DEMO_REPO ?? 'payments-service'
const INTERN_LOGIN = process.env.INTERN_LOGIN ?? 'rootp1-intern'
const hexKey = (v: string | undefined) => (v ? ((v.trim().startsWith('0x') ? v.trim() : `0x${v.trim()}`) as `0x${string}`) : undefined)

class Client {
  cookie = ''
  constructor(readonly key: `0x${string}`) {}
  async req(path: string, init: RequestInit = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie: this.cookie, ...(init.headers ?? {}) } })
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0]!
    return res
  }
  async json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.req(path, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    return body as T
  }
  async login() {
    const account = privateKeyToAccount(this.key)
    const { nonce } = await this.json<{ nonce: string }>('/api/auth/nonce')
    const message = createSiweMessage({ address: account.address, chainId: 11155111, domain: host, nonce, uri: BASE, version: '1' })
    const r = await this.json<{ user: { id: number; login: string } }>('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) })
    return { ...r.user, address: account.address }
  }
}

const FILES: Record<string, string> = {
  'README.md': '# payments-service\n\nCharges, retries, refunds and notifications for the shop backend.\n',
  'package.json': JSON.stringify({ name: 'payments-service', version: '0.1.0', type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n',
  'src/payments/charge.ts': `import { retry } from './retry'\n\nexport interface Charge { id: string; amountCents: number; currency: string; customerId: string }\n\nexport async function charge(c: Charge, gateway: (c: Charge) => Promise<{ ok: boolean; code?: string }>) {\n  // TODO: retries are fixed-interval today, see retry.ts\n  return retry(() => gateway(c), 3)\n}\n`,
  'src/payments/retry.ts': `export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs = 500): Promise<T> {\n  let last: unknown\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn() } catch (e) { last = e; await new Promise((r) => setTimeout(r, delayMs)) }\n  }\n  throw last\n}\n`,
  'src/payments/refund.ts': `import type { Charge } from './charge'\n\n/** Full refunds only for now. */\nexport function refund(c: Charge) {\n  return { chargeId: c.id, amountCents: c.amountCents, status: 'pending' as const }\n}\n`,
  'src/auth/login.ts': `export async function login(email: string, password: string, verify: (e: string, p: string) => Promise<boolean>) {\n  // no rate limiting yet\n  return verify(email, password)\n}\n`,
  'src/auth/session.ts': `export function newSession(userId: string) {\n  return { userId, token: crypto.randomUUID(), expiresAt: Date.now() + 86_400_000 }\n}\n`,
  'src/notifications/email.ts': `export async function sendEmail(to: string, subject: string, body: string) {\n  console.log('email', { to, subject, length: body.length })\n}\n`,
  'src/ui/button.tsx': `export function Button(props: { label: string; onClick: () => void }) {\n  return <button onClick={props.onClick}>{props.label}</button>\n}\n`,
  'src/ui/checkout-form.tsx': `import { Button } from './button'\n\nexport function CheckoutForm(props: { onPay: () => void }) {\n  return <form><Button label="Pay" onClick={props.onPay} /></form>\n}\n`,
  'docs/architecture.md': '# Architecture\n\n- payments: charge, retry, refund\n- auth: login, sessions\n- notifications: email\n- ui: checkout form components\n',
}

const ISSUES = [
  { title: 'Add exponential backoff to payment retries', body: 'retry() in src/payments/retry.ts waits a fixed 500 ms between attempts. Use exponential backoff with jitter (base 200 ms, max 5 s) and make the attempt count configurable from charge().' },
  { title: 'Support partial refunds', body: 'refund() only does full refunds. Accept an optional amountCents, reject amounts above the original charge, and return the remaining refundable balance.' },
  { title: 'Rate-limit login attempts', body: 'login() has no rate limiting. Lock an email for 15 minutes after 5 failed attempts within 10 minutes.' },
  { title: 'Email the customer when a payment fails', body: 'When charge() gives up after its retries, send an email via src/notifications/email.ts with the failure reason.' },
  { title: 'Button: add a loading state', body: 'The Pay button can be clicked twice. Add a loading prop to Button that disables it and shows a spinner, and use it in CheckoutForm.' },
]

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['git', '-c', 'credential.helper=', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } })
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().slice(0, 300)}`)
  return r.stdout.toString()
}

const maintainerKey = hexKey(process.env.DHEET_PRIVATE_KEY)
if (!maintainerKey) throw new Error('DHEET_PRIVATE_KEY (maintainer wallet) is not set')
const m = new Client(maintainerKey)
const me = await m.login()
console.log(`maintainer: ${me.login} (${me.address})`)

let repo: { owner: string; name: string; cloneUrl: string }
const existing = await m.req(`/api/repos/${me.login}/${REPO}`)
if (existing.ok) {
  const r = await existing.json() as { owner: string; name: string; cloneUrl: string }
  repo = r
  console.log(`repo exists: ${r.owner}/${r.name}`)
} else {
  const r = await m.json('/api/repos', { method: 'POST', body: JSON.stringify({ name: REPO, visibility: 'private', description: 'Charges, retries, refunds and notifications (demo for task-scoped interns)' }) })
  repo = { owner: r.owner, name: r.name, cloneUrl: r.cloneUrl }
  console.log(`repo created (private): ${r.owner}/${r.name}`)
}

const detail = await m.json(`/api/repos/${repo.owner}/${repo.name}`) as { refs: { name: string }[] }
if (detail.refs.length === 0) {
  const { token } = await m.json<{ token: string }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'setup-demo push' }) })
  const work = mkdtempSync(join(tmpdir(), 'dithub-demo-'))
  for (const [path, content] of Object.entries(FILES)) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), content) }
  const id = { GIT_AUTHOR_NAME: me.login, GIT_AUTHOR_EMAIL: `${me.login}@users.noreply.dithub`, GIT_COMMITTER_NAME: me.login, GIT_COMMITTER_EMAIL: `${me.login}@users.noreply.dithub` }
  git(work, ['init', '-q', '-b', 'main']); git(work, ['add', '.']); git(work, ['commit', '-qm', 'Initial payments service'], id)
  const auth = Buffer.from(`x:${token}`).toString('base64')
  git(work, ['push', '-q', repo.cloneUrl, 'main'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${BASE}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}` })
  console.log(`pushed ${Object.keys(FILES).length} files to ${repo.owner}/${repo.name}`)
  // The push token was only needed for this one push: revoke it so no credential is left behind.
  const revoked = await fetch(`${BASE}/api/cli/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
  console.log(revoked.ok ? 'push token revoked' : `warning: could not revoke the push token (${revoked.status})`)
} else console.log('code already pushed')

const open = await m.json<{ issues: { number: number; title: string }[] }>(`/api/repos/${repo.owner}/${repo.name}/issues?state=all&per_page=100`)
for (const i of ISSUES) {
  const found = open.issues.find((x) => x.title === i.title)
  if (found) { console.log(`issue #${found.number} exists: ${i.title}`); continue }
  const created = await m.json<{ number: number }>(`/api/repos/${repo.owner}/${repo.name}/issues`, { method: 'POST', body: JSON.stringify(i) })
  console.log(`issue #${created.number} created: ${i.title}`)
}

const internKey = hexKey(process.env.act2_priv_key)
if (!internKey) {
  console.log('intern: act2_priv_key not set yet; add it to .env and re-run to create the intern account')
} else {
  const intern = new Client(internKey)
  const u = await intern.login()
  if (u.login !== INTERN_LOGIN) {
    const r = await intern.req('/api/me', { method: 'PATCH', body: JSON.stringify({ login: INTERN_LOGIN }) })
    console.log(r.ok ? `intern username set: ${INTERN_LOGIN} (${u.address})` : `intern username not changed (${r.status}): ${await r.text()}`)
  } else console.log(`intern account ready: ${u.login} (${u.address})`)
  const access = await intern.req(`/api/repos/${repo.owner}/${repo.name}`)
  console.log(`intern direct repo access: ${access.status === 200 ? 'YES (unexpected)' : `none (${access.status}), as intended`}`)
}
