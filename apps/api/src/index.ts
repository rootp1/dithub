import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { config, requireConfig } from './config.ts'
import { sql, hex, toHex } from './db.ts'
import { authenticate, createToken, issueNonce, logout, verifySiwe } from './auth.ts'
import { can, findRepo, type RepoRow } from './perm.ts'
import { deriveRepoId, git, initBare, installHooks, repoPath, runHttpBackend, safePath, safeRef } from './gitrepo.ts'
import { internal } from './internal.ts'
import { rbac } from './rbac.ts'
import { issues } from './issues.ts'
import { pulls } from './pulls.ts'
import { assistant } from './assistant.ts'
import { deployments } from './deployments.ts'
import { sessions, resolveAccess, scopeGuard, filterTree, scopedCommits, logSessionEvent } from './sessions.ts'

requireConfig()
// Keep every bare repo's hooks in step with this release.
for (const r of await sql`SELECT disk_path FROM repo_storage`) { try { installHooks(r.disk_path) } catch (e) { console.error('hook sync failed for', r.disk_path, e) } }
const app = new Hono()
app.use('*', logger())
app.use('/api/*', secureHeaders())

// Minimal in-memory per-IP limiter for auth and token endpoints (the edge proxy sets x-forwarded-for).
const hits = new Map<string, { n: number; reset: number }>()
app.use('/api/auth/*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  const now = Date.now(), h = hits.get(ip)
  if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + 60_000 })
  else if (++h.n > 30) return c.json({ error: 'too many requests' }, 429)
  await next()
})

app.get('/api/health', async (c) => {
  const [row] = await sql`SELECT 1 AS ok`
  return c.json({ ok: row?.ok === 1 })
})

// ---------- auth ----------
app.get('/api/auth/nonce', async (c) => c.json({ nonce: await issueNonce() }))
app.post('/api/auth/verify', async (c) => {
  const { message, signature } = await c.req.json<{ message: string; signature: `0x${string}` }>()
  try { return c.json({ user: await verifySiwe(c, message, signature) }) }
  catch (e) { return c.json({ error: (e as Error).message }, 401) }
})
app.post('/api/auth/logout', async (c) => { await logout(c); return c.json({ ok: true }) })
app.get('/api/me', async (c) => {
  const user = await authenticate(c)
  return user ? c.json({ user }) : c.json({ user: null })
})
app.post('/api/tokens', async (c) => {
  const user = await authenticate(c)
  if (!user) return c.json({ error: 'sign in first' }, 401)
  const { name } = await c.req.json<{ name?: string }>()
  return c.json({ token: await createToken(user.id, (name ?? 'cli').slice(0, 60)), note: 'shown once' })
})
app.patch('/api/me', async (c) => {
  const user = await authenticate(c)
  if (!user) return c.json({ error: 'sign in first' }, 401)
  const { login } = await c.req.json<{ login: string }>()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login ?? '')) return c.json({ error: 'login must be 1-39 chars of a-z, 0-9, -' }, 400)
  const taken = await sql`SELECT 1 FROM orgs WHERE login = ${login}`
  if (taken.length) return c.json({ error: 'name is taken' }, 409)
  if (login === user.login) return c.json({ ok: true, login })
  try {
    await sql.begin(async (tx) => {
      await tx`UPDATE users SET login = ${login}, updated_at = now() WHERE id = ${user.id}`
      // Repo names are keyed as "<owner>/<repo>" in the name registry: re-key this user's claims and queue fresh Arkiv claims
      // (Arkiv entities are read-only, so the old claim stays as history and the new name gets its own entity).
      const moved = await tx`UPDATE name_claims nc SET name = ${login} || '/' || r.name, arkiv_entity = NULL
        FROM repos r WHERE nc.dheet_repo_id = r.dheet_repo_id AND r.owner_kind = 'user' AND r.owner_id = ${user.id}
        RETURNING r.id AS repo_id, r.name AS repo_name, encode(nc.dheet_repo_id, 'hex') AS repo_hex`
      for (const m of moved) {
        await tx`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload)
          VALUES ('repo', ${m.repo_id}, 'name_claim', ${JSON.stringify({ repoId: `0x${m.repo_hex}`, name: `${login}/${m.repo_name}` })}::text::jsonb)`
      }
      await tx`INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata)
        VALUES (${user.id}, 'user.rename', 'user', ${user.id}, ${JSON.stringify({ from: user.login, to: login, repos: moved.length })}::text::jsonb)`
    })
  } catch { return c.json({ error: 'name is taken' }, 409) }
  return c.json({ ok: true, login })
})

// ---------- orgs (RBAC lives in rbac.ts) ----------
app.route('/api', rbac)
app.route('/api', issues)
app.route('/api', pulls)
app.route('/api', sessions)
app.route('/', assistant)
app.route('/api', deployments)

