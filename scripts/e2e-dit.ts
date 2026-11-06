// End-to-end check of the `dit` CLI against a running API (default http://localhost:3300). Starts nothing itself.
//   set -a; . ./.env.app; . ./.env; set +a; PORT=3300 PUBLIC_URL=http://localhost:3300 bun apps/api/src/index.ts &
//   BASE_URL=http://localhost:3300 bun scripts/e2e-dit.ts
// Keys come from DHEET_SEAT_KEY / DHEET_STRANGER_KEY; nothing secret is printed. Set DIT_BIN to test the compiled binary.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSiweMessage } from 'viem/siwe'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = (process.env.BASE_URL ?? 'http://localhost:3300').replace(/\/$/, '')
const host = new URL(BASE).host
let last = ''
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) { process.exitCode = 1; if (last) console.log(`      last output: ${last.replace(/\s+/g, ' ').slice(0, 400)}`) } return !!cond }
const root = resolve(import.meta.dir, '..')
const DIT = process.env.DIT_BIN ? resolve(process.env.DIT_BIN) : join(root, 'bin/dit')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

// ---- isolated environments (own HOME and DIT_CONFIG_DIR per user; no secret env vars leak to the child) ----
const work = mkdtempSync(join(tmpdir(), 'dit-e2e-'))
const binDir = join(work, 'bin'); mkdirSync(binDir)
writeFileSync(join(binDir, 'dit'), `#!/bin/sh\nexec ${DIT.endsWith('.ts') || DIT.endsWith('/dit') && !process.env.DIT_BIN ? `"${DIT}"` : `"${DIT}"`} "$@"\n`); chmodSync(join(binDir, 'dit'), 0o755)
function mkEnv(name: string) {
  const home = join(work, `home-${name}`); mkdirSync(home, { recursive: true })
  const gitcfg = join(home, '.gitconfig'); writeFileSync(gitcfg, `[user]\n\tname = ${name}\n\temail = ${name}@example.test\n[init]\n\tdefaultBranch = main\n`)
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH}`, HOME: home, DIT_CONFIG_DIR: join(home, 'dit'), DIT_HOST: BASE, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitcfg,
    GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', TERM: 'dumb',
  }
  return { home, env, cfg: env.DIT_CONFIG_DIR! }
}
const A = mkEnv('alice'), B = mkEnv('bob'), ANON = mkEnv('anon')
const secrets: string[] = []
let bobTok = ''

function dit(who: { env: Record<string, string> }, args: string[], o: { cwd?: string; input?: string } = {}) {
  const r = Bun.spawnSync([DIT, ...args], { cwd: o.cwd ?? work, env: who.env, ...(o.input !== undefined ? { stdin: Buffer.from(o.input) } : {}), timeout: 180_000 })
  const out = r.stdout.toString(), err = r.stderr.toString()
  last = `[dit ${args.join(' ')}] exit ${r.exitCode} ` + (out + err)
  return { code: r.exitCode ?? 1, out, err, all: out + err }
}
function git(who: { env: Record<string, string> }, cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: who.env, timeout: 120_000 })
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString(), all: r.stdout.toString() + r.stderr.toString() }
}
const leaks = (text: string) => secrets.filter((s) => s && text.includes(s))
const noLeak = (text: string, what: string) => ok(leaks(text).length === 0, `no token in ${what}`)
const jsonOf = (s: string) => { try { return JSON.parse(s) } catch { return null } }

const suffix = Date.now().toString(36)
const alice = new Client(process.env.DHEET_SEAT_KEY as `0x${string}`), bob = new Client(process.env.DHEET_STRANGER_KEY as `0x${string}`)
const [ra, rb] = [await alice.login(), await bob.login()]
if (!ok(ra.user?.id && rb.user?.id, 'SIWE wallet login for two users')) process.exit(1)
const aLogin = ra.user!.login, bLogin = rb.user!.login

// =================== device login flow ===================
console.log('-- authentication')
{
  const p = Bun.spawn([DIT, 'login', '--no-browser'], { cwd: work, env: A.env, stdout: 'pipe', stderr: 'pipe' })
  const chunks: string[] = []
  const pump = async (s: ReadableStream) => { for await (const c of s as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c).toString()) }
  void pump(p.stdout as ReadableStream); void pump(p.stderr as ReadableStream)
  let code = ''
  for (let i = 0; i < 50 && !code; i++) { await sleep(100); code = /\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/.exec(chunks.join(''))?.[1] ?? '' }
  ok(!!code, 'dit login prints a one-time code and URL')
  ok(chunks.join('').includes(`${BASE}/cli?code=${code}`), 'verification URL points at the host')

  const noCookie = await fetch(`${BASE}/cli?code=${code}`)
  ok((await noCookie.text()).includes('Sign in first'), 'approval page asks anonymous visitors to sign in first')
  const xss = await (await fetch(`${BASE}/cli?code=%3Cscript%3Ealert(1)%3C/script%3E`)).text()
  ok(!xss.includes('<script>alert') && xss.includes('&lt;script&gt;'), 'approval page HTML-escapes the code parameter')
  const page = await alice.req(`/cli?code=${code}`)
  const html = await page.text()
  ok(html.includes(`Approve dit on ${host} as ${aLogin}`), 'signed-in visitor sees "Approve dit on <host> as <login>"')
  ok((page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), 'approval page sends a strict CSP')
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
  const form = (c: string, k: string) => new URLSearchParams({ code: c, csrf: k, action: 'approve' }).toString()
  const post = (cl: Client, body: string, origin?: string) => cl.req('/api/cli/device/approve', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) } })
  ok((await post(alice, form(code, csrf))).status === 403, 'approval without an Origin header is refused')
  ok((await post(alice, form(code, csrf), 'https://evil.example')).status === 403, 'cross-origin approval is refused')
  ok((await post(bob, form(code, csrf), BASE)).status === 400, "another user's session cannot use this page's CSRF value")
  ok((await post(alice, form(code, 'wrong'), BASE)).status === 400, 'wrong CSRF value is refused')
  ok((await post(alice, form(code, csrf), BASE)).status === 200, 'same-origin approval with cookie + CSRF succeeds')
  ok((await post(alice, form(code, csrf), BASE)).status === 400, 'the code is single-use')
  const exit = await Promise.race([p.exited, sleep(40_000).then(() => -1)])
  ok(exit === 0, 'dit login completes after approval')
  ok(leaks(chunks.join('')).length === 0 && !/dht_/.test(chunks.join('')), 'dit login output contains no token')
  const credFile = join(A.cfg, 'credentials.json')
  ok(existsSync(credFile) && (statSync(credFile).mode & 0o777) === 0o600, 'credentials.json is mode 0600')
  ok((statSync(A.cfg).mode & 0o777) === 0o700, 'config directory is mode 0700')
  const tokA = Object.values(jsonOf(readFileSync(credFile, 'utf8'))?.hosts ?? {}).map((h) => (h as { token: string }).token)[0] ?? ''
  secrets.push(tokA)
  ok(tokA.startsWith('dht_'), 'a personal access token was stored')
  const w = dit(A, ['whoami']); ok(w.code === 0 && w.out.trim() === aLogin, 'dit whoami prints the login'); noLeak(w.all, 'whoami output')
  const st = dit(A, ['auth', 'status']); ok(st.code === 0 && st.out.includes('logged in'), 'dit auth status'); noLeak(st.all, 'auth status output')
}
{ // raw API: token handed out exactly once; expired/unknown codes; polling limits
  const d = await (await fetch(`${BASE}/api/cli/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { deviceCode: string; userCode: string }
  const poll = () => fetch(`${BASE}/api/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: d.deviceCode }) })
  const first = await poll(); ok(first.status === 400 && (await first.json() as { error: string }).error === 'authorization_pending', 'polling before approval answers authorization_pending')
  ok((await poll()).status === 429, 'polling faster than the interval is told to slow down')
  const html = await (await alice.req(`/cli?code=${d.userCode}`)).text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!
  await alice.req('/api/cli/device/approve', { method: 'POST', body: new URLSearchParams({ code: d.userCode, csrf, action: 'approve' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE } })
  await sleep(5200)
  const got = await poll(); const gj = await got.json() as { token?: string }
  ok(got.status === 200 && !!gj.token, 'approved device code yields a token'); if (gj.token) secrets.push(gj.token)
  const again = await poll(); ok(again.status === 400, 'the token is delivered exactly once')
  ok((await fetch(`${BASE}/api/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: 'x'.repeat(43) }) })).status === 400, 'unknown device code is rejected')
}
{ // CI-style login for bob: token on stdin
  const tokB = ((await (await bob.req('/api/tokens', { method: 'POST', body: '{"name":"e2e-b"}' })).json()) as { token: string }).token
  secrets.push(tokB); bobTok = tokB
  const r = dit(B, ['login', '--token-stdin'], { input: tokB + '\n' })
  ok(r.code === 0, 'dit login --token-stdin'); noLeak(r.all, 'token-stdin output')
  const w = dit(B, ['whoami']); ok(w.code === 0 && w.out.trim() === bLogin, 'bob whoami')
  const anon = dit(ANON, ['whoami']); ok(anon.code === 1 && /dit login/.test(anon.err), 'whoami when logged out exits 1 and suggests dit login')
  const envTok = dit({ env: { ...ANON.env, DIT_TOKEN: tokB } }, ['whoami']); ok(envTok.code === 0 && envTok.out.trim() === bLogin, 'DIT_TOKEN works without a credentials file')
}

