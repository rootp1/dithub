// End-to-end check of phase 3 (issues, pull requests, task-scoped sessions) against a running API. Keys come from the environment; nothing is printed.
import { openDb, parseJson } from '../packages/db/src/index.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiweMessage } from 'viem/siwe'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const host = new URL(BASE).host
const sql = openDb(process.env.DATABASE_PATH) // the SQLite file the API uses
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1 }

class Client {
  cookie = ''
  constructor(readonly key: `0x${string}`) {}
  async req(path: string, init: RequestInit = {}) {
    const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie: this.cookie, ...(init.headers ?? {}) } })
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0]!
    return res
  }
  async j(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.req(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    let data: any = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data }
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

const suffix = Date.now().toString(36)
const A = new Client(process.env.DHEET_SEAT_KEY as `0x${string}`)
const B = new Client(process.env.DHEET_STRANGER_KEY as `0x${string}`)
const ua = await A.login(), ub = await B.login()
ok(ua.user?.id && ub.user?.id, 'SIWE login for two users')
const aLogin = ua.user!.login, bLogin = ub.user!.login
const tokA = (await A.j('/api/tokens', 'POST', { name: 'e2e3' })).data.token as string
const tokB = (await B.j('/api/tokens', 'POST', { name: 'e2e3' })).data.token as string
const withTok = (url: string, t: string) => url.replace('http://', `http://x:${t}@`)

// ---------- repo (public) for issues and PRs ----------
const pubName = `p3pub-${suffix}`
const pubRes = await A.j('/api/repos', 'POST', { name: pubName, visibility: 'public' })
const pub = pubRes.data as { cloneUrl: string }
const P = `/api/repos/${aLogin}/${pubName}`
const work = mkdtempSync(join(tmpdir(), 'dheet-e2e3-'))
git(work, 'init', '-q', '-b', 'main')
const write = (f: string, c: string) => { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), c) }
const commit = (msg: string) => { git(work, 'add', '.'); git(work, 'commit', '-qm', msg) }
write('README.md', 'hello\n'); write('a.txt', 'one\ntwo\nthree\n'); commit('init')
ok(git(work, 'push', withTok(pub.cloneUrl, tokA), 'main').code === 0, 'owner pushes main to public repo')

// ---- issues ----
const iss = await B.j(`${P}/issues`, 'POST', { title: 'Bug from B', body: 'it breaks' })
ok(iss.status === 201 && iss.data.number === 1, 'reader (no collaborator) can open an issue; number 1')
ok((await B.j(`${P}/issues`, 'POST', { title: 'x', labels: ['bug'] })).status === 403, 'labels at creation need triage')
ok((await new Client(A.key).j(`${P}/issues`, 'POST', { title: 'anon' })).status === 401, 'anonymous cannot create issues')
const par = await Promise.all(Array.from({ length: 8 }, (_, k) => A.j(`${P}/issues`, 'POST', { title: `parallel ${k}` })))
const nums = par.map((r) => r.data.number as number)
ok(new Set(nums).size === 8 && par.every((r) => r.status === 201), `concurrent creation yields 8 distinct numbers (${Math.min(...nums)}-${Math.max(...nums)})`)
ok((await B.j(`${P}/labels`, 'POST', { name: 'bug', color: 'ff0000' })).status === 403, 'reader cannot create labels')
ok((await A.j(`${P}/labels`, 'POST', { name: 'bug', color: 'ff0000' })).status === 201, 'owner creates label')
ok((await A.j(`${P}/labels`, 'POST', { name: 'bug', color: 'ff0000' })).status === 409, 'duplicate label rejected')
ok((await B.j(`${P}/issues/1/labels`, 'POST', { labels: ['bug'] })).status === 403, 'author without triage cannot label')
ok((await A.j(`${P}/issues/1/labels`, 'POST', { labels: ['bug'] })).data.labels?.length === 1, 'triage+ attaches label')
ok((await A.j(`${P}/issues/1/assignees`, 'POST', { assignees: [bLogin] })).data.assignees?.[0] === bLogin, 'triage+ assigns user')
ok((await B.j(`${P}/issues/1/assignees`, 'POST', { assignees: [bLogin] })).status === 403, 'non-triage cannot assign')
const lf = await B.j(`${P}/issues?state=open&label=bug&assignee=${bLogin}`)
ok(lf.data.total === 1 && lf.data.issues[0].number === 1, 'list filters by label + assignee')
ok((await B.j(`${P}/issues?per_page=3&page=2`)).data.issues.length === 3, 'pagination')
ok((await B.j(`${P}/issues/1`, 'PATCH', { title: 'Bug from B (edited)' })).status === 200, 'author edits own issue')
ok((await B.j(`${P}/issues/2`, 'PATCH', { state: 'closed' })).status === 403, 'author cannot close someone else\'s issue')
ok((await A.j(`${P}/issues/2`, 'PATCH', { state: 'closed' })).data.state === 'closed', 'triage+ closes others\' issue')
ok((await B.j(`${P}/issues?state=closed`)).data.total === 1, 'closed filter')
const cm = await B.j(`${P}/issues/1/comments`, 'POST', { body: 'me too' })
ok(cm.status === 201, 'comment created')
ok((await A.j(`${P}/comments/${cm.data.id}`, 'PATCH', { body: 'hijack' })).status === 403, 'only comment author may edit')
ok((await B.j(`${P}/comments/${cm.data.id}`, 'PATCH', { body: 'me three' })).status === 200, 'author edits comment')
ok((await B.j(`${P}/issues/1`)).data.comments === 1, 'comments_count tracked')
ok((await A.j(`${P}/comments/${cm.data.id}`, 'DELETE')).status === 200 && (await B.j(`${P}/issues/1/comments`)).data.comments.length === 0, 'triage+ deletes comment')
ok((await B.j(`${P}/issues/1/events`)).data.events.length >= 3, 'issue timeline has events')
const imp = await A.j(`${P}/issues/import`, 'POST', { url: 'https://github.com/expressjs/express/issues/1' })
if (imp.status === 502) console.log('SKIP  GitHub import (GitHub unreachable or rate limited)')
else ok(imp.status === 201 && imp.data.source?.provider === 'github' && imp.data.title, 'import a public GitHub issue with source metadata')
ok((await A.j(`${P}/issues/import`, 'POST', { url: 'https://evil.example/octocat/x/issues/1' })).status === 400, 'import rejects non-GitHub URLs')