// ---------- repos ----------
const nameOk = (n: string) => /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== '.' && n !== '..' && !n.endsWith('.git')

app.post('/api/repos', async (c) => {
  const user = await authenticate(c)
  if (!user) return c.json({ error: 'sign in first' }, 401)
  const b = await c.req.json<{ name: string; org?: string; visibility?: 'public' | 'private'; description?: string }>()
  if (!nameOk(b.name ?? '')) return c.json({ error: 'invalid repo name' }, 400)
  let ownerKind: 'user' | 'org' = 'user', ownerId = user.id, ownerLogin = user.login
  if (b.org) {
    const [o] = await sql`SELECT o.id, o.login, o.visibility FROM orgs o JOIN org_members m ON m.org_id = o.id
      WHERE o.login = ${b.org} AND m.user_id = ${user.id} AND m.role = 'owner'`
    if (!o) return c.json({ error: 'you must own the organisation' }, 403)
    ownerKind = 'org'; ownerId = Number(o.id); ownerLogin = o.login
    if (o.visibility === 'private') b.visibility = 'private'
  }
  if (await findRepo(ownerLogin, b.name)) return c.json({ error: 'repository already exists' }, 409)
  const repoId = deriveRepoId(ownerLogin, b.name)
  await initBare(repoId, 'main')
  const [repo] = await sql.begin(async (tx) => {
    const [r] = await tx`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name, description, visibility)
      VALUES (${hex(repoId)}, ${ownerKind}, ${ownerId}, ${b.name}, ${b.description ?? null}, ${b.visibility ?? 'public'}) RETURNING id`
    await tx`INSERT INTO repo_storage (repo_id, disk_path, s3_prefix) VALUES (${r.id}, ${repoPath(repoId)}, ${`repos/${repoId.slice(2)}`})`
    await tx`INSERT INTO name_claims (name, dheet_repo_id, claimant) VALUES (${`${ownerLogin}/${b.name}`}, ${hex(repoId)}, ${hex(user.wallet ?? '0x' + '00'.repeat(20))})`
    await tx`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload)
      VALUES ('repo', ${r.id}, 'name_claim', ${JSON.stringify({ repoId, name: `${ownerLogin}/${b.name}` })}::text::jsonb)`
    return [r]
  })
  return c.json({ id: Number(repo.id), repoId, owner: ownerLogin, name: b.name, cloneUrl: `${config.publicUrl}/git/${ownerLogin}/${b.name}` }, 201)
})

app.get('/api/repos', async (c) => {
  const user = await authenticate(c)
  const rows = await sql`SELECT r.name, r.description, r.visibility, r.pushed_at, r.dheet_repo_id,
      COALESCE(u.login, o.login) AS owner, r.id, r.owner_kind, r.owner_id
    FROM repos r LEFT JOIN users u ON r.owner_kind='user' AND u.id=r.owner_id LEFT JOIN orgs o ON r.owner_kind='org' AND o.id=r.owner_id
    WHERE r.deleted_at IS NULL ORDER BY COALESCE(r.pushed_at, r.created_at) DESC LIMIT 100`
  const out = []
  for (const r of rows) if (await can(user, r as unknown as RepoRow, 'read')) out.push({
    owner: r.owner, name: r.name, description: r.description, visibility: r.visibility,
    pushedAt: r.pushed_at, repoId: toHex(r.dheet_repo_id) })
  return c.json({ repos: out })
})

async function loadRepo(c: import('hono').Context) {
  const repo = await findRepo(c.req.param('owner')!, c.req.param('repo')!)
  if (!repo) return { user: await authenticate(c), repo: null as RepoRow | null, scope: null, denied: null as { status: 401 | 403 | 404; error: string } | null }
  // A task session (x-dheet-session / ?session=) limits the caller to the session's scope.
  const acc = await resolveAccess(c, repo, 'read')
  if (!acc.ok) return { user: acc.user, repo: null as RepoRow | null, scope: null, denied: acc.error ? { status: acc.status, error: acc.error } : null }
  return { user: acc.user, repo, scope: acc.scope, denied: null }
}

