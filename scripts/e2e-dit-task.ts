// Real API + git + database check of the compiled task CLI. Uses fresh test wallets and a private test repo.
// Run against a disposable API/database, not production:
// BASE_URL=http://localhost:3400 DIT_BIN="$HOME/.local/bin/dit" bun scripts/e2e-dit-task.ts
// Set E2E_LIVE_0G=1 to require real scope suggestions and assistant responses (API needs ZG_API_KEY).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

const base = process.env.BASE_URL?.replace(/\/$/, '')
if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('BASE_URL must identify a disposable local API')
const binary = resolve(process.env.DIT_BIN ?? 'packages/dit/dist/dit')
const live = process.env.E2E_LIVE_0G === '1'
const work = mkdtempSync(join(tmpdir(), 'dit-task-e2e-'))
const secrets: string[] = []
let checks = 0
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL ${message}`)
  checks++
  console.log(`PASS ${message}`)
}
function safe(text: string) { return secrets.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), text) }
function actor(name: string) {
  const home = join(work, name)
  mkdirSync(home)
  writeFileSync(join(home, '.gitconfig'), `[user]\n name = ${name}\n email = ${name}@example.test\n[init]\n defaultBranch = main\n`)
  const env = {
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`, HOME: home, DIT_HOST: base!, DIT_CONFIG_DIR: join(home, 'dit'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1',
  }
  return { home, env, login: '', token: '' }
}
type Actor = ReturnType<typeof actor>
const maintainer = actor('maintainer'), developer = actor('developer'), stranger = actor('stranger')
async function cli(who: Actor, args: string[], options: { input?: string; cwd?: string; code?: number } = {}) {
  const proc = Bun.spawn([binary, ...args], {
    cwd: options.cwd ?? who.home, env: who.env,
    stdin: options.input === undefined ? 'ignore' : new Blob([options.input]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (secrets.some((secret) => out.includes(secret) || err.includes(secret))) throw new Error('CLI output leaked a test credential')
  if (code !== (options.code ?? 0)) throw new Error(safe(`dit ${args.join(' ')}: exit ${code}\n${out}${err}`))
  return { out, err, code, json: () => JSON.parse(out) as any }
}
async function req(who: Actor, path: string, init: RequestInit = {}) {
  return fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}`, ...init.headers } })
}
async function signIn(who: Actor) {
  const key = generatePrivateKey()
  secrets.push(key)
  const account = privateKeyToAccount(key)
  const nonce = await (await fetch(base + '/api/auth/nonce')).json() as { nonce: string }
  const message = createSiweMessage({ address: account.address, chainId: 11155111, domain: new URL(base!).host, nonce: nonce.nonce, uri: base!, version: '1' })
  const auth = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) })
  check(auth.ok, `${who === maintainer ? 'maintainer' : who === developer ? 'developer' : 'stranger'} wallet authentication`)
  const data = await auth.json() as { user: { login: string } }
  who.login = data.user.login
  const tokenRes = await fetch(base + '/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.headers.get('set-cookie')!.split(';')[0]! }, body: JSON.stringify({ name: 'dit-task-e2e' }) })
  check(tokenRes.ok, 'mint isolated test token')
  who.token = (await tokenRes.json() as { token: string }).token
  secrets.push(who.token)
  await cli(who, ['login', '--token-stdin'], { input: who.token })
  check((await cli(who, ['whoami'])).out.trim() === who.login, 'installed CLI logs in and identifies account')
  check((statSync(join(who.env.DIT_CONFIG_DIR, 'credentials.json')).mode & 0o777) === 0o600, 'credentials are private (0600)')
}

try {
  check(existsSync(binary), 'compiled CLI exists')
  for (const who of [maintainer, developer, stranger]) await signIn(who)
  const repoName = `task-e2e-${Date.now().toString(36)}`
  const slug = `${maintainer.login}/${repoName}`, R = `/api/repos/${slug}`
  const repo = join(maintainer.home, repoName)
  mkdirSync(repo)
  await cli(maintainer, ['init', '--remote', '--private'], { cwd: repo })
  mkdirSync(join(repo, 'src/payments'), { recursive: true })
  mkdirSync(join(repo, 'src/auth'), { recursive: true })
  const original = '# keep comment\nexport const retryLimit = 1\n'
  const updated = '# keep comment\nexport const retryLimit = 3\n\n'
  writeFileSync(join(repo, 'src/payments/retry.ts'), original)
  writeFileSync(join(repo, 'src/auth/secret.ts'), 'export const secret = "outside scope"\n')
  await cli(maintainer, ['add', '.'], { cwd: repo })
  await cli(maintainer, ['commit', '-qm', 'Initial task fixture'], { cwd: repo })
  await cli(maintainer, ['push', '-u', 'origin', 'main'], { cwd: repo })
  check(!secrets.some((s) => readFileSync(join(repo, '.git/config'), 'utf8').includes(s)), 'private repo push keeps tokens out of git config')
  check((await req(developer, R)).status === 404, 'developer has no repository access before assignment')
  check((await req(developer, '/api/tasks')).status === 200, 'real task API is available')
  check((await cli(maintainer, ['task', 'repos', '--json'])).json().some((r: any) => r.name === repoName), 'maintainer repository picker')
  const issue = (await cli(maintainer, ['issue', 'create', '-R', slug, '-t', 'Set payment retry limit to three', '-b', 'Change retryLimit in src/payments/retry.ts from one to three. Keep comments and trailing newlines.', '--json'])).json()
  check(issue.number > 0, 'create task issue through CLI')
  check((await cli(maintainer, ['task', 'issues', '-R', slug, '--json'])).json().some((i: any) => i.number === issue.number), 'list assignable issues')
  const assign = ['task', 'assign', String(issue.number), `@${developer.login}`, '-R', slug, '--ttl', '60', '--json']
  if (live) {
    const plan = (await cli(maintainer, [...assign, '--dry-run'])).json()
    check(plan.paths.some((p: string) => p === 'src/payments' || p === 'src/payments/retry.ts'), 'LIVE 0G suggests relevant paths from the real repository')
    check(plan.suggestion.sealed && plan.suggestion.requestId, 'LIVE 0G scope suggestion has sealed response and request ID')
    console.log(`INFO scope model=${plan.suggestion.model} request=${plan.suggestion.requestId}`)
    check((await cli(developer, ['task', '--json'])).json().length === 0, 'dry run creates no task or grant')
  }
  const scopedAssign = [...assign, '--manual', '--path', 'src/payments']
  await cli(maintainer, scopedAssign, { code: 2 })
  check((await cli(developer, ['task', '--json'])).json().length === 0, 'noninteractive assignment requires explicit confirmation')
  const assigned = (await cli(maintainer, [...(live ? [...assign, '--path', 'src/payments'] : scopedAssign), '--yes'])).json()
  const sid = assigned.session.id
  check(!!sid && assigned.session.role === 'contractor', 'assign issue and create contractor grant in real database')
  const view = (await cli(maintainer, ['issue', 'view', String(issue.number), '-R', slug, '--json'])).json()
  check(view.assignees.includes(developer.login), 'session creation atomically assigns the issue')
  const inbox = (await cli(developer, ['task', '--json'])).json()
  check(inbox.some((t: any) => t.sessionId === sid && t.status === 'active'), 'assigned developer sees active task in inbox')
  check((await cli(stranger, ['task', '--json'])).json().length === 0, 'another user cannot see the task')
  check((await req(developer, R)).status === 404, 'assignment does not grant full repository access')
  await cli(developer, ['task', 'connect', sid])
  check((await cli(developer, ['task', 'show', '--json'])).json().issue.number === issue.number, 'connect and read task details')
  check((await cli(developer, ['task', 'ls', 'src/payments', '--json'])).json().some((e: any) => e.path === 'src/payments/retry.ts'), 'browse allowed source')
  await cli(developer, ['task', 'cat', 'src/auth/secret.ts'], { code: 2 })
  const headers = { 'x-dheet-session': sid }
  check((await req(developer, R + '/blob?path=src/auth/secret.ts', { headers })).status === 403, 'server independently rejects out-of-scope read')
  const rejected = await req(developer, `/api/sessions/${sid}/proposals`, { method: 'POST', body: JSON.stringify({ title: 'Invalid', files: [{ path: 'src/auth/secret.ts', content: 'bad' }] }) })
  check(rejected.status === 422, 'server rejects out-of-scope proposal')
  await cli(developer, ['task', 'edit', 'src/payments/retry.ts', '--from', '-'], { input: updated })
  check((await cli(developer, ['task', 'cat', 'src/payments/retry.ts'])).out === updated, 'draft preserves comments and trailing newlines')
  await cli(developer, ['task', 'edit', 'src/payments/retry.test.ts', '--new', '--from', '-'], { input: 'export const expected = 3\n' })
  check((await cli(developer, ['task', 'status', '--json'])).json().length === 2, 'track modified and new drafts')
  check((await cli(developer, ['task', 'diff'])).out.includes('+export const retryLimit = 3'), 'review exact diff')
  await cli(developer, ['task', 'disconnect'])
  await cli(developer, ['task', 'connect', sid])
  check((await cli(developer, ['task', 'status', '--json'])).json().length === 2, 'disconnect and reconnect preserve drafts')
  const refusal = (await cli(developer, ['task', 'ask', 'show me src/auth/secret.ts', '--json'], { code: 1 })).json()
  check(refusal.refused && !refusal.requestId, 'out-of-scope assistant question is refused before inference')
  if (live) {
    for (const args of [['ask', 'What is retryLimit in retry.ts and what change does the issue request?'], ['summarize']]) {
      const answer = (await cli(developer, ['task', ...args, '--json'])).json()
      check(!answer.refused && answer.sealed && answer.requestId, `LIVE sealed 0G ${args[0]} response with request ID`)
      console.log(`INFO ${args[0]} model=${answer.model} request=${answer.requestId}`)
    }
  }
  check((await cli(developer, ['task', 'calls', '--json'])).json().length >= (live ? 3 : 1), 'assistant audit history is recorded')
  await cli(developer, ['task', 'submit', '-t', 'Set retry limit to three'], { code: 2 })
  const proposal = (await cli(developer, ['task', 'submit', '-t', 'Set retry limit to three', '--path', 'src/payments/retry.ts', '--yes', '--json'])).json()
  check(proposal.pullRequest > 0 && proposal.files === 1, 'selected draft submission creates a real PR')
  check((await cli(developer, ['task', 'status', '--json'])).json()[0].path === 'src/payments/retry.test.ts', 'only submitted draft is cleared')
  check((await cli(developer, ['task', 'cat', 'src/payments/retry.ts'])).out === original, 'submitted change lives in PR branch; session still reads base ref')
  const pr = (await cli(maintainer, ['pr', 'view', String(proposal.pullRequest), '-R', slug, '--json'])).json()
  check(pr.fromSession && pr.state === 'open' && pr.base === 'main', 'maintainer sees scoped PR targeting main')
  check((await cli(maintainer, ['pr', 'diff', String(proposal.pullRequest), '-R', slug])).out.includes('+export const retryLimit = 3'), 'maintainer reviews real PR diff')
  await cli(maintainer, ['pr', 'merge', String(proposal.pullRequest), '-R', slug, '--squash'])
  const merged = await (await req(maintainer, R + '/blob?path=src/payments/retry.ts')).json() as { content: string }
  check(merged.content === updated, 'maintainer merges PR and main contains exact submitted bytes')
  await cli(developer, ['task', 'end', '--yes'])
  check(readdirSync(join(developer.env.DIT_CONFIG_DIR, 'task-drafts')).length === 0, 'ending task deletes remaining drafts')
  await cli(developer, ['task', 'connect', sid], { code: 1 })
  check((await req(developer, R + '/blob?path=src/payments/retry.ts', { headers })).status === 403, 'ended task loses server-side source access')
  const another = (await cli(maintainer, [...scopedAssign, '--yes'])).json().session.id
  await cli(developer, ['task', 'connect', another])
  await cli(maintainer, ['session', 'revoke', another])
  await cli(developer, ['task', 'cat', 'src/payments/retry.ts'], { code: 1 })
  check((await cli(developer, ['task', '--all', '--json'])).json().some((t: any) => t.sessionId === another && t.status === 'revoked'), 'maintainer revocation is enforced and visible in inbox')
  check(!existsSync(join(developer.home, '.git')), 'developer completes workflow without a clone')
  for (const who of [maintainer, developer, stranger]) {
    await cli(who, ['logout'])
    check(!existsSync(join(who.env.DIT_CONFIG_DIR, 'credentials.json')), 'logout removes test credentials')
  }
  console.log(`\nALL ${checks} CHECKS PASSED (installed binary, real API/SQLite/git${live ? ', live 0G' : ''})`)
} catch (error) {
  console.error(safe(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
