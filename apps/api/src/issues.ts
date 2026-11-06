import { Hono, type Context } from 'hono'
import { sql, json as toJson, parseJson, bool, now } from './db.ts'
import { authenticate, type AuthUser } from './auth.ts'
import { can, findRepo, type RepoRow } from './perm.ts'

export const issues = new Hono()
export type Level = Parameters<typeof can>[2]
export type Tx = import('bun').TransactionSQL

/** Resolve user + repo and enforce `need`. Repos the caller cannot read are reported as 404. */
export async function repoCtx(c: Context, need: Level = 'read', opts: { auth?: boolean } = {}): Promise<{ user: AuthUser | null; repo: RepoRow } | Response> {
  const user = await authenticate(c)
  const repo = await findRepo(c.req.param('owner')!, c.req.param('repo')!)
  if (!repo || !(await can(user, repo, 'read'))) return c.json({ error: 'not found' }, 404)
  if ((opts.auth || need !== 'read') && !user) return c.json({ error: 'sign in first' }, 401)
  if (need !== 'read' && !(await can(user, repo, need))) return c.json({ error: `requires ${need} access` }, 403)
  return { user, repo }
}
export const isResp = (x: unknown): x is Response => x instanceof Response

/** Allocate the next per-repo number (shared by issues and PRs); the upsert row-locks the counter so concurrent creators serialise. */
export async function allocateIssue(tx: Tx, a: { repoId: number; authorId: number | null; title: string; body: string | null; source?: unknown }): Promise<{ id: number; number: number }> {
  const [n] = await tx`INSERT INTO repo_counters (repo_id, last_number) VALUES (${a.repoId}, 1)
    ON CONFLICT (repo_id) DO UPDATE SET last_number = repo_counters.last_number + 1 RETURNING last_number`
  const [row] = await tx`INSERT INTO issues (repo_id, number, author_id, title, body, source)
    VALUES (${a.repoId}, ${n.last_number}, ${a.authorId}, ${a.title}, ${a.body}, ${a.source === undefined || a.source === null ? null : toJson(a.source)}) RETURNING id`
  return { id: Number(row.id), number: Number(n.last_number) }
}

export async function issueEvent(tx: Tx | typeof sql, issueId: number, actorId: number | null, event: string, payload: Record<string, unknown> = {}) {
  await tx`INSERT INTO issue_events (issue_id, actor_id, event, payload) VALUES (${issueId}, ${actorId}, ${event}, ${toJson(payload)})`
}
export async function activity(tx: Tx | typeof sql, repoId: number, actorId: number | null, kind: string, payload: Record<string, unknown>) {
  await tx`INSERT INTO activity (repo_id, actor_id, kind, payload) VALUES (${repoId}, ${actorId}, ${kind}, ${toJson(payload)})`
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : null)
const num = (v: string | undefined) => (v && /^\d{1,9}$/.test(v) ? Number(v) : null)
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const COLOR = /^[0-9a-fA-F]{6}$/

async function json<T>(c: Context): Promise<T | null> { try { return await c.req.json<T>() } catch { return null } }

export async function findIssue(repo: RepoRow, number: number) {
  const [i] = await sql`SELECT i.*, u.login AS author_login, (p.issue_id IS NOT NULL) AS is_pr FROM issues i
    LEFT JOIN users u ON u.id = i.author_id LEFT JOIN pull_requests p ON p.issue_id = i.id
    WHERE i.repo_id = ${repo.id} AND i.number = ${number}`
  return i as (Record<string, any> | undefined)
}