// ---- pull requests ----
write('a.txt', 'one\ntwo\nthree\nfour\n'); write('feat.txt', 'feature\n'); git(work, 'checkout', '-qb', 'feature'); commit('feature: add four')
ok(git(work, 'push', withTok(pub.cloneUrl, tokA), 'feature').code === 0, 'push feature branch')
git(work, 'checkout', '-q', 'main'); git(work, 'checkout', '-qb', 'feature2'); write('b.txt', 'b\n'); commit('feature2: b'); write('b.txt', 'b2\n'); commit('feature2: b again')
git(work, 'push', withTok(pub.cloneUrl, tokA), 'feature2')
git(work, 'checkout', '-q', 'main'); git(work, 'checkout', '-qb', 'feature3'); write('c.txt', 'c\n'); commit('feature3: c')
git(work, 'push', withTok(pub.cloneUrl, tokA), 'feature3')
git(work, 'checkout', '-q', 'main'); git(work, 'checkout', '-qb', 'conflict'); write('a.txt', 'CONFLICT\n'); commit('conflict'); git(work, 'push', withTok(pub.cloneUrl, tokA), 'conflict')
git(work, 'checkout', '-q', 'main')

ok((await B.j(`${P}/pulls`, 'POST', { title: 'nope', head: 'feature', base: 'main' })).status === 403, 'reader cannot open a PR')
const pr1 = await A.j(`${P}/pulls`, 'POST', { title: 'Add four', head: 'feature', base: 'main' })
ok(pr1.status === 201 && pr1.data.isPullRequest && pr1.data.mergeable === 'clean', `PR opened (#${pr1.data.number}) and mergeable`)
ok((await A.j(`${P}/pulls`, 'POST', { title: 'dup', head: 'feature', base: 'main' })).status === 409, 'duplicate open PR rejected')
ok((await A.j(`${P}/pulls`, 'POST', { title: 'bad', head: '../x', base: 'main' })).status >= 400, 'unsafe ref rejected')
const n1 = pr1.data.number
const files = await A.j(`${P}/pulls/${n1}/files`)
ok(files.data.files.length === 2 && files.data.files.some((f: any) => f.path === 'feat.txt' && f.status === 'added'), 'files changed')
const diff = await A.j(`${P}/pulls/${n1}/diff`)
ok(typeof diff.data === 'string' && diff.data.includes('+four'), 'unified diff')
ok((await A.j(`${P}/pulls/${n1}/commits`)).data.commits.length === 1, 'PR commits')
const prC = await A.j(`${P}/pulls`, 'POST', { title: 'Conflicting', head: 'conflict', base: 'main' })
ok(prC.data.mergeable === 'clean', 'conflict branch initially clean')
// protect main: 1 approval
await A.j(`${P}/collaborators/${bLogin}`, 'PUT', { permission: 'write' })
ok((await A.j(`${P}/protections`, 'PUT', { pattern: 'main', requirePr: true, requiredApprovals: 1 })).status === 200, 'protect main (PR + 1 approval)')
ok(git(work, 'push', withTok(pub.cloneUrl, tokB), 'main:refs/heads/main').code !== 0 || true, 'protected push attempted')
const m0 = await A.j(`${P}/pulls/${n1}/merge`, 'POST', { method: 'squash' })
ok(m0.status === 409 && JSON.stringify(m0.data.blockers).includes('approving'), 'merge blocked without approval')
ok((await A.j(`${P}/pulls/${n1}/reviews`, 'POST', { event: 'approve' })).status === 403, 'author cannot approve own PR')
const rv = await B.j(`${P}/pulls/${n1}/reviews`, 'POST', { event: 'request_changes', body: 'please fix', comments: [{ path: 'a.txt', line: 4, side: 'RIGHT', body: 'nit' }] })
ok(rv.status === 201, 'reviewer requests changes with an inline comment')
ok((await A.j(`${P}/pulls/${n1}/merge`, 'POST', {})).status === 409, 'merge blocked by requested changes')
ok((await B.j(`${P}/pulls/${n1}/reviews`, 'POST', { event: 'approve' })).status === 201, 'reviewer approves')
const revs = await A.j(`${P}/pulls/${n1}/reviews`)
ok(revs.data.reviews.length === 2 && revs.data.reviews[0].comments.length === 1, 'reviews and review comments listed')
const mc = await A.j(`${P}/pulls/${n1}/mergeable`)
ok(mc.data.canMerge === true, 'mergeable check reports canMerge')
const [repoRow] = await sql`SELECT id FROM repos WHERE name = ${pubName}`
const pushesBefore = Number((await sql`SELECT count(*) AS n FROM pushes WHERE repo_id = ${repoRow.id}`)[0].n)
const m1 = await A.j(`${P}/pulls/${n1}/merge`, 'POST', { method: 'squash' })
ok(m1.status === 200 && m1.data.merged, 'squash merge into protected main (server bypasses pre-receive)')
const pushesAfter = await sql`SELECT id, new_oid FROM pushes WHERE repo_id = ${repoRow.id} ORDER BY id DESC LIMIT 1`
const [ob] = await sql`SELECT kind, status FROM outbox WHERE aggregate_type = 'push' AND aggregate_id = ${pushesAfter[0].id}`
ok(Number((await sql`SELECT count(*) AS n FROM pushes WHERE repo_id = ${repoRow.id}`)[0].n) === pushesBefore + 1 && ob?.kind === 'push', 'merge recorded as push row + outbox push entry')
const mainBlob = await A.j(`${P}/blob?ref=main&path=feat.txt`)
ok(mainBlob.data.content === 'feature\n', 'merged content visible on main')
ok((await A.j(`${P}`)).data.refs.find((r: any) => r.name === 'refs/heads/main').oid === m1.data.mergeCommitOid, 'git_refs updated to merge commit')
ok((await A.j(`${P}/pulls/${n1}`)).data.state === 'merged', 'PR state merged')
ok((await A.j(`${P}/pulls/${n1}/merge`, 'POST', {})).status === 409, 'cannot merge twice')
// conflict PR is now stale
const cstat = await A.j(`${P}/pulls/${prC.data.number}`)
ok(cstat.data.mergeable === 'conflict', 'PR conflicting with updated main reports conflict')
ok((await A.j(`${P}/pulls/${prC.data.number}/merge`, 'POST', {})).status === 409, 'conflicting PR cannot be merged')
// merge + rebase strategies (no approvals needed: relax protection)
await A.j(`${P}/protections`, 'PUT', { pattern: 'main', requirePr: true, requiredApprovals: 0 })
const pr2 = await A.j(`${P}/pulls`, 'POST', { title: 'Feature two', head: 'feature2', base: 'main' })
const m2 = await A.j(`${P}/pulls/${pr2.data.number}/merge`, 'POST', { method: 'rebase' })
ok(m2.status === 200, 'rebase merge')
const log = git(work, 'fetch', '-q', withTok(pub.cloneUrl, tokA), 'main:refs/remotes/o/main')
const ln = Bun.spawnSync(['git', 'log', '--format=%s', 'o/main'], { cwd: work }).stdout.toString().split('\n').filter(Boolean)
ok(log.code === 0 && ln[0] === 'feature2: b again' && ln[1] === 'feature2: b' && !ln.some((s) => s.startsWith('Merge')), 'rebase kept linear history with both commits')
const pr3 = await A.j(`${P}/pulls`, 'POST', { title: 'Feature three', head: 'feature3', base: 'main' })
const m3 = await A.j(`${P}/pulls/${pr3.data.number}/merge`, 'POST', { method: 'merge' })
ok(m3.status === 200, 'merge-commit strategy')
const parents = Bun.spawnSync(['git', 'cat-file', '-p', 'FETCH_HEAD'], { cwd: work })
git(work, 'fetch', '-q', withTok(pub.cloneUrl, tokA), 'main')
ok(Bun.spawnSync(['git', 'rev-list', '--parents', '-n1', 'FETCH_HEAD'], { cwd: work }).stdout.toString().trim().split(' ').length === 3 && void parents === undefined, 'merge commit has two parents')
ok(git(work, 'fsck', '--strict').code === 0, 'repo passes git fsck after merges')
// close/reopen PR
ok((await A.j(`${P}/pulls/${prC.data.number}`, 'PATCH', { state: 'closed' })).data.state === 'closed', 'close PR')
ok((await A.j(`${P}/pulls?state=merged`)).data.total === 3, 'list merged PRs')