// =================== repos + git ===================
console.log('-- repositories and git')
const repoName = `dit-${suffix}`, slug = `${aLogin}/${repoName}`
const projName = `proj-${suffix}`
const proj = join(work, projName); mkdirSync(proj)
{
  const init = dit(A, ['init', '--remote', '--private', '--description', 'dit e2e'], { cwd: proj })
  // init takes the folder name for the repo; the folder is "proj", so use that name in later steps
  ok(init.code === 0, 'dit init --remote creates a repo and an origin remote'); noLeak(init.all, 'init output')
}
const projSlug = `${aLogin}/${projName}`
void repoName; void slug
let projRepo = projSlug
{
  const cfg = readFileSync(join(proj, '.git/config'), 'utf8')
  ok(cfg.includes(`${BASE}/git/${projRepo}`) && !cfg.includes('@'), 'origin URL has no credentials')
  const files: Record<string, string> = { 'README.md': '# e2e\n', 'src/payments/pay.ts': 'export const pay = () => 1\n', 'src/other/secret.ts': 'export const secret = 42\n' }
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(proj, f, '..'), { recursive: true }); writeFileSync(join(proj, f), c) }
  ok(dit(A, ['add', '-A'], { cwd: proj }).code === 0, 'dit add passes through to git')
  ok(dit(A, ['commit', '-qm', 'initial'], { cwd: proj }).code === 0, 'dit commit passes through to git')
  const push = dit(A, ['push', '-u', 'origin', 'main'], { cwd: proj })
  ok(push.code === 0, 'dit push over the platform'); noLeak(push.all, 'push output')
  ok(dit(A, ['status', '-sb'], { cwd: proj }).out.includes('## main...origin/main'), 'dit status shows tracking branch')
  const second = join(work, 'second'); mkdirSync(second); git(A, second, 'init', '-q', '-b', 'main'); writeFileSync(join(second, 'a.txt'), 'a'); git(A, second, 'add', '-A'); git(A, second, 'commit', '-qm', 'a')
  const rc = dit(A, ['repo', 'create', `second-${suffix}`, '--push'], { cwd: second })
  ok(rc.code === 0 && git(A, second, 'remote', 'get-url', 'origin').out.includes(`/git/${aLogin}/second-${suffix}`), 'dit repo create inside a git repo adds origin and pushes')
  const list = jsonOf(dit(A, ['repo', 'list', '--json']).out) as Array<{ owner: string; name: string }> | null
  ok(!!list?.some((r) => r.owner === aLogin && r.name === projName), 'dit repo list --json')
  const view = dit(A, ['repo', 'view'], { cwd: proj }); ok(view.code === 0 && view.out.includes(projRepo), 'dit repo view infers the repo from origin')
}