export async function issueView(i: Record<string, any>) {
  const labels = await sql`SELECT l.name, l.color, l.description FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = ${i.id} ORDER BY l.name`
  const assignees = await sql`SELECT u.login FROM issue_assignees a JOIN users u ON u.id = a.user_id WHERE a.issue_id = ${i.id} ORDER BY u.login`
  return {
    number: Number(i.number), title: i.title, body: i.body, state: i.state, stateReason: i.state_reason, locked: bool(i.locked),
    author: i.author_login ?? null, isPullRequest: !!i.is_pr, comments: Number(i.comments_count), labels,
    assignees: assignees.map((a: { login: string }) => a.login), source: parseJson(i.source) ?? null,
    createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at,
  }
}

// ---------- issues ----------
issues.post('/repos/:owner/:repo/issues', async (c) => {
  const r = await repoCtx(c, 'read', { auth: true }); if (isResp(r)) return r
  const { user, repo } = r
  const b = await json<{ title?: string; body?: string; labels?: string[]; assignees?: string[] }>(c)
  const title = str(b?.title, 300); if (!title) return c.json({ error: 'title is required (max 300 chars)' }, 400)
  if (b?.body != null && (typeof b.body !== 'string' || b.body.length > 65_536)) return c.json({ error: 'body too long' }, 400)
  const triage = await can(user, repo, 'triage')
  if ((b?.labels?.length || b?.assignees?.length) && !triage) return c.json({ error: 'labels and assignees need triage access' }, 403)
  const created = await sql.begin(async (tx) => {
    const issue = await allocateIssue(tx, { repoId: Number(repo.id), authorId: user!.id, title, body: b?.body ?? null })
    await issueEvent(tx, issue.id, user!.id, 'opened')
    for (const name of b?.labels ?? []) {
      const [l] = await tx`SELECT id FROM labels WHERE repo_id = ${repo.id} AND name = ${name}`
      if (!l) throw new Error(`unknown label ${name}`)
      await tx`INSERT INTO issue_labels (issue_id, label_id) VALUES (${issue.id}, ${l.id}) ON CONFLICT DO NOTHING`
    }
    for (const login of b?.assignees ?? []) {
      const [u] = await tx`SELECT id FROM users WHERE login = ${login}`
      if (!u) throw new Error(`unknown user ${login}`)
      await tx`INSERT INTO issue_assignees (issue_id, user_id) VALUES (${issue.id}, ${u.id}) ON CONFLICT DO NOTHING`
    }
    await activity(tx, Number(repo.id), user!.id, 'issue.opened', { number: issue.number })
    return issue
  }).catch((e: Error) => e)
  if (created instanceof Error) return c.json({ error: created.message }, 400)
  return c.json(await issueView((await findIssue(repo, created.number))!), 201)
})