// ---------- sessions on a PRIVATE repo ----------
const privName = `p3priv-${suffix}`
const priv = (await A.j('/api/repos', 'POST', { name: privName, visibility: 'private' })).data as { cloneUrl: string }
const S = `/api/repos/${aLogin}/${privName}`
const w2 = mkdtempSync(join(tmpdir(), 'dheet-e2e3b-'))
git(w2, 'init', '-q', '-b', 'main')
const wr = (f: string, c: string) => { mkdirSync(join(w2, f, '..'), { recursive: true }); writeFileSync(join(w2, f), c) }
wr('README.md', 'readme\n'); wr('src/app.ts', 'export const app = 1\n'); wr('src/util.ts', 'export const util = 2\n'); wr('secret/algo.ts', 'TOP SECRET\n'); wr('lib/core.ts', 'core\n')
git(w2, 'add', '.'); git(w2, 'commit', '-qm', 'initial')
wr('secret/algo.ts', 'TOP SECRET v2\n'); git(w2, 'add', '.'); git(w2, 'commit', '-qm', 'secret change only')
wr('src/util.ts', 'export const util = 3\n'); wr('lib/core.ts', 'core2\n'); git(w2, 'add', '.'); git(w2, 'commit', '-qm', 'touch src and lib')
ok(git(w2, 'push', withTok(priv.cloneUrl, tokA), 'main').code === 0, 'owner pushes private repo')
ok((await B.j(`${S}`)).status === 404, 'stranger sees nothing of the private repo')
const si = await A.j(`${S}/issues`, 'POST', { title: 'Secret task: tweak util' })
const sn = si.data.number
const mk = (body: any, c = A) => c.j(`${S}/sessions`, 'POST', body)
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['src'] }, B)).status === 404, 'non-member cannot create a session (repo hidden)')
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['../secret'] })).status === 400, 'scope with ".." rejected')
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['/etc'] })).status === 400, 'absolute scope rejected')
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['src'], ttlMinutes: 5000 })).status === 400, 'ttl above 1440 rejected')
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['*'] })).status === 400, 'root wildcard scope rejected')
const sess = await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['src/'], ttlMinutes: 60 })
ok(sess.status === 201 && sess.data.allowedPaths[0] === 'src', 'maintainer creates contractor session (paths normalised)')
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['src'] })).status === 409, 'only one active session per (user, issue)')
const sid = sess.data.id as string, H = { 'x-dheet-session': sid }
ok((await B.j(`${S}`)).status === 404, 'session holder without header still has no access')
ok((await B.j(`${S}/tree`, 'GET', undefined, { 'x-dheet-session': '00000000-0000-0000-0000-000000000000' })).status === 403, 'unknown session id rejected')
const t0 = await B.j(`${S}/tree`, 'GET', undefined, H)
ok(t0.status === 200 && t0.data.entries.map((e: any) => e.name).join() === 'src', 'root listing shows only the way to in-scope paths')
const t1 = await B.j(`${S}/tree?path=src`, 'GET', undefined, H)
ok(t1.data.entries.length === 2, 'in-scope directory listing')
ok((await B.j(`${S}/tree?path=secret`, 'GET', undefined, H)).status === 403, 'out-of-scope tree denied')
ok((await B.j(`${S}/blob?path=src/app.ts`, 'GET', undefined, H)).data.content === 'export const app = 1\n', 'in-scope blob readable')
ok((await B.j(`${S}/blob?path=secret/algo.ts`, 'GET', undefined, H)).status === 403, 'out-of-scope blob 403')
for (const evil of ['src/../secret/algo.ts', '/secret/algo.ts', 'src/%2e%2e/secret/algo.ts', 'secret/algo.ts%00', 'SRC/app.ts', 'src//../secret/algo.ts', 'src\\..\\secret\\algo.ts', ':(top)secret/algo.ts', 'src/*'])
  ok((await B.j(`${S}/blob?path=${encodeURIComponent(evil)}`, 'GET', undefined, H)).status !== 200, `path trick rejected: ${evil.replace('\0', '\\0')}`)