const clone = join(work, 'clone')
{
  const plainClone = join(work, 'plain-clone')
  const gc = git(A, work, 'clone', `${BASE}/git/${projRepo}`, plainClone)
  ok(gc.code === 0 && existsSync(join(plainClone, 'src/payments/pay.ts')), 'plain `git clone` authenticates after `dit login`'); noLeak(gc.all, 'plain git clone output')
  writeFileSync(join(plainClone, 'from-plain-git.txt'), 'standard git only\n'); git(A, plainClone, 'add', '-A'); git(A, plainClone, 'commit', '-qm', 'plain git workflow')
  const gp = git(A, plainClone, 'push'); ok(gp.code === 0, 'plain `git add/commit/push` completes the source-control workflow'); noLeak(gp.all, 'plain git workflow output')

  const c = dit(A, ['clone', projRepo, clone])
  ok(c.code === 0 && existsSync(join(clone, 'src/payments/pay.ts')), 'dit clone owner/repo works (private repo)'); noLeak(c.all, 'clone output')
  const cfg = readFileSync(join(clone, '.git/config'), 'utf8')
  noLeak(cfg, '.git/config'); ok(!/dht_/.test(cfg) && !/Authorization|extraheader/i.test(cfg), '.git/config has no token or auth header')
  ok(cfg.includes(`[credential "${BASE}"]`) && cfg.includes('helper = !dit credential'), '.git/config uses the dit credential helper')
  noLeak(git(A, clone, 'config', '--list', '--show-origin').all, '`git config --list`')
  noLeak(git(A, clone, 'remote', '-v').all, '`git remote -v`')
  writeFileSync(join(clone, 'plain.txt'), 'plain git push\n'); git(A, clone, 'add', '-A'); git(A, clone, 'commit', '-qm', 'plain push')
  const pp = git(A, clone, 'push'); ok(pp.code === 0, 'plain `git push` works in the clone (credential helper)'); noLeak(pp.all, 'plain git push output')
  const pl = git(A, clone, 'pull'); ok(pl.code === 0, 'plain `git pull` works in the clone')
  const noauth = dit(ANON, ['clone', projRepo, join(work, 'anon-clone')]); ok(noauth.code === 1 && /not found|dit login/.test(noauth.all), 'anonymous clone of a private repo fails with a clear message')
  const bobClone = dit(B, ['clone', projRepo, join(work, 'bob-clone')]); ok(bobClone.code === 1 && /not found/.test(bobClone.all), 'a user without access cannot clone (404)')
  const shallow = dit(A, ['clone', projRepo, join(work, 'shallow'), '--depth', '1', '-b', 'main']); ok(shallow.code === 0 && existsSync(join(work, 'shallow/README.md')), 'clone passes git flags through (--depth, -b)')
  const byUrl = dit(A, ['clone', `${BASE}/git/${projRepo}.git`, join(work, 'by-url')]); ok(byUrl.code === 0, 'clone by full URL')
}

