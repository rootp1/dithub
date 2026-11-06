// Black-box smoke test against a deployed instance. Needs only the public URL and a wallet key in the environment.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiweMessage } from 'viem/siwe'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE_URL!, host = new URL(BASE).host
const ok = (c: unknown, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1 }
let cookie = ''
const req = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } })
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
  return res
}
const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(['git', '-c', 'credential.helper=', ...a], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } }); return { code: r.exitCode, err: r.stderr.toString() } }

const html = await (await fetch(BASE + '/')).text(); ok(html.includes('<title>Dithub</title>'), 'web app is served over HTTPS')
const acct = privateKeyToAccount(process.env.DHEET_SEAT_KEY as `0x${string}`)
const { nonce } = await (await req('/api/auth/nonce')).json() as { nonce: string }
const message = createSiweMessage({ address: acct.address, chainId: 11155111, domain: host, nonce, uri: BASE, version: '1' })
const login = await (await req('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await acct.signMessage({ message }) }) })).json() as { user?: { login: string } }
ok(login.user?.login, 'SIWE wallet login against production')
const name = `smoke-${Date.now().toString(36)}`
const repo = await (await req('/api/repos', { method: 'POST', body: JSON.stringify({ name }) })).json() as { cloneUrl: string; repoId: string }
ok(repo.repoId, 'repository created')
const token = (await (await req('/api/tokens', { method: 'POST', body: '{"name":"smoke"}' })).json() as { token: string }).token
const work = mkdtempSync(join(tmpdir(), 'dheet-smoke-')); git(work, 'init', '-q', '-b', 'main')
writeFileSync(join(work, 'hello.txt'), 'hello from production\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'smoke: first commit')
ok(git(work, 'push', repo.cloneUrl, 'main').code !== 0, 'anonymous push refused')
const push = git(work, 'push', repo.cloneUrl.replace('https://', `https://x:${token}@`), 'main'); ok(push.code === 0, 'authenticated push over HTTPS')
ok(git(work, 'clone', '-q', repo.cloneUrl, join(work, 'c')).code === 0, 'anonymous clone of public repo')
const owner = login.user!.login
const deadline = Date.now() + 420_000; let c: any
while (Date.now() < deadline) {
  c = ((await (await req(`/api/repos/${owner}/${name}/commits`)).json()) as any).commits?.[0]
  if (c?.anchor?.status === 'anchored') break
  await Bun.sleep(6000)
}
ok(c?.anchor?.status === 'anchored', 'commit anchored (Arkiv + L1) by the production worker')
ok(c?.anchor?.l1Tx && c?.anchor?.arkivTx, `commit maps to L1 tx ${c?.anchor?.l1Tx?.slice(0, 14)}… and Arkiv tx ${c?.anchor?.arkivTx?.slice(0, 14)}…`)
// Leave no credential behind: revoke the token this run created.
await fetch(`${BASE}/api/cli/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