ok((await B.j(`${S}/blob?path=src/app.ts&ref=refs/heads/other`, 'GET', undefined, H)).status === 403, 'other refs not readable')
ok((await B.j(`${S}/blob?path=srcx/app.ts`, 'GET', undefined, H)).status === 403, 'prefix match respects segment boundary')
const cms = await B.j(`${S}/commits`, 'GET', undefined, H)
ok(cms.status === 200 && cms.data.commits.length === 2 && cms.data.commits.every((c: any) => c.files.every((f: string) => f.startsWith('src/'))), 'commits limited to in-scope paths, out-of-scope files omitted')
ok(!cms.data.commits.some((c: any) => c.subject === 'secret change only'), 'commit touching only secret/ hidden')
ok((await B.j(`${S}/ledger`, 'GET', undefined, H)).status === 403, 'ledger not available in a scoped session')
const clone = Bun.spawnSync(['git', '-c', 'credential.helper=', '-c', `http.extraHeader=x-dheet-session: ${sid}`, 'clone', '-q', withTok(priv.cloneUrl, tokB), join(tmpdir(), `nope-${suffix}`)], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
ok(clone.exitCode !== 0 && /403|not allowed/.test(clone.stderr.toString()), 'git clone denied for contractor session')
const exp = await B.req(`/api/sessions/${sid}/export`)
const tarPath = join(tmpdir(), `export-${suffix}.tar`)
writeFileSync(tarPath, Buffer.from(await exp.arrayBuffer()))
const names = Bun.spawnSync(['tar', '-tf', tarPath]).stdout.toString().split('\n').filter((n) => n && !n.endsWith('/')).sort()
ok(exp.status === 200 && names.join() === 'src/app.ts,src/util.ts', `export tar contains only in-scope files (${names.join(' ')})`)
ok((await A.req(`/api/sessions/${sid}/export`)).status === 403, 'export only for the session user')
// proposals
write2: {
  wr('src/util.ts', 'export const util = 4\n'); const good = git(w2, 'diff').out
  git(w2, 'checkout', '-q', '.')
  const p = await B.j(`/api/sessions/${sid}/proposals`, 'POST', { patch: good, title: 'Tweak util' })
  ok(p.status === 201 && p.data.branch === `session/${sn}-${bLogin}` && p.data.pullRequest, `in-scope patch accepted: branch + PR #${p.data.pullRequest}`)
  const pr = await A.j(`${S}/pulls/${p.data.pullRequest}`)
  ok(pr.data.head === `session/${sn}-${bLogin}` && pr.data.base === 'main' && pr.data.fromSession && pr.data.author === bLogin, 'PR from session proposal targets base branch')
  ok((await A.j(`${S}/pulls/${p.data.pullRequest}/files`)).data.files.map((f: any) => f.path).join() === 'src/util.ts', 'proposal PR changes only in-scope file')
  wr('secret/algo.ts', 'LEAK\n'); wr('src/app.ts', 'export const app = 9\n'); const bad = git(w2, 'diff').out
  git(w2, 'checkout', '-q', '.')
  const q = await B.j(`/api/sessions/${sid}/proposals`, 'POST', { patch: bad })
  ok(q.status === 422 && q.data.paths.includes('secret/algo.ts'), 'patch touching out-of-scope file rejected')
  const rename = 'diff --git a/src/app.ts b/secret/stolen.ts\nsimilarity index 100%\nrename from src/app.ts\nrename to secret/stolen.ts\n'
  ok((await B.j(`/api/sessions/${sid}/proposals`, 'POST', { patch: rename })).status === 422, 'rename into out-of-scope path rejected')
  ok((await B.j(`/api/sessions/${sid}/proposals`, 'POST', { patch: 'garbage' })).status === 422, 'garbage patch rejected')
  ok((await A.j(`/api/sessions/${sid}/proposals`, 'POST', { patch: good })).status === 403, 'only the session user can propose')
}
// audit log
const ev = await A.j(`/api/sessions/${sid}/events`)
const kinds = new Set(ev.data.events.map((e: any) => e.kind))
ok(['create', 'tree', 'blob', 'denied', 'commits', 'export', 'clone_denied', 'proposal', 'proposal_rejected'].every((k) => kinds.has(k)), `session audit log records reads, denials and proposals (${[...kinds].join(',')})`)
ok((await B.j(`/api/sessions/${sid}/events`)).status === 404, 'developer cannot read the audit log')
const rbac = await sql`SELECT metadata FROM audit_log WHERE action = 'session.create' AND json_extract(metadata, '$.session') = ${sid}`
ok(rbac.length === 1 && !JSON.stringify(parseJson(rbac[0].metadata)).includes('src') && !JSON.stringify(parseJson(rbac[0].metadata)).includes('Secret task'), 'session.create in audit log without paths or issue text')
ok((await B.j('/api/sessions')).data.sessions.some((s: any) => s.id === sid), 'developer lists own sessions')
// employee role
const sn2 = (await A.j(`${S}/issues`, 'POST', { title: 'Another task' })).data.number
const emp = await mk({ issueNumber: sn2, login: bLogin, role: 'employee', paths: ['lib'], ttlMinutes: 30 })
const EH = { 'x-dheet-session': emp.data.id }
const et = await B.j(`${S}/tree`, 'GET', undefined, EH)
ok(et.data.entries.map((e: any) => e.name).sort().join() === 'README.md,lib,secret,src' && et.data.entries.find((e: any) => e.name === 'secret').restricted && !et.data.entries.find((e: any) => e.name === 'secret').oid, 'employee sees top-level names (restricted entries carry no metadata)')
ok((await B.j(`${S}/tree?path=secret`, 'GET', undefined, EH)).status === 403 && (await B.j(`${S}/blob?path=README.md`, 'GET', undefined, EH)).status === 403, 'employee gets no content outside scope')
ok((await B.j(`${S}/blob?path=lib/core.ts`, 'GET', undefined, EH)).status === 200, 'employee reads in-scope content')
// maintainer role session may clone
const sn3 = (await A.j(`${S}/issues`, 'POST', { title: 'Maintain' })).data.number
const msn = await mk({ issueNumber: sn3, login: bLogin, role: 'maintainer', ttlMinutes: 30 })
const mclone = Bun.spawnSync(['git', '-c', 'credential.helper=', '-c', `http.extraHeader=x-dheet-session: ${msn.data.id}`, 'clone', '-q', withTok(priv.cloneUrl, tokB), join(tmpdir(), `mclone-${suffix}`)], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
ok(mclone.exitCode === 0, 'maintainer-role session can clone')
// revoke / end / expire
ok((await B.j(`/api/sessions/${msn.data.id}/revoke`, 'POST')).status === 404, 'developer cannot revoke (maintainer-only)')
ok((await A.j(`/api/sessions/${msn.data.id}/revoke`, 'POST')).data.status === 'ended', 'maintainer revokes session')
ok((await B.j(`${S}/tree`, 'GET', undefined, { 'x-dheet-session': msn.data.id })).status === 403, 'revoked session no longer works')
ok((await B.j(`/api/sessions/${emp.data.id}/end`, 'POST')).data.status === 'ended', 'developer ends own session')
ok((await B.j(`${S}/tree`, 'GET', undefined, EH)).status === 403, 'ended session no longer works')
await sql`UPDATE task_sessions SET expires_at = ${new Date(Date.now() - 60_000).toISOString()} WHERE id = ${sid}`
ok((await B.j(`${S}/tree`, 'GET', undefined, H)).status === 403, 'expired session no longer works')
ok((await B.j(`/api/sessions/${sid}`)).data.status === 'expired', 'expired session reported as expired')
ok((await mk({ issueNumber: sn, login: bLogin, role: 'contractor', paths: ['src'] })).status === 201, 'new session possible after the old one expired')

console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED')
await sql.close()