// =================== issues ===================
console.log('-- issues')
let issueNo = 0
{
  await alice.req(`/api/repos/${projRepo}/labels`, { method: 'POST', body: JSON.stringify({ name: 'bug', color: 'ff0000' }) })
  const cr = dit(A, ['issue', 'create', '-t', 'Payments retry is broken', '-b', 'steps to reproduce', '--json'], { cwd: clone })
  const iss = jsonOf(cr.out) as { number: number } | null
  ok(cr.code === 0 && !!iss?.number, 'dit issue create -t -b'); issueNo = iss?.number ?? 0
  const ls = jsonOf(dit(A, ['issue', 'list', '--json'], { cwd: clone }).out) as Array<{ number: number }> | null
  ok(!!ls?.some((i) => i.number === issueNo), 'dit issue list --json')
  ok(dit(A, ['issue', 'view', String(issueNo)], { cwd: clone }).out.includes('Payments retry is broken'), 'dit issue view')
  ok(dit(A, ['issue', 'comment', String(issueNo), '-b', 'looking into it'], { cwd: clone }).code === 0, 'dit issue comment')
  ok(dit(A, ['issue', 'label', String(issueNo), 'bug'], { cwd: clone }).all.includes('bug'), 'dit issue label')
  ok(dit(A, ['issue', 'assign', String(issueNo), aLogin], { cwd: clone }).all.includes(aLogin), 'dit issue assign')
  ok(dit(A, ['issue', 'close', String(issueNo)], { cwd: clone }).all.includes('closed'), 'dit issue close')
  ok(/now open/.test(dit(A, ['issue', 'reopen', String(issueNo)], { cwd: clone }).all), 'dit issue reopen')
  const bad = dit(A, ['issue', 'label', String(issueNo), 'no-such-label'], { cwd: clone }); ok(bad.code === 1 && /unknown label/.test(bad.err), 'API reason (unknown label) surfaces with exit 1')
  console.log('-- labels, edits, browsing')
  ok(dit(A, ['label', 'create', 'feat', '--color', '00ff00', '-d', 'new things'], { cwd: clone }).code === 0, 'dit label create')
  ok(dit(A, ['label', 'list', '--json'], { cwd: clone }).out.includes('"feat"'), 'dit label list')
  ok(dit(A, ['label', 'edit', 'feat', '--color', '0000ff'], { cwd: clone }).code === 0 && dit(A, ['label', 'list', '--json'], { cwd: clone }).out.includes('0000ff'), 'dit label edit')
  ok(dit(A, ['label', 'delete', 'feat'], { cwd: clone }).code === 0 && !dit(A, ['label', 'list', '--json'], { cwd: clone }).out.includes('"feat"'), 'dit label delete')
  ok(dit(A, ['issue', 'edit', String(issueNo), '-t', 'Payments retry is really broken'], { cwd: clone }).code === 0 && dit(A, ['issue', 'view', String(issueNo)], { cwd: clone }).out.includes('really broken'), 'dit issue edit')
  ok(dit(A, ['issue', 'events', String(issueNo)], { cwd: clone }).out.includes('opened'), 'dit issue events')
  const withComments = jsonOf(dit(A, ['issue', 'view', String(issueNo), '--json'], { cwd: clone }).out) as { commentList: Array<{ id: number; body: string }> } | null
  const cid = withComments?.commentList?.[0]?.id ?? 0
  ok(cid > 0 && dit(A, ['issue', 'comment', 'edit', String(cid), '-b', 'edited comment'], { cwd: clone }).code === 0 && dit(A, ['issue', 'view', String(issueNo), '--comments'], { cwd: clone }).out.includes('edited comment'), 'dit issue comment edit')
  ok(dit(A, ['issue', 'comment', 'delete', String(cid)], { cwd: clone }).code === 0 && !dit(A, ['issue', 'view', String(issueNo), '--comments'], { cwd: clone }).out.includes('edited comment'), 'dit issue comment delete')
  const lsB = dit(B, ['repo', 'ls', '-R', projRepo]); ok(lsB.code === 1, 'repo ls on a private repo without access fails (no session header, normal permissions)')
  const rls = dit(A, ['repo', 'ls'], { cwd: clone }); ok(rls.code === 0 && rls.out.includes('README.md') && rls.out.includes('src/'), 'dit repo ls (no clone needed)')
  ok(dit(A, ['repo', 'ls', 'src/payments'], { cwd: clone }).out.includes('pay.ts'), 'dit repo ls <path>')
  ok(dit(A, ['repo', 'cat', 'src/payments/pay.ts'], { cwd: clone }).out.includes('export const pay'), 'dit repo cat')
  const rc = dit(A, ['repo', 'commits', '--json'], { cwd: clone }); const commits = jsonOf(rc.out) as Array<{ oid: string; anchor: { status: string } }> | null
  ok(!!commits?.length && commits.every((x) => typeof x.anchor?.status === 'string'), 'dit repo commits --json has anchor status')
  ok(/COMMIT\s+SUBJECT/.test(dit(A, ['repo', 'commits'], { cwd: clone }).out), 'dit repo commits table')
  const led = dit(A, ['repo', 'ledger'], { cwd: clone }); ok(led.code === 0 && led.out.includes('L1 anchors') && led.out.includes('Arkiv entities'), 'dit repo ledger')
  const nm = dit(A, ['name', 'resolve', projRepo]); ok(nm.code === 0 && /repoId:\s+0x[0-9a-f]{64}/.test(nm.out), 'dit name resolve prints the repo id')
  ok(dit(A, ['name', 'resolve', `${aLogin}/nope-${suffix}`]).code === 1, 'dit name resolve of an unknown name fails')
  const dep = dit(A, ['deployments', '--json']); ok(dep.code === 0 ? /"source"/.test(dep.out) : /unavailable|server error/.test(dep.err), 'dit deployments (list or a clean 503 when Arkiv is unreachable)')
  const depl = dit(A, ['deployments', 'latest', '--json']); ok(depl.code === 0 ? /"deployment"/.test(depl.out) : /unavailable|server error|not found/.test(depl.err), 'dit deployments latest')
  const tk = dit(A, ['token', 'create', '--name', 'e2e-extra']); const extra = tk.out.trim()
  ok(tk.code === 0 && extra.startsWith('dht_'), 'dit token create prints the token when stdout is not a TTY'); secrets.push(extra)
  ok(dit({ env: { ...ANON.env, DIT_TOKEN: extra } }, ['whoami']).out.trim() === aLogin, 'the new token works')
  const tf = join(work, 'tok.txt'); const tk2 = dit(A, ['token', 'create', '--out', tf]); const tokFromFile = readFileSync(tf, 'utf8').trim(); secrets.push(tokFromFile)
  ok(tk2.code === 0 && (statSync(tf).mode & 0o777) === 0o600 && !tk2.all.includes(tokFromFile), 'dit token create --out writes a 0600 file and prints nothing secret')
  noLeak(tk.err + tk2.all, 'token create diagnostics')
  const rb = dit(A, ['verify', 'rebuild', '--sandbox', 'none']); ok(rb.code === 2 && /unsafe-local-build/.test(rb.all), 'verify rebuild: --sandbox none alone is a usage error')
  const rb2 = dit(A, ['verify', 'rebuild', '--release', '2', '--commit', 'a'.repeat(40)]); ok(rb2.code === 2, 'verify rebuild: --release and --commit are exclusive')
  const rec0 = dit(A, ['recover', 'x/y']); ok(rec0.code === 2 && /access-keys/.test(rec0.all), 'dit recover without an Arkiv key explains where to get one')
  const noRepo = dit(A, ['issue', 'list'], { cwd: work }); ok(noRepo.code === 2, 'no repo to infer is a usage error (exit 2)')
}