issues.get('/repos/:owner/:repo/issues', async (c) => {
  const r = await repoCtx(c); if (isResp(r)) return r
  const { repo } = r
  const state = c.req.query('state') ?? 'open'
  if (!['open', 'closed', 'all'].includes(state)) return c.json({ error: 'state must be open, closed or all' }, 400)
  const labels = (c.req.queries('label') ?? []).flatMap((l) => l.split(',')).filter(Boolean)
  const assignee = c.req.query('assignee') ?? null, author = c.req.query('author') ?? null, q = c.req.query('q')?.slice(0, 200) ?? null
  const perPage = Math.min(100, Math.max(1, num(c.req.query('per_page')) ?? 30)), page = Math.max(1, num(c.req.query('page')) ?? 1)
  // Full-text search became LIKE: every word of q must appear in the title or body (ASCII case-insensitive).
  const words = (q ?? '').split(/\s+/).filter(Boolean).slice(0, 20).map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`)
  const where = sql`i.repo_id = ${repo.id} AND p.issue_id IS NULL AND (${state} = 'all' OR i.state = ${state})
    AND (${assignee} IS NULL OR EXISTS (SELECT 1 FROM issue_assignees a JOIN users u ON u.id = a.user_id WHERE a.issue_id = i.id AND u.login = ${assignee}))
    AND (${author} IS NULL OR au.login = ${author})
    AND NOT EXISTS (SELECT 1 FROM json_each(${toJson(words)}) w WHERE NOT (i.title LIKE w.value ESCAPE '\\' OR coalesce(i.body, '') LIKE w.value ESCAPE '\\'))
    AND (${labels.length} = 0 OR (SELECT count(DISTINCT l.name) FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id
      AND l.name IN (SELECT value FROM json_each(${toJson(labels)}))) = ${new Set(labels).size})`
  const [t] = await sql`SELECT count(*) AS n FROM issues i LEFT JOIN pull_requests p ON p.issue_id = i.id LEFT JOIN users au ON au.id = i.author_id WHERE ${where}`
  const rows = await sql`SELECT i.*, au.login AS author_login, false AS is_pr FROM issues i LEFT JOIN pull_requests p ON p.issue_id = i.id LEFT JOIN users au ON au.id = i.author_id
    WHERE ${where} ORDER BY i.updated_at DESC, i.id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`
  return c.json({ total: Number(t.n), page, perPage, issues: await Promise.all(rows.map((i: Record<string, any>) => issueView(i))) })
})

issues.get('/repos/:owner/:repo/issues/:number{[0-9]+}', async (c) => {
  const r = await repoCtx(c); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number')))
  return i ? c.json(await issueView(i)) : c.json({ error: 'not found' }, 404)
})

issues.get('/repos/:owner/:repo/issues/:number{[0-9]+}/events', async (c) => {
  const r = await repoCtx(c); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const rows = await sql`SELECT e.id, e.event, e.payload, e.created_at, u.login AS actor FROM issue_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.issue_id = ${i.id} ORDER BY e.id`
  return c.json({ events: rows.map((e: Record<string, any>) => ({ id: Number(e.id), event: e.event, actor: e.actor, payload: parseJson(e.payload), createdAt: e.created_at })) })
})

issues.patch('/repos/:owner/:repo/issues/:number{[0-9]+}', async (c) => {
  const r = await repoCtx(c, 'read', { auth: true }); if (isResp(r)) return r
  const { user, repo } = r
  const i = await findIssue(repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const triage = await can(user, repo, 'triage')
  const isAuthor = Number(i.author_id) === user!.id
  if (!triage && !isAuthor) return c.json({ error: 'only the author or triage+ can edit this issue' }, 403)
  const b = await json<{ title?: string; body?: string | null; state?: 'open' | 'closed'; stateReason?: string }>(c)
  if (!b) return c.json({ error: 'invalid JSON' }, 400)
  const title = b.title === undefined ? i.title : str(b.title, 300)
  if (!title) return c.json({ error: 'invalid title' }, 400)
  if (b.body !== undefined && b.body !== null && (typeof b.body !== 'string' || b.body.length > 65_536)) return c.json({ error: 'invalid body' }, 400)
  const body = b.body === undefined ? i.body : b.body
  if (b.state !== undefined && b.state !== 'open' && b.state !== 'closed') return c.json({ error: "state must be 'open' or 'closed'" }, 400)
  const state = b.state ?? i.state
  const reasons = ['completed', 'not_planned', 'reopened']
  if (b.stateReason !== undefined && !reasons.includes(b.stateReason)) return c.json({ error: 'invalid stateReason' }, 400)
  const reason = state === 'closed' ? (b.stateReason ?? 'completed') : state !== i.state ? 'reopened' : i.state_reason
  await sql.begin(async (tx) => {
    await tx`UPDATE issues SET title = ${title}, body = ${body}, state = ${state}, state_reason = ${reason},
      closed_at = ${state === 'closed' ? (i.state === 'closed' ? i.closed_at : now()) : null}, closed_by = ${state === 'closed' ? user!.id : null}, updated_at = ${now()} WHERE id = ${i.id}`
    if (title !== i.title) await issueEvent(tx, Number(i.id), user!.id, 'renamed', { from: i.title, to: title })
    if (state !== i.state) { await issueEvent(tx, Number(i.id), user!.id, state === 'closed' ? 'closed' : 'reopened', { reason }); await activity(tx, Number(repo.id), user!.id, `issue.${state === 'closed' ? 'closed' : 'reopened'}`, { number: Number(i.number) }) }
  })
  return c.json(await issueView((await findIssue(repo, Number(i.number)))!))
})

// ---------- comments (issue and PR threads share the same endpoints) ----------
issues.get('/repos/:owner/:repo/issues/:number{[0-9]+}/comments', async (c) => {
  const r = await repoCtx(c); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const rows = await sql`SELECT c.id, c.body, c.created_at, c.updated_at, u.login AS author FROM comments c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.issue_id = ${i.id} AND c.deleted_at IS NULL ORDER BY c.id`
  return c.json({ comments: rows.map((m: Record<string, any>) => ({ id: Number(m.id), body: m.body, author: m.author, createdAt: m.created_at, updatedAt: m.updated_at })) })
})

issues.post('/repos/:owner/:repo/issues/:number{[0-9]+}/comments', async (c) => {
  const r = await repoCtx(c, 'read', { auth: true }); if (isResp(r)) return r
  const { user, repo } = r
  const i = await findIssue(repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  if (bool(i.locked) && !(await can(user, repo, 'triage'))) return c.json({ error: 'issue is locked' }, 403)
  const b = await json<{ body?: string }>(c)
  const body = str(b?.body, 65_536); if (!body) return c.json({ error: 'body is required' }, 400)
  const m = await sql.begin(async (tx) => {
    const [row] = await tx`INSERT INTO comments (repo_id, issue_id, author_id, body) VALUES (${repo.id}, ${i.id}, ${user!.id}, ${body}) RETURNING id, created_at`
    await tx`UPDATE issues SET comments_count = comments_count + 1, updated_at = ${now()} WHERE id = ${i.id}`
    await activity(tx, Number(repo.id), user!.id, 'issue.commented', { number: Number(i.number), commentId: Number(row.id) })
    return row
  })
  return c.json({ id: Number(m.id), body, author: user!.login, createdAt: m.created_at }, 201)
})

async function findComment(repo: RepoRow, id: number) {
  const [m] = await sql`SELECT id, issue_id, author_id FROM comments WHERE id = ${id} AND repo_id = ${repo.id} AND deleted_at IS NULL`
  return m as { id: number; issue_id: number; author_id: number } | undefined
}
issues.patch('/repos/:owner/:repo/comments/:id{[0-9]+}', async (c) => {
  const r = await repoCtx(c, 'read', { auth: true }); if (isResp(r)) return r
  const m = await findComment(r.repo, Number(c.req.param('id'))); if (!m) return c.json({ error: 'not found' }, 404)
  if (Number(m.author_id) !== r.user!.id) return c.json({ error: 'only the author can edit a comment' }, 403)
  const body = str((await json<{ body?: string }>(c))?.body, 65_536); if (!body) return c.json({ error: 'body is required' }, 400)
  await sql`UPDATE comments SET body = ${body}, updated_at = ${now()} WHERE id = ${m.id}`
  return c.json({ ok: true })
})
issues.delete('/repos/:owner/:repo/comments/:id{[0-9]+}', async (c) => {
  const r = await repoCtx(c, 'read', { auth: true }); if (isResp(r)) return r
  const m = await findComment(r.repo, Number(c.req.param('id'))); if (!m) return c.json({ error: 'not found' }, 404)
  if (Number(m.author_id) !== r.user!.id && !(await can(r.user, r.repo, 'triage'))) return c.json({ error: 'only the author or triage+ can delete a comment' }, 403)
  await sql.begin(async (tx) => {
    await tx`UPDATE comments SET deleted_at = ${now()} WHERE id = ${m.id}`
    await tx`UPDATE issues SET comments_count = max(comments_count - 1, 0) WHERE id = ${m.issue_id}`
  })
  return c.json({ ok: true })
})

// ---------- labels ----------
issues.get('/repos/:owner/:repo/labels', async (c) => {
  const r = await repoCtx(c); if (isResp(r)) return r
  return c.json({ labels: await sql`SELECT name, color, description FROM labels WHERE repo_id = ${r.repo.id} ORDER BY name` })
})
issues.post('/repos/:owner/:repo/labels', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const b = await json<{ name?: string; color?: string; description?: string }>(c)
  const name = str(b?.name, 50), color = (b?.color ?? 'ededed').replace(/^#/, '')
  if (!name || !COLOR.test(color)) return c.json({ error: 'name (<=50) and a 6-digit hex color are required' }, 400)
  const ins = await sql`INSERT INTO labels (repo_id, name, color, description) VALUES (${r.repo.id}, ${name}, ${color.toLowerCase()}, ${b?.description?.slice(0, 200) ?? null})
    ON CONFLICT (repo_id, name) DO NOTHING RETURNING id`
  return ins.length ? c.json({ name, color: color.toLowerCase(), description: b?.description ?? null }, 201) : c.json({ error: 'label already exists' }, 409)
})
issues.patch('/repos/:owner/:repo/labels/:name', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const b = await json<{ name?: string; color?: string; description?: string }>(c)
  const [l] = await sql`SELECT id, name, color, description FROM labels WHERE repo_id = ${r.repo.id} AND name = ${c.req.param('name')}`
  if (!l) return c.json({ error: 'not found' }, 404)
  const name = b?.name === undefined ? l.name : str(b.name, 50), color = (b?.color ?? l.color).replace(/^#/, '')
  if (!name || !COLOR.test(color)) return c.json({ error: 'invalid name or color' }, 400)
  try { await sql`UPDATE labels SET name = ${name}, color = ${color.toLowerCase()}, description = ${b?.description === undefined ? l.description : b.description?.slice(0, 200) ?? null} WHERE id = ${l.id}` }
  catch { return c.json({ error: 'label name already exists' }, 409) }
  return c.json({ ok: true })
})
issues.delete('/repos/:owner/:repo/labels/:name', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const d = await sql`DELETE FROM labels WHERE repo_id = ${r.repo.id} AND name = ${c.req.param('name')} RETURNING id`
  return d.length ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})
issues.post('/repos/:owner/:repo/issues/:number{[0-9]+}/labels', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const names = (await json<{ labels?: string[] }>(c))?.labels
  if (!Array.isArray(names) || !names.length || names.length > 20) return c.json({ error: 'labels: string[] (1-20) required' }, 400)
  const res = await sql.begin(async (tx) => {
    for (const name of names) {
      const [l] = await tx`SELECT id FROM labels WHERE repo_id = ${r.repo.id} AND name = ${String(name)}`
      if (!l) return `unknown label ${name}`
      const ins = await tx`INSERT INTO issue_labels (issue_id, label_id) VALUES (${i.id}, ${l.id}) ON CONFLICT DO NOTHING RETURNING label_id`
      if (ins.length) await issueEvent(tx, Number(i.id), r.user!.id, 'labeled', { label: name })
    }
    await tx`UPDATE issues SET updated_at = ${now()} WHERE id = ${i.id}`
    return null
  })
  if (res) return c.json({ error: res }, 400)
  return c.json({ labels: (await issueView((await findIssue(r.repo, Number(i.number)))!)).labels })
})
issues.delete('/repos/:owner/:repo/issues/:number{[0-9]+}/labels/:name', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const d = await sql`DELETE FROM issue_labels WHERE issue_id = ${i.id} AND label_id = (SELECT id FROM labels WHERE repo_id = ${r.repo.id} AND name = ${c.req.param('name')}) RETURNING label_id`
  if (d.length) await issueEvent(sql, Number(i.id), r.user!.id, 'unlabeled', { label: c.req.param('name') })
  return d.length ? c.json({ ok: true }) : c.json({ error: 'label not attached' }, 404)
})

// ---------- assignees ----------
issues.post('/repos/:owner/:repo/issues/:number{[0-9]+}/assignees', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const logins = (await json<{ assignees?: string[] }>(c))?.assignees
  if (!Array.isArray(logins) || !logins.length || logins.length > 10 || logins.some((l) => typeof l !== 'string' || !LOGIN.test(l))) return c.json({ error: 'assignees: login[] (1-10) required' }, 400)
  const res = await sql.begin(async (tx) => {
    for (const login of logins) {
      const [u] = await tx`SELECT id FROM users WHERE login = ${login}`
      if (!u) return `unknown user ${login}`
      const ins = await tx`INSERT INTO issue_assignees (issue_id, user_id) VALUES (${i.id}, ${u.id}) ON CONFLICT DO NOTHING RETURNING user_id`
      if (ins.length) await issueEvent(tx, Number(i.id), r.user!.id, 'assigned', { assignee: login })
    }
    return null
  })
  if (res) return c.json({ error: res }, 400)
  return c.json({ assignees: (await issueView((await findIssue(r.repo, Number(i.number)))!)).assignees })
})
issues.delete('/repos/:owner/:repo/issues/:number{[0-9]+}/assignees/:login', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const i = await findIssue(r.repo, Number(c.req.param('number'))); if (!i) return c.json({ error: 'not found' }, 404)
  const d = await sql`DELETE FROM issue_assignees WHERE issue_id = ${i.id} AND user_id = (SELECT id FROM users WHERE login = ${c.req.param('login')}) RETURNING user_id`
  if (d.length) await issueEvent(sql, Number(i.id), r.user!.id, 'unassigned', { assignee: c.req.param('login') })
  return d.length ? c.json({ ok: true }) : c.json({ error: 'not assigned' }, 404)
})

// ---------- import from GitHub (public API, no auth) ----------
issues.post('/repos/:owner/:repo/issues/import', async (c) => {
  const r = await repoCtx(c, 'triage'); if (isResp(r)) return r
  const url = (await json<{ url?: string }>(c))?.url ?? ''
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/issues\/(\d{1,9})\/?$/.exec(url)
  if (!m) return c.json({ error: 'url must look like https://github.com/<owner>/<repo>/issues/<number>' }, 400)
  const [, owner, name, n] = m
  let gh: Record<string, any>
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${n}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dheet-importer' }, signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return c.json({ error: 'GitHub issue not found (or repository is private)' }, 404)
    if (!res.ok) return c.json({ error: `GitHub responded ${res.status}` }, 502)
    gh = await res.json() as Record<string, any>
  } catch (e) { return c.json({ error: `could not reach GitHub: ${(e as Error).message}` }, 502) }
  if (gh.pull_request) return c.json({ error: 'that URL is a pull request, not an issue' }, 400)
  const source = {
    provider: 'github', url: gh.html_url ?? url, owner, repo: name, number: Number(n), author: gh.user?.login ?? null,
    state: gh.state, createdAt: gh.created_at, labels: (gh.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean), importedAt: new Date().toISOString(),
  }
  const created = await sql.begin(async (tx) => {
    const issue = await allocateIssue(tx, { repoId: Number(r.repo.id), authorId: r.user!.id, title: String(gh.title ?? '').slice(0, 300) || `${owner}/${name}#${n}`, body: typeof gh.body === 'string' ? gh.body.slice(0, 65_536) : null, source })
    await issueEvent(tx, issue.id, r.user!.id, 'imported', { provider: 'github', url: source.url })
    await activity(tx, Number(r.repo.id), r.user!.id, 'issue.imported', { number: issue.number })
    return issue
  })
  return c.json(await issueView((await findIssue(r.repo, created.number))!), 201)
})