app.get('/api/repos/:owner/:repo', async (c) => {
  const { user, repo, scope, denied } = await loadRepo(c)
  if (!repo) return denied ? c.json({ error: denied.error }, denied.status) : c.json({ error: 'not found' }, 404)
  const refs = (await sql`SELECT name, oid FROM git_refs WHERE repo_id = ${repo.id} ORDER BY name`)
    .filter((r: { name: string }) => !scope || scope.role === 'maintainer' || r.name === `refs/heads/${scope.ref}`)
  return c.json({
    owner: repo.owner_login, name: repo.name, description: repo.description, visibility: repo.visibility,
    defaultBranch: repo.default_branch, repoId: toHex(repo.dheet_repo_id), canWrite: scope ? false : await can(user, repo, 'write'), session: scope ? { id: scope.id, role: scope.role, ref: scope.ref, issueNumber: scope.issueNumber, expiresAt: scope.expiresAt } : null,
    cloneUrl: `${config.publicUrl}/git/${repo.owner_login}/${repo.name}`,
    refs: refs.map((r: { name: string; oid: Buffer }) => ({ name: r.name, oid: toHex(r.oid) })),
  })
})

app.get('/api/repos/:owner/:repo/tree', async (c) => {
  const { repo, scope, denied } = await loadRepo(c)
  if (!repo) return denied ? c.json({ error: denied.error }, denied.status) : c.json({ error: 'not found' }, 404)
  let ref = c.req.query('ref') ?? repo.default_branch, path = c.req.query('path') ?? ''
  if (scope) {
    const g = await scopeGuard(scope, 'tree', c.req.query('ref'), path)
    if (!g.ok) return c.json({ error: g.error }, g.status)
    ref = g.ref; path = g.path
  }
  if (!safeRef(ref) || !safePath(path)) return c.json({ error: 'bad ref or path' }, 400)
  const res = await git(repoPath(toHex(repo.dheet_repo_id)!), ['ls-tree', '-l', '-z', ref, ...(path ? [`${path.replace(/\/$/, '')}/`] : [])])
  if (res.code !== 0) return c.json({ entries: [] })
  const entries = res.out.split('\0').filter(Boolean).map((line) => {
    const [meta, name] = line.split('\t')
    const [mode, type, oid, size] = meta!.trim().split(/\s+/)
    return { mode, type, oid, size: size === '-' ? null : Number(size), name: name!.split('/').pop(), path: name }
  }).sort((a, b) => (a.type === b.type ? a.name!.localeCompare(b.name!) : a.type === 'tree' ? -1 : 1))
  return c.json({ entries: scope ? filterTree(scope, path, entries) : entries })
})

app.get('/api/repos/:owner/:repo/blob', async (c) => {
  const { repo, scope, denied } = await loadRepo(c)
  if (!repo) return denied ? c.json({ error: denied.error }, denied.status) : c.json({ error: 'not found' }, 404)
  let ref = c.req.query('ref') ?? repo.default_branch, path = c.req.query('path') ?? ''
  if (scope) {
    const g = await scopeGuard(scope, 'blob', c.req.query('ref'), path)
    if (!g.ok) return c.json({ error: g.error }, g.status)
    ref = g.ref; path = g.path
  }
  if (!path || !safeRef(ref) || !safePath(path)) return c.json({ error: 'bad ref or path' }, 400)
  const dir = repoPath(toHex(repo.dheet_repo_id)!)
  const size = await git(dir, ['cat-file', '-s', `${ref}:${path}`])
  if (size.code !== 0) return c.json({ error: 'not found' }, 404)
  const bytes = Number(size.out.trim())
  if (bytes > 1_000_000) return c.json({ path, size: bytes, truncated: true, content: null })
  const proc = Bun.spawn(['git', '-C', dir, 'cat-file', 'blob', `${ref}:${path}`], { stdout: 'pipe', env: { PATH: process.env.PATH ?? '' } })
  const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer())
  const binary = buf.subarray(0, 8000).includes(0)
  return c.json({ path, size: bytes, binary, content: binary ? null : buf.toString('utf8') })
})

app.get('/api/repos/:owner/:repo/commits', async (c) => {
  const { repo, scope, denied } = await loadRepo(c)
  if (!repo) return denied ? c.json({ error: denied.error }, denied.status) : c.json({ error: 'not found' }, 404)
  if (scope) return c.json({ commits: await scopedCommits(scope), scoped: true })
  const rows = await sql`SELECT c.oid, c.subject, c.author_name, c.author_email, c.committed_at, a.status, a.ref_name,
      a.l1_chain_id, a.l1_tx, a.l1_block, a.arkiv_tx, a.arkiv_entity
    FROM commits c LEFT JOIN commit_anchors a ON a.repo_id = c.repo_id AND a.commit_oid = c.oid
    WHERE c.repo_id = ${repo.id} ORDER BY c.committed_at DESC LIMIT 100`
  return c.json({ commits: rows.map((r: Record<string, unknown>) => ({
    oid: toHex(r.oid as Buffer), subject: r.subject, author: r.author_name, email: r.author_email, committedAt: r.committed_at,
    anchor: { status: r.status ?? 'none', ref: r.ref_name, l1ChainId: r.l1_chain_id, l1Tx: toHex(r.l1_tx as Buffer), arkivTx: toHex(r.arkiv_tx as Buffer), arkivEntity: toHex(r.arkiv_entity as Buffer) },
  })) })
})