// =================== pull requests ===================
console.log('-- pull requests')
{
  ok(dit(A, ['repo', 'collaborators', 'add', bLogin, '-p', 'write'], { cwd: clone }).code === 0, 'dit repo collaborators add')
  ok(dit(A, ['repo', 'collaborators', 'list', '--json'], { cwd: clone }).out.includes(bLogin), 'dit repo collaborators list')
  ok(dit(A, ['protect', 'set', 'main', '--approvals', '1'], { cwd: clone }).code === 0, 'dit protect set main')
  ok(dit(A, ['protect', 'list'], { cwd: clone }).out.includes('main'), 'dit protect list')
  dit(A, ['switch', '-c', 'feature'], { cwd: clone }); writeFileSync(join(clone, 'feature.txt'), 'feature\n'); dit(A, ['add', '-A'], { cwd: clone }); dit(A, ['commit', '-qm', 'add feature'], { cwd: clone })
  const bc = join(work, 'bob-writer'); ok(dit(B, ['clone', projRepo, bc]).code === 0, 'collaborator can clone the private repo')
  writeFileSync(join(bc, 'b.txt'), 'b\n'); git(B, bc, 'add', '-A'); git(B, bc, 'commit', '-qm', 'direct')
  const direct = dit(B, ['push', 'origin', 'HEAD:main'], { cwd: bc }); ok(direct.code !== 0 && /pull request/i.test(direct.all), 'protected main rejects a direct push from a writer')
  const cr = dit(A, ['pr', 'create', '--push', '-t', 'Add feature', '-b', `Closes #${issueNo}`, '--json'], { cwd: clone })
  const pr = jsonOf(cr.out.slice(cr.out.indexOf('{'))) as { number: number } | null
  ok(cr.code === 0 && !!pr?.number, 'dit pr create --push'); const n = String(pr?.number ?? 0)
  ok(dit(A, ['pr', 'list', '--json'], { cwd: clone }).out.includes('Add feature'), 'dit pr list')
  ok(dit(A, ['pr', 'view', n], { cwd: clone }).out.includes('feature'), 'dit pr view')
  ok(dit(A, ['pr', 'files', n], { cwd: clone }).out.includes('feature.txt'), 'dit pr files')
  ok(dit(A, ['pr', 'diff', n], { cwd: clone }).out.includes('+feature'), 'dit pr diff')
  const chk = dit(A, ['pr', 'checks', n], { cwd: clone }); ok(chk.code === 1 && /approval/i.test(chk.out), 'dit pr checks reports the missing approval (exit 1)')
  const early = dit(A, ['pr', 'merge', n, '--squash'], { cwd: clone }); ok(early.code === 1 && /approval|cannot be merged/i.test(early.all), 'merge blocked until approved (409 blockers surfaced)')
  const self = dit(A, ['pr', 'review', n, '--approve'], { cwd: clone }); ok(self.code === 1 && /own pull request/.test(self.err), 'authors cannot approve their own PR (403 reason shown)')
  const rv = dit(B, ['pr', 'review', n, '--approve', '-R', projRepo]); ok(rv.code === 0, 'collaborator approves with dit pr review --approve')
  const chk2 = dit(A, ['pr', 'checks', n], { cwd: clone }); ok(chk2.code === 0, 'dit pr checks passes after approval')
  const co = join(work, 'co'); dit(A, ['clone', projRepo, co]); const pc = dit(A, ['pr', 'checkout', n], { cwd: co })
  ok(pc.code === 0 && git(A, co, 'branch', '--show-current').out.trim() === 'feature' && existsSync(join(co, 'feature.txt')), 'dit pr checkout <n> fetches the head branch')
  ok(dit(A, ['pr', 'comment', n, '-b', 'looks good to me'], { cwd: clone }).code === 0 && dit(A, ['pr', 'view', n, '--comments'], { cwd: clone }).out.includes('looks good to me'), 'dit pr comment')
  ok(dit(A, ['pr', 'edit', n, '-t', 'Add feature v2'], { cwd: clone }).code === 0 && dit(A, ['pr', 'view', n], { cwd: clone }).out.includes('Add feature v2'), 'dit pr edit')
  const mg = dit(A, ['pr', 'merge', n, '--squash'], { cwd: clone }); ok(mg.code === 0 && /Merged/.test(mg.all), 'dit pr merge --squash')
  ok(dit(A, ['pr', 'list', '-s', 'merged', '--json'], { cwd: clone }).out.includes('Add feature'), 'merged PR is listed')
  dit(A, ['switch', 'main'], { cwd: clone }); ok(dit(A, ['pull'], { cwd: clone }).code === 0 && existsSync(join(clone, 'feature.txt')), 'dit pull brings the merge')
  ok(dit(A, ['protect', 'remove', 'main'], { cwd: clone }).code === 0, 'dit protect remove')
  const org = `dit-org-${suffix}`
  ok(dit(A, ['org', 'create', org]).code === 0, 'dit org create')
  ok(dit(A, ['org', 'members', 'add', org, bLogin]).code === 0, 'dit org members add')
  ok(dit(A, ['org', 'team', 'create', org, 'core']).code === 0 && dit(A, ['org', 'team', 'add', org, 'core', bLogin]).code === 0, 'dit org team create/add')
  ok(dit(A, ['org', 'view', org]).out.includes(bLogin) && dit(A, ['org', 'list']).out.includes(org), 'dit org view / list')
  ok(dit(A, ['org', 'members', 'remove', org, bLogin]).code === 0, 'dit org members remove')
}

