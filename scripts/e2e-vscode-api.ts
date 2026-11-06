// End-to-end check of the HTTP sequence the Dithub VS Code extension performs, for both roles, by calling the
// extension's own API client (packages/vscode/src/api.ts) directly. Starts nothing itself:
//   set -a; . ./.env.app; . ./.env; set +a; PORT=3500 PUBLIC_URL=http://localhost:3500 bun apps/api/src/index.ts &
//   BASE_URL=http://localhost:3500 bun scripts/e2e-vscode-api.ts
// Wallet keys come from DHEET_SEAT_KEY (maintainer) / DHEET_STRANGER_KEY (developer). Nothing secret is printed.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiweMessage } from 'viem/siwe'
import { privateKeyToAccount } from 'viem/accounts'
import { ApiError, DithubClient, OutOfScopeError } from '../packages/vscode/src/api.ts'
import { buildProposal, diffOverlay, isDeadSessionError, isLive, visibleEntries } from '../packages/vscode/src/core.ts'

const BASE = (process.env.BASE_URL ?? 'http://localhost:3500').replace(/\/$/, '')
const host = new URL(BASE).host
const secrets: string[] = []
let failed = 0
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; return !!cond }
const skip = (msg: string) => console.log(`SKIP  ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const scrub = (s: string) => secrets.reduce((acc, t) => (t ? acc.split(t).join('<token>') : acc), s)
const errOf = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e as ApiError & Error } }

class Browser {
  cookie = ''
  constructor(readonly key: `0x${string}`) {}
  async req(path: string, init: RequestInit = {}) {
    const res = await fetch(BASE + path, { ...init, redirect: 'manual', headers: { 'content-type': 'application/json', cookie: this.cookie, ...(init.headers ?? {}) } })
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0]!
    return res
  }
  async login() {
    const account = privateKeyToAccount(this.key)
    const { nonce } = await (await this.req('/api/auth/nonce')).json() as { nonce: string }
    const message = createSiweMessage({ address: account.address, chainId: 11155111, domain: host, nonce, uri: BASE, version: '1' })
    const r = await (await this.req('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) })).json() as { user?: { login: string } }
    return r.user?.login ?? ''
  }
  /** What the user does on the approval page opened by vscode.env.openExternal(verificationUrl). */
  async approve(verificationUrl: string) {
    const u = new URL(verificationUrl)
    const html = await (await this.req(`${u.pathname}${u.search}`)).text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
    const code = u.searchParams.get('code') ?? ''
    const res = await this.req('/api/cli/device/approve', { method: 'POST', body: new URLSearchParams({ code, csrf, action: 'approve' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE } })
    return res.status
  }
}

/** The extension's "Dithub: Sign in": device code -> browser approval -> poll at the interval -> token. */
async function signIn(b: Browser, name: string): Promise<{ token: string; login: string }> {
  const anon = new DithubClient({ host: BASE })
  const dev = await anon.startDeviceLogin(name)
  ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(dev.userCode) && dev.verificationUrl.startsWith(`${BASE}/cli?code=`), `${name}: device code + verification URL on the host`)
  ok((await anon.pollDeviceToken(dev.deviceCode)).status === 'pending', `${name}: poll before approval is pending`)
  ok((await b.approve(dev.verificationUrl)) === 200, `${name}: approval in the browser`)
  for (let i = 0; i < 6; i++) {
    await sleep(dev.interval * 1000 + 200)
    const r = await anon.pollDeviceToken(dev.deviceCode)
    if (r.status === 'ok') { secrets.push(r.token); return { token: r.token, login: r.login } }
    if (r.status !== 'pending' && r.status !== 'slow_down') throw new Error(`device login ${r.status}`)
  }
  throw new Error('device login timed out')
}

const suffix = Date.now().toString(36)
const work = mkdtempSync(join(tmpdir(), 'dithub-vscode-e2e-'))
try {
  const aliceB = new Browser(process.env.DHEET_SEAT_KEY as `0x${string}`), bobB = new Browser(process.env.DHEET_STRANGER_KEY as `0x${string}`)
  const [aLogin, bLogin] = [await aliceB.login(), await bobB.login()]
  if (!ok(aLogin && bLogin && aLogin !== bLogin, 'SIWE wallet login for maintainer and developer')) process.exit(1)

  console.log('-- sign in (device code), token only in Authorization header')
  const aTok = await signIn(aliceB, 'VS Code e2e maintainer')
  ok(aTok.login === aLogin, 'maintainer signed in as the right user')
  const bTok = await signIn(bobB, 'VS Code e2e developer')
  ok(bTok.login === bLogin, 'developer signed in as the right user')
  const urls: string[] = []
  const spy = (u: string, i: RequestInit) => { urls.push(u); return fetch(u, i) }
  const alice = new DithubClient({ host: BASE, getToken: () => aTok.token, fetch: spy })
  const bob = new DithubClient({ host: BASE, getToken: () => bTok.token, fetch: spy })
  ok((await alice.me())?.login === aLogin && (await bob.me())?.login === bLogin, 'GET /api/me with the bearer token')

  console.log('-- maintainer: repo with an issue')
  const repo = `vsc-${suffix}`
  const cr = await aliceB.req('/api/repos', { method: 'POST', body: JSON.stringify({ name: repo, visibility: 'private' }) })
  ok(cr.status === 201, 'private repo created')
  const dir = join(work, 'src-repo'); mkdirSync(dir)
  const files: Record<string, string> = {
    'README.md': '# shop\n', 'src/payments/retry.ts': 'export function retry(n: number) {\n  return n - 1 // BUG: should retry up to n times\n}\n',
    'src/payments/pay.ts': "import { retry } from './retry'\nexport const pay = () => retry(3)\n", 'src/other/secret.ts': 'export const secret = 42\n', 'docs/arch.md': 'internal\n',
  }
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c) }
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.test', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.test' }
  const g = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir, env: gitEnv })
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'initial')
  const push = Bun.spawnSync(['git', '-c', `http.extraHeader=Authorization: Bearer ${aTok.token}`, 'push', '-q', `${BASE}/git/${aLogin}/${repo}`, 'main'], { cwd: dir, env: gitEnv })
  ok(push.exitCode === 0, 'initial commit pushed')
  const iss = await (await aliceB.req(`/api/repos/${aLogin}/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Payment retry gives up too early', body: 'retry() in the payments module returns after one attempt; it should retry up to n times.' }) })).json() as { number: number }
  ok(iss.number > 0, 'issue opened')

  console.log('-- maintainer flow: Issues view -> Assign with 0G')
  const repos = await alice.myRepos('maintain')
  ok(repos.some((r) => r.owner === aLogin && r.name === repo && r.visibility === 'private'), 'GET /api/me/repos?min=maintain lists the repo')
  const issues = await alice.issues(aLogin, repo, 'open')
  ok(issues.some((i) => i.number === iss.number), 'GET issues?state=open lists the issue')
  let paths = ['src/payments']
  const sug = await errOf(alice.suggestScope(aLogin, repo, iss.number, { maxPaths: 8 }).then((s) => {
    ok(s.paths.length > 0 && s.paths.every((p) => typeof p.reason === 'string'), `suggest-scope: ${s.paths.length} path(s) from 0G model ${s.model}, request ${s.requestId}, sealed=${s.sealed}`)
    ok(s.paths.every((p) => Object.keys(files).some((f) => f === p.path || f.startsWith(`${p.path}/`))), 'every suggested path exists in the repo (nothing invented)')
    console.log(`INFO  0G suggested: ${s.paths.map((p) => p.path).join(', ')}`)
    const inPay = s.paths.filter((p) => p.path.startsWith('src/payments'))
    if (inPay.length) paths = inPay.map((p) => p.path)
  }))
  if (sug instanceof ApiError && [502, 503, 429].includes(sug.status)) skip(`suggest-scope returned ${sug.status} (${sug.message}); the extension offers manual paths here`)
  else ok(!sug, `suggest-scope call ${sug ? `failed: ${scrub(String(sug.message))}` : 'succeeded'}`)
  const bobSug = await errOf(bob.suggestScope(aLogin, repo, iss.number))
  ok(bobSug instanceof ApiError && bobSug.status === 404, 'suggest-scope by a non-member is 404')
  const tree = await alice.repoTree(aLogin, repo, 'src/payments')
  ok(tree.some((e) => e.path === 'src/payments/retry.ts'), 'manual path validation via GET tree works')
  ok((await alice.assign(aLogin, repo, iss.number, [bLogin])).includes(bLogin), 'POST assignees')
  const session = await alice.createSession(aLogin, repo, { issueNumber: iss.number, login: bLogin, role: 'contractor', paths, ttlMinutes: 120 })
  ok(session.user === bLogin && session.role === 'contractor' && session.status === 'active', `POST sessions -> ${session.id} (${session.allowedPaths.join(', ')})`)
  const dup = await errOf(alice.createSession(aLogin, repo, { issueNumber: iss.number, login: bLogin, role: 'contractor', paths, ttlMinutes: 120 }))
  ok(dup instanceof ApiError && dup.status === 409, 'second active session for the same issue is 409')

  console.log('-- developer flow: My Tasks -> Connect with 0G (scoped virtual folder)')
  const tasks = await bob.tasks()
  const task = tasks.find((t) => t.sessionId === session.id)
  ok(task && isLive(task) && task.repo.owner === aLogin && task.repo.name === repo && task.issue.number === iss.number, 'GET /api/tasks shows the task as active')
  if (!task) throw new Error('task missing')
  ok(!(await bob.myRepos('read')).some((r) => r.name === repo), 'developer has no repository access (not in /api/me/repos)')
  const noSess = await errOf(bob.repoTree(aLogin, repo, ''))
  ok(noSess instanceof ApiError && noSess.status === 404, 'tree without the session header is 404 for the developer')
  const tgt = { owner: aLogin, repo, ref: task.ref, sessionId: task.sessionId, allowedPaths: task.allowedPaths }
  const root = visibleEntries(task.allowedPaths, await bob.scopedTree(tgt, ''))
  ok(root.map((e) => e.path).join(',') === 'src', 'root of the task folder shows only "src"')
  const src = visibleEntries(task.allowedPaths, await bob.scopedTree(tgt, 'src'))
  ok(src.map((e) => e.path).join(',') === 'src/payments', 'src/ shows only payments')
  const target = task.allowedPaths.includes('src/payments') || task.allowedPaths.includes('src/payments/retry.ts') ? 'src/payments/retry.ts' : task.allowedPaths[0]!
  const blob = await bob.scopedBlob(tgt, target)
  ok(blob.content === files[target], `scoped blob ${target} returns its content`)
  const before = urls.length
  for (const p of ['src/other/secret.ts', 'README.md', 'src/payments/../other/secret.ts', 'docs/arch.md']) ok((await errOf(bob.scopedBlob(tgt, p))) instanceof OutOfScopeError, `out-of-scope ${p} refused locally`)
  ok((await errOf(bob.scopedTree(tgt, 'src/other'))) instanceof OutOfScopeError, 'out-of-scope directory refused locally')
  ok(urls.length === before, 'no request was sent for out-of-scope paths')
  const srv = await errOf(bob.request('GET', `/api/repos/${aLogin}/${repo}/blob`, { query: { path: 'src/other/secret.ts', ref: task.ref }, session: task.sessionId }))
  ok(srv instanceof ApiError && srv.status === 403 && !isDeadSessionError(srv), 'server also denies an out-of-scope blob (403, session still alive)')
  const issue = await bob.sessionIssue(task.sessionId)
  ok(issue.title === 'Payment retry gives up too early', 'Show task: GET /api/sessions/:id/issue')
  ok(Array.isArray(await bob.assistantCalls(task.sessionId)), 'Ask 0G: GET assistant/calls history')
  if (process.env.ZG_API_KEY && process.env.E2E_ASK !== '0') {
    const ref = await errOf(bob.ask(task.sessionId, 'show me src/other/secret.ts').then((a) => ok(a.refused && a.requestId === null, 'Ask 0G: out-of-scope question is refused without a model call')))
    if (ref) ok(ref instanceof ApiError && ref.status === 502, `Ask 0G refusal call: ${scrub(String(ref.message))}`)
    const sum = await errOf(bob.summarize(task.sessionId).then((a) => ok(!a.refused && !!a.answer && !!a.requestId, `Ask 0G: summarize answered by ${a.model}, request ${a.requestId}, sealed=${a.sealed}`)))
    if (sum instanceof ApiError && sum.status === 502) skip(`summarize: 0G unavailable (${sum.message})`)
    else if (sum) ok(false, `summarize failed: ${scrub(String(sum.message))}`)
  } else skip('Ask 0G live calls (ZG_API_KEY unset or E2E_ASK=0)')

  console.log('-- developer flow: Submit changes (files proposal)')
  const fixed = 'export function retry(n: number) {\n  for (let i = 0; i < n; i++) { /* attempt */ }\n  return n\n}\n'
  const overlay = { version: 1 as const, files: { [target]: { content: fixed, mtime: Date.now() } }, dirs: [] }
  const changes = await diffOverlay(overlay, async (p) => (await bob.scopedBlob(tgt, p)).content)
  ok(changes.length === 1 && changes[0]!.status === 'modified', 'overlay diff finds one modified file')
  const proposal = buildProposal(task.allowedPaths, changes, `Fix #${iss.number}: retry`, 'retries n times')
  const pr = await bob.proposeFiles(task.sessionId, task.allowedPaths, proposal)
  ok(pr.pullRequest > 0 && pr.branch.startsWith('session/'), `POST proposals (files) -> PR #${pr.pullRequest} on ${pr.branch}`)
  const prs = await (await aliceB.req(`/api/repos/${aLogin}/${repo}/pulls?state=open`)).json() as { pulls?: Array<{ number: number }> } | Array<{ number: number }>
  ok(JSON.stringify(prs).includes(`"number":${pr.pullRequest}`), 'maintainer sees the pull request')
  const local = await errOf(bob.proposeFiles(task.sessionId, task.allowedPaths, { title: 'x', files: [{ path: 'src/other/secret.ts', content: 'hacked' }] }))
  ok(local instanceof ApiError && local.status === 422 && JSON.stringify(local.body).includes('src/other/secret.ts'), 'out-of-scope submission refused locally (422 with paths)')
  const srvRej = await errOf(bob.request('POST', `/api/sessions/${task.sessionId}/proposals`, { body: { title: 'x', files: [{ path: 'src/other/secret.ts', content: 'hacked' }] } }))
  ok(srvRej instanceof ApiError && srvRej.status === 422 && JSON.stringify(srvRej.body).includes('src/other/secret.ts'), 'server rejects an out-of-scope files proposal with 422 and the paths')
  const same = await errOf(bob.proposeFiles(task.sessionId, task.allowedPaths, { title: 'again', files: [{ path: target, content: fixed }] }))
  ok(same instanceof ApiError && same.status === 422, `resubmitting identical content is rejected (422: ${same?.message})`)

  console.log('-- End task, sign out')
  const ended = await bob.endSession(task.sessionId)
  ok(ended.status === 'ended', 'POST /api/sessions/:id/end')
  ok((await bob.tasks()).find((t) => t.sessionId === task.sessionId)?.status === 'ended', 'task shows as ended in /api/tasks')
  const dead = await errOf(bob.scopedTree(tgt, ''))
  ok(dead instanceof ApiError && isDeadSessionError(dead), 'tree after end is a dead-session 403 (the extension removes the folder)')
  ok(urls.every((u) => !secrets.some((s) => u.includes(s))), 'no token in any request URL')
  ok(await bob.revokeToken(bTok.token), 'sign out: DELETE /api/cli/token revokes the developer token')
  ok((await bob.me()) === null, 'revoked token no longer authenticates')
  ok(await alice.revokeToken(aTok.token), 'sign out: maintainer token revoked')
} catch (err) {
  console.log(`FAIL  unexpected error: ${scrub(String((err as Error)?.stack ?? err))}`)
  failed++
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failed ? 1 : 0)