app.get('/api/repos/:owner/:repo/ledger', async (c) => {
  const { repo, scope, denied } = await loadRepo(c)
  if (!repo) return denied ? c.json({ error: denied.error }, denied.status) : c.json({ error: 'not found' }, 404)
  if (scope) { await logSessionEvent(scope.id, scope.userId, 'denied', { kind: 'ledger' }); return c.json({ error: 'not available in a scoped session' }, 403) }
  const anchors = await sql`SELECT ref_name, chain_id, encode(contract,'hex') AS contract, encode(tx_hash,'hex') AS tx, ref_sequence, encode(ref_root,'hex') AS root
    FROM chain_anchors WHERE repo_id = ${repo.id} ORDER BY id DESC LIMIT 50`
  const entities = await sql`SELECT schema, encode(entity_key,'hex') AS entity, encode(tx_hash,'hex') AS tx, expires_at_block
    FROM arkiv_entities WHERE repo_id = ${repo.id} ORDER BY created_at DESC LIMIT 100`
  return c.json({ anchors, entities })
})

app.get('/api/names/:owner/:repo', async (c) => {
  const [row] = await sql`SELECT dheet_repo_id, claimant, arkiv_entity FROM name_claims WHERE name = ${`${c.req.param('owner')}/${c.req.param('repo')}`}`
  return row ? c.json({ repoId: toHex(row.dheet_repo_id), claimant: toHex(row.claimant), arkivEntity: toHex(row.arkiv_entity) }) : c.json({ error: 'unknown' }, 404)
})

// ---------- git smart HTTP ----------
app.all('/git/:owner/:repo/*', async (c) => {
  const owner = c.req.param('owner')!, name = c.req.param('repo')!.replace(/\.git$/, '')
  const repo = await findRepo(owner, name)
  if (!repo) return c.text('not found', 404)
  const url = new URL(c.req.url)
  const pathInfo = url.pathname.slice(`/git/${owner}/${c.req.param('repo')}`.length)
  const isPush = pathInfo.endsWith('git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack'
  const runGit = () => runHttpBackend({
    repoIdHex: toHex(repo.dheet_repo_id)!, pathInfo, method: c.req.method, query: url.search.slice(1),
    headers: c.req.raw.headers, body: c.req.raw.body, remoteUser: user?.login ?? null,
    extraEnv: {
      DHEET_INTERNAL_URL: `http://127.0.0.1:${config.port}`, DHEET_INTERNAL_TOKEN: config.internalToken,
      DHEET_REPO_ID: toHex(repo.dheet_repo_id)!, DHEET_USER_ID: user ? String(user.id) : '',
    },
  })
  const user = await authenticate(c)
  if (c.req.header('x-dheet-session') || c.req.query('session')) {
    // Clone/fetch hands over the whole history: only maintainer-role sessions may use it; pushes are never granted by a session.
    const acc = await resolveAccess(c, repo, 'read')
    if (!acc.ok) return new Response(acc.error ?? 'forbidden', acc.status === 401
      ? { status: 401, headers: { 'www-authenticate': 'Basic realm="Dithub (use a personal access token as password)"' } } : { status: 403 })
    if (acc.scope!.role !== 'maintainer') {
      await logSessionEvent(acc.scope!.id, acc.scope!.userId, 'clone_denied', { push: isPush })
      return new Response('git clone/fetch is not allowed for scoped sessions; use /api/sessions/:id/export', { status: 403 })
    }
    if (!isPush) return runGit()
  }
  if (isPush ? !(user && (await can(user, repo, 'write'))) : !(await can(user, repo, 'read'))) {
    return new Response(user ? 'forbidden' : 'authentication required', {
      status: user ? 403 : 401, headers: user ? {} : { 'www-authenticate': 'Basic realm="Dithub (use a personal access token as password)"' },
    })
  }
  return runGit()
})

app.route('/internal', internal)

// ---------- web app ----------
app.use('/*', async (c, next) => { await next(); if (!c.req.path.startsWith('/api') && !c.req.path.startsWith('/git') && c.res.status === 200) c.res.headers.set('cache-control', 'no-cache') })
app.use('/*', serveStatic({ root: config.webDir.replace(process.cwd() + '/', '') }))
app.get('*', async (c) => {
  const file = Bun.file(`${config.webDir}/index.html`)
  return (await file.exists()) ? c.html(await file.text()) : c.text('web app not built: run `bun run build:app`', 503)
})

export default { port: config.port, fetch: app.fetch, idleTimeout: 120 }
console.log(`dithub api listening on ${config.publicUrl}`)