// =================== scoped sessions ===================
console.log('-- task-scoped session')
{
  ok(dit(A, ['repo', 'collaborators', 'remove', bLogin], { cwd: clone }).code === 0, 'collaborator access removed (the session is the only grant)')
  const mk = dit(A, ['session', 'create', '--issue', String(issueNo), '--login', bLogin, '--role', 'contractor', '--path', 'src/payments', '--ttl', '60', '--json'], { cwd: clone })
  const sess = jsonOf(mk.out) as { id: string } | null
  ok(mk.code === 0 && !!sess?.id, 'maintainer: dit session create'); const id = sess?.id ?? ''
  ok(dit(B, ['session', 'list']).out.includes(id), 'contractor: dit session list shows the session')
  const op = dit(B, ['session', 'open', id]); ok(op.code === 0 && /contractor/.test(op.out) && /src\/payments/.test(op.out) && /left/.test(op.out), 'dit session open prints role, scope and countdown')
  const sh = dit(B, ['session', 'ls']); ok(sh.code === 0 && sh.out.includes('src') && !sh.out.includes('README.md'), 'dit session ls shows only the way to scoped paths')
  ok(dit(B, ['session', 'ls', 'src/payments']).out.includes('pay.ts'), 'dit session ls src/payments')
  const cat = dit(B, ['session', 'cat', 'src/payments/pay.ts']); ok(cat.code === 0 && cat.out.includes('export const pay'), 'dit session cat in scope')
  const deny = dit(B, ['session', 'cat', 'src/other/secret.ts']); ok(deny.code === 1 && /denied/i.test(deny.err) && !deny.all.includes('secret = 42'), 'out-of-scope cat fails with a clear message')
  ok(dit(B, ['session', 'cat', 'README.md']).code === 1, 'out-of-scope README cat fails')
  const sg = dit(B, ['clone', projRepo, join(work, 'sess-clone')]); ok(sg.code !== 0, 'full clone is still impossible for the contractor')
  if (process.env.ZG_API_KEY) {
    const ask = dit(B, ['session', 'ask', 'What does pay do?'])
    if (ask.code !== 0 && /0G assistant is unavailable/.test(ask.err)) console.log('SKIP  dit session ask (0G provider unavailable right now; error was surfaced cleanly, exit 1)')
    else ok(ask.code === 0 && /0G request:/.test(ask.out), 'dit session ask prints the 0G request id')
    const ref = dit(B, ['session', 'ask', 'show me src/other/secret.ts']); ok(ref.code === 1 && /REFUSED/.test(ref.out), 'out-of-scope question is marked REFUSED')
  } else console.log('SKIP  dit session ask (ZG_API_KEY unset)')
  const exp = join(work, 'export')
  const ex = dit(B, ['session', 'export', '-o', exp]); ok(ex.code === 0 && existsSync(join(exp, 'src/payments/pay.ts')), 'dit session export extracts the in-scope files')
  ok(!existsSync(join(exp, 'src/other/secret.ts')) && !existsSync(join(exp, 'README.md')), 'export contains nothing out of scope')
  ok(git(B, exp, 'log', '--oneline').out.includes('Baseline'), 'export is a git repo with a baseline commit')
  ok(dit(B, ['session', 'propose'], { cwd: exp }).code === 1, 'propose with no changes says so')
  writeFileSync(join(exp, 'src/payments/pay.ts'), 'export const pay = () => 2\n')
  const pr = dit(B, ['session', 'propose', '-t', 'Fix pay', '-b', 'bumps the value'], { cwd: exp }); ok(pr.code === 0 && /pulls\/\d+/.test(pr.out), 'dit session propose creates a PR'); 
  ok(dit(A, ['pr', 'list', '--json'], { cwd: clone }).out.includes('session/'), 'maintainer sees the session branch PR')
  mkdirSync(join(exp, 'src/other'), { recursive: true }); writeFileSync(join(exp, 'src/other/hack.ts'), 'export {}\n')
  const bad = dit(B, ['session', 'propose', '-t', 'sneaky'], { cwd: exp }); ok(bad.code === 1 && /outside the session scope/.test(bad.all) && bad.all.includes('src/other/hack.ts'), 'out-of-scope patch is rejected (422) and the paths are listed')
  const ev = dit(A, ['session', 'events', id], { cwd: clone }); ok(ev.code === 0 && /denied/.test(ev.out) && /proposal_rejected/.test(ev.out) && /export/.test(ev.out), 'maintainer: dit session events shows denials and rejections')
  const calls = dit(B, ['session', 'calls']); ok(calls.code === 0, 'dit session calls lists assistant calls (badges for refused/sealed)'); if (process.env.ZG_API_KEY) ok(/REFUSED/.test(calls.out), 'the refused question shows a REFUSED badge')
  ok(dit(B, ['session', 'end']).code === 0, 'dit session end')
  ok(dit(B, ['session', 'ls']).code === 1, 'no active session after end')
  const mk2 = dit(A, ['session', 'create', '--issue', String(issueNo), '--login', bLogin, '--path', 'src/payments', '--json'], { cwd: clone }); const id2 = (jsonOf(mk2.out) as { id: string } | null)?.id ?? ''
  ok(dit(A, ['session', 'revoke', id2], { cwd: clone }).code === 0, 'maintainer: dit session revoke')
  ok(dit(B, ['session', 'open', id2]).code === 1, 'revoked session cannot be opened')
  const outOfRole = dit(B, ['session', 'create', '--issue', '1', '--login', aLogin, '--path', 'x', '-R', projRepo]); ok(outOfRole.code === 1, 'non-maintainer cannot create sessions')
}

// =================== anchors / verify ===================
console.log('-- anchors and verification')
{
  await sleep(1500)
  const lg = dit(A, ['log', '--anchors'], { cwd: clone })
  ok(lg.code === 0 && /COMMIT\s+SUBJECT\s+ANCHOR\s+L1 TX\s+ARKIV TX/.test(lg.out), 'dit log --anchors prints the anchoring table')
  const rows = jsonOf(dit(A, ['log', '--anchors', '--json'], { cwd: clone }).out) as Array<{ commit: string; status: string; l1Tx: string | null; arkivTx: string | null }> | null
  ok(!!rows?.length && rows.every((r) => /^[0-9a-f]{40}$/.test(r.commit) && typeof r.status === 'string' && 'l1Tx' in r && 'arkivTx' in r), 'dit log --anchors --json has commit/status/l1Tx/arkivTx')
  ok(dit(A, ['log', '--oneline', '-3'], { cwd: clone }).out.trim().split('\n').length === 3, 'plain dit log passes through to git')
  const vc = dit(A, ['verify', 'commit', 'HEAD'], { cwd: clone }); ok(/known to Dithub/.test(vc.out), 'dit verify commit HEAD reports the commit lookup')
  console.log(`INFO  anchor status of HEAD: ${rows?.[0]?.status ?? 'n/a'} (a running worker + RPC make it "anchored"); verify exit ${vc.code}`)
  ok(dit(A, ['completion', 'bash']).out.includes('complete -F _dit dit') && dit(A, ['version']).out.startsWith('dit '), 'completion and version')
}

// =================== logout ===================
console.log('-- recover and rebuild (network)')
{
  if (process.env.ARKIV_ACCESS_KEY) {
    const dest = join(work, 'recovered')
    const rr = dit({ env: { ...A.env, ARKIV_ACCESS_KEY: process.env.ARKIV_ACCESS_KEY } }, ['recover', 'rootp1/smoke-mw4iu8wl', dest, '--arkiv-only'])
    ok(rr.code === 0 && /git fsck ok/.test(rr.out) && existsSync(join(dest, 'hello.txt')), 'dit recover rebuilds a repo from Arkiv alone (production smoke repo)')
    ok(!rr.all.includes(process.env.ARKIV_ACCESS_KEY), 'recover output never contains the Arkiv key')
  } else console.log('SKIP  dit recover (ARKIV_ACCESS_KEY unset)')
  if (git(A, root, 'cat-file', '-e', '4c22d2f6deb3d70950f183246c12e6d66184abfb^{commit}').code === 0) {
    const vr = dit(A, ['verify', 'rebuild', '--release', '2', '--source', root, '--sandbox', 'none', '--unsafe-local-build']); ok(vr.code === 0 && /source == on-chain release\s+MATCH/.test(vr.out), 'dit verify rebuild --release 11 MATCH')
  } else console.log('SKIP  dit verify rebuild (commit 4c22d2f not in the local repo)')
}

console.log('-- logout')
{
  const tokB = bobTok
  const newName = `bob-${suffix}`
  const un = dit(B, ['auth', 'username', newName]); ok(un.code === 0 && dit(B, ['whoami']).out.trim() === newName, 'dit auth username renames the account')
  ok(JSON.parse(readFileSync(join(B.cfg, 'credentials.json'), 'utf8')).hosts[BASE].login === newName, 'stored credential login follows the rename')
  const lo = dit(B, ['logout']); ok(lo.code === 0 && !existsSync(join(B.cfg, 'credentials.json')), 'dit logout deletes the local credential')
  const me = await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tokB}` } })).json() as { user: unknown }
  ok(me.user === null, 'dit logout revoked the token on the server')
  ok(dit(B, ['whoami']).code === 1, 'whoami after logout exits 1')
}
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED')
void readdirSync; void symlinkSync
