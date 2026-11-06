import { Hono, type Context } from 'hono'
import { sql, hex, toHex } from './db.ts'
import type { AuthUser } from './auth.ts'
import { can, type RepoRow } from './perm.ts'
import { listCommits, repoPath, safePath, safeRef } from './gitrepo.ts'
import { gitx } from './gitx.ts'
import { recordRefUpdates } from './internal.ts'
import { activity, allocateIssue, findIssue, isResp, issueEvent, issueView, repoCtx, type Tx } from './issues.ts'

export const pulls = new Hono()

const dirOf = (repo: RepoRow) => repoPath(toHex(repo.dheet_repo_id)!)
const branchName = (r: unknown) => (typeof r === 'string' ? r.replace(/^refs\/heads\//, '') : '')
const validBranch = (b: string) => b.length > 0 && safeRef(b) && !b.endsWith('/') && !b.endsWith('.lock') && !b.includes('//')
const OID = /^[0-9a-f]{40,64}$/
async function branchOid(dir: string, branch: string): Promise<string | null> {
  const r = await gitx(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  const oid = r.out.trim()
  return r.code === 0 && OID.test(oid) ? oid : null
}
const globToRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

/** Serialise merges per repo inside this process (the ref compare-and-swap protects across processes). */
const locks = new Map<number, Promise<unknown>>()
async function withRepoLock<T>(repoId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repoId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(repoId, next)
  try { return await next } finally { if (locks.get(repoId) === next) locks.delete(repoId) }
}

// ---------- git helpers ----------
export async function mergeBase(dir: string, a: string, b: string): Promise<string | null> {
  const r = await gitx(dir, ['merge-base', a, b]); return r.code === 0 ? r.out.trim() : null
}
export async function changedFiles(dir: string, base: string, head: string) {
  const [num, st] = await Promise.all([
    gitx(dir, ['diff', '-z', '--numstat', '-M', base, head, '--']),
    gitx(dir, ['diff', '-z', '--name-status', '-M', base, head, '--']),
  ])
  const nt = num.out.split('\0'), stats: Array<{ additions: number | null; deletions: number | null; path: string }> = []
  for (let i = 0; i < nt.length;) {
    const m = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(nt[i] ?? ''); if (!m) { i++; continue }
    const a = m[1] === '-' ? null : Number(m[1]), d = m[2] === '-' ? null : Number(m[2])
    if (m[3] === '') { stats.push({ additions: a, deletions: d, path: nt[i + 2] ?? '' }); i += 3 } else { stats.push({ additions: a, deletions: d, path: m[3]! }); i++ }
  }
  const tk = st.out.split('\0'), files: Array<{ path: string; oldPath: string | null; status: string; additions: number | null; deletions: number | null }> = []
  for (let i = 0, k = 0; i < tk.length && tk[i]; k++) {
    const code = tk[i]![0]!, rename = code === 'R' || code === 'C'
    const oldPath = rename ? tk[i + 1]! : null, path = rename ? tk[i + 2]! : tk[i + 1]!
    i += rename ? 3 : 2
    files.push({ path, oldPath, status: ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' } as Record<string, string>)[code] ?? code, additions: stats[k]?.additions ?? null, deletions: stats[k]?.deletions ?? null })
  }
  return files
}
async function mergeTree(dir: string, base: string, head: string, mergeBaseOid?: string) {
  const r = await gitx(dir, ['merge-tree', '--write-tree', ...(mergeBaseOid ? [`--merge-base=${mergeBaseOid}`] : []), base, head])
  const tree = r.out.split('\n')[0]!.trim()
  if (r.code === 0 && OID.test(tree)) return { clean: true as const, tree }
  if (r.code === 1) return { clean: false as const, tree: null }
  return { clean: null, tree: null }
}

// ---------- creation (shared with session proposals) ----------
export async function createPullRequest(a: { repo: RepoRow; user: AuthUser; title: string; body: string | null; head: string; base: string; draft?: boolean; sessionId?: string }):
  Promise<{ ok: true; number: number } | { ok: false; status: 400 | 409 | 422; error: string }> {
  const dir = dirOf(a.repo)
  if (!validBranch(a.head) || !validBranch(a.base)) return { ok: false, status: 400, error: 'invalid branch name' }
  if (a.head === a.base) return { ok: false, status: 422, error: 'head and base must differ' }
  const [headOid, baseOid] = await Promise.all([branchOid(dir, a.head), branchOid(dir, a.base)])
  if (!headOid) return { ok: false, status: 422, error: `branch ${a.head} not found` }
  if (!baseOid) return { ok: false, status: 422, error: `branch ${a.base} not found` }
  const mb = await mergeBase(dir, baseOid, headOid)
  if (!mb) return { ok: false, status: 422, error: 'branches share no history' }
  if (mb === headOid) return { ok: false, status: 422, error: 'head has no commits that base does not already contain' }
  const [dup] = await sql`SELECT i.number FROM pull_requests p JOIN issues i ON i.id = p.issue_id WHERE p.repo_id = ${a.repo.id} AND p.head_ref = ${a.head} AND p.base_ref = ${a.base} AND p.state = 'open'`
  if (dup) return { ok: false, status: 409, error: `an open pull request (#${dup.number}) already exists for these branches` }
  const files = await changedFiles(dir, mb, headOid)
  const sum = (k: 'additions' | 'deletions') => files.reduce((n, f) => n + (f[k] ?? 0), 0)
  const mt = await mergeTree(dir, baseOid, headOid)
  const created = await sql.begin(async (tx) => {
    const issue = await allocateIssue(tx, { repoId: Number(a.repo.id), authorId: a.user.id, title: a.title, body: a.body })
    await tx`INSERT INTO pull_requests (issue_id, repo_id, head_ref, head_oid, base_ref, base_oid, merge_base_oid, draft, mergeable, additions, deletions, changed_files, session_id)
      VALUES (${issue.id}, ${a.repo.id}, ${a.head}, ${hex(headOid)}, ${a.base}, ${hex(baseOid)}, ${hex(mb)}, ${a.draft ?? false}, ${mt.clean === null ? 'unknown' : mt.clean ? 'clean' : 'conflict'},
        ${sum('additions')}, ${sum('deletions')}, ${files.length}, ${a.sessionId ?? null}::uuid)`
    await issueEvent(tx, issue.id, a.user.id, 'opened', { head: a.head, base: a.base })
    await activity(tx, Number(a.repo.id), a.user.id, 'pr.opened', { number: issue.number, head: a.head, base: a.base })
    return issue
  })
  return { ok: true, number: created.number }
}

// ---------- views ----------
async function findPr(repo: RepoRow, number: number) {
  const [p] = await sql`SELECT p.*, i.number, i.title, i.body, i.author_id, u.login AS author_login, i.state AS issue_state FROM pull_requests p
    JOIN issues i ON i.id = p.issue_id LEFT JOIN users u ON u.id = i.author_id WHERE p.repo_id = ${repo.id} AND i.number = ${number}`
  return p as Record<string, any> | undefined
}

/** Refresh head/base oids and mergeability of an open PR from the live refs. */
async function syncPr(repo: RepoRow, p: Record<string, any>) {
  if (p.state !== 'open') return p
  const dir = dirOf(repo)
  const [head, base] = await Promise.all([branchOid(dir, p.head_ref), branchOid(dir, p.base_ref)])
  if (!head || !base) return p
  const mb = await mergeBase(dir, base, head)
  const mt = await mergeTree(dir, base, head)
  const mergeable = mt.clean === null ? 'unknown' : mt.clean ? 'clean' : 'conflict'
  if (toHex(p.head_oid) !== `0x${head}` || toHex(p.base_oid) !== `0x${base}` || p.mergeable !== mergeable) {
    const files = mb ? await changedFiles(dir, mb, head) : []
    await sql`UPDATE pull_requests SET head_oid = ${hex(head)}, base_oid = ${hex(base)}, merge_base_oid = ${mb ? hex(mb) : null}, mergeable = ${mergeable},
      additions = ${files.reduce((n, f) => n + (f.additions ?? 0), 0)}, deletions = ${files.reduce((n, f) => n + (f.deletions ?? 0), 0)}, changed_files = ${files.length} WHERE issue_id = ${p.issue_id}`
    if (toHex(p.head_oid) !== `0x${head}`) await issueEvent(sql, Number(p.issue_id), null, 'synchronize', { head })
    return (await findPr(repo, Number(p.number)))!
  }
  return p
}

async function protectionFor(repoId: number, base: string) {
  const rules = await sql`SELECT * FROM branch_protections WHERE repo_id = ${repoId}`
  return rules.find((r: { pattern: string }) => globToRegex(r.pattern).test(base)) as Record<string, any> | undefined
}

/** Latest submitted review per reviewer. Approvals only count on the current head and from users with write access. */
async function reviewState(repo: RepoRow, p: Record<string, any>) {
  const rows = await sql`SELECT DISTINCT ON (r.author_id) r.author_id, r.state, r.commit_oid, u.login, u.is_site_admin
    FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.pr_issue_id = ${p.issue_id} AND r.state IN ('approved','changes_requested','commented','dismissed')
    ORDER BY r.author_id, r.id DESC`
  const approvals: string[] = [], changes: string[] = []
  for (const r of rows) {
    if (Number(r.author_id) === Number(p.author_id)) continue
    if (r.state === 'changes_requested') changes.push(r.login)
    if (r.state === 'approved' && Buffer.compare(Buffer.from(r.commit_oid), Buffer.from(p.head_oid)) === 0) {
      const reviewer: AuthUser = { id: Number(r.author_id), login: r.login, wallet: null, isAdmin: r.is_site_admin }
      if (await can(reviewer, repo, 'write')) approvals.push(r.login)
    }
  }
  return { approvals, changesRequested: changes }
}

async function prView(repo: RepoRow, p: Record<string, any>) {
  const [iss] = await sql`SELECT i.*, u.login AS author_login, true AS is_pr FROM issues i LEFT JOIN users u ON u.id = i.author_id WHERE i.id = ${p.issue_id}`
  const base = await issueView(iss)
  const rule = await protectionFor(Number(repo.id), p.base_ref)
  const rs = await reviewState(repo, p)
  return {
    ...base, state: p.state as 'open' | 'closed' | 'merged', draft: p.draft, head: p.head_ref, base: p.base_ref,
    headOid: toHex(p.head_oid), baseOid: toHex(p.base_oid), mergeBaseOid: toHex(p.merge_base_oid), mergeable: p.mergeable,
    mergeMethod: p.merge_method, mergedAt: p.merged_at, mergeCommitOid: toHex(p.merge_commit_oid),
    additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files, fromSession: !!p.session_id,
    reviews: { approvals: rs.approvals, changesRequested: rs.changesRequested, requiredApprovals: rule ? Number(rule.required_approvals) : 0 },
    protection: rule ? { pattern: rule.pattern, requireStatusChecks: rule.require_status_checks } : null,
  }
}

async function prCtx(c: Context, need: 'read' | 'write' = 'read', auth = false) {
  const r = await repoCtx(c, need, { auth }); if (isResp(r)) return r
  const p = await findPr(r.repo, Number(c.req.param('number')))
  if (!p) return c.json({ error: 'not found' }, 404)
  return { ...r, p: await syncPr(r.repo, p) }
}

// ---------- endpoints ----------
pulls.post('/repos/:owner/:repo/pulls', async (c) => {
  const r = await repoCtx(c, 'write'); if (isResp(r)) return r
  let b: { title?: string; body?: string; head?: string; base?: string; draft?: boolean }
  try { b = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 300) return c.json({ error: 'title is required (max 300 chars)' }, 400)
  if (b.body != null && (typeof b.body !== 'string' || b.body.length > 65_536)) return c.json({ error: 'body too long' }, 400)
  const res = await createPullRequest({ repo: r.repo, user: r.user!, title: b.title, body: b.body ?? null, head: branchName(b.head), base: branchName(b.base ?? r.repo.default_branch), draft: !!b.draft })
  if (!res.ok) return c.json({ error: res.error }, res.status)
  const p = (await findPr(r.repo, res.number))!
  return c.json(await prView(r.repo, p), 201)
})

pulls.get('/repos/:owner/:repo/pulls', async (c) => {
  const r = await repoCtx(c); if (isResp(r)) return r
  const state = c.req.query('state') ?? 'open'
  if (!['open', 'closed', 'merged', 'all'].includes(state)) return c.json({ error: 'state must be open, closed, merged or all' }, 400)
  const perPage = Math.min(100, Math.max(1, Number(c.req.query('per_page')) || 30)), page = Math.max(1, Number(c.req.query('page')) || 1)
  const rows = await sql`SELECT p.*, i.number, i.title, u.login AS author_login, i.updated_at, i.created_at FROM pull_requests p JOIN issues i ON i.id = p.issue_id LEFT JOIN users u ON u.id = i.author_id
    WHERE p.repo_id = ${r.repo.id} AND (${state} = 'all' OR p.state = ${state}) ORDER BY i.number DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`
  const [t] = await sql`SELECT count(*)::int AS n FROM pull_requests p WHERE p.repo_id = ${r.repo.id} AND (${state} = 'all' OR p.state = ${state})`
  return c.json({ total: t.n, page, perPage, pulls: rows.map((p: Record<string, any>) => ({
    number: Number(p.number), title: p.title, state: p.state, draft: p.draft, author: p.author_login, head: p.head_ref, base: p.base_ref,
    mergeable: p.mergeable, additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files, createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at })) })
})

pulls.get('/repos/:owner/:repo/pulls/:number{[0-9]+}', async (c) => {
  const r = await prCtx(c); if (isResp(r)) return r
  return c.json(await prView(r.repo, r.p))
})

pulls.patch('/repos/:owner/:repo/pulls/:number{[0-9]+}', async (c) => {
  const r = await prCtx(c, 'read', true); if (isResp(r)) return r
  const { user, repo, p } = r
  if (Number(p.author_id) !== user!.id && !(await can(user, repo, 'write'))) return c.json({ error: 'only the author or write+ can edit this pull request' }, 403)
  let b: { title?: string; body?: string | null; state?: string; draft?: boolean }
  try { b = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  const title = b.title === undefined ? p.title : b.title
  if (typeof title !== 'string' || !title.trim() || title.length > 300) return c.json({ error: 'invalid title' }, 400)
  if (b.body != null && (typeof b.body !== 'string' || b.body.length > 65_536)) return c.json({ error: 'invalid body' }, 400)
  if (b.state !== undefined && b.state !== 'open' && b.state !== 'closed') return c.json({ error: "state must be 'open' or 'closed'" }, 400)
  if (p.state === 'merged' && b.state) return c.json({ error: 'a merged pull request cannot be reopened or closed' }, 409)
  const state = b.state ?? p.state
  if (state === 'open' && p.state === 'closed') {
    const [dup] = await sql`SELECT 1 FROM pull_requests WHERE repo_id = ${repo.id} AND head_ref = ${p.head_ref} AND base_ref = ${p.base_ref} AND state = 'open'`
    if (dup) return c.json({ error: 'another open pull request exists for these branches' }, 409)
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE pull_requests SET state = ${state}, draft = ${b.draft ?? p.draft} WHERE issue_id = ${p.issue_id}`
    await tx`UPDATE issues SET title = ${title}, body = ${b.body === undefined ? p.body : b.body}, state = ${state === 'open' ? 'open' : 'closed'},
      state_reason = ${state === 'open' ? (p.state === 'closed' ? 'reopened' : null) : p.state === 'merged' ? 'completed' : 'not_planned'},
      closed_at = ${state === 'open' ? null : new Date()}, closed_by = ${state === 'open' ? null : user!.id}, updated_at = now() WHERE id = ${p.issue_id}`
    if (state !== p.state) { await issueEvent(tx, Number(p.issue_id), user!.id, state === 'open' ? 'reopened' : 'closed'); await activity(tx, Number(repo.id), user!.id, `pr.${state === 'open' ? 'reopened' : 'closed'}`, { number: Number(p.number) }) }
  })
  return c.json(await prView(repo, await syncPr(repo, (await findPr(repo, Number(p.number)))!)))
})

pulls.get('/repos/:owner/:repo/pulls/:number{[0-9]+}/files', async (c) => {
  const r = await prCtx(c); if (isResp(r)) return r
  const mb = r.p.merge_base_oid ? toHex(r.p.merge_base_oid)!.slice(2) : null
  const head = r.p.state === 'merged' || r.p.state === 'closed' ? toHex(r.p.head_oid)!.slice(2) : toHex(r.p.head_oid)!.slice(2)
  return c.json({ files: mb ? await changedFiles(dirOf(r.repo), mb, head) : [] })
})

pulls.get('/repos/:owner/:repo/pulls/:number{[0-9]+}/diff', async (c) => {
  const r = await prCtx(c); if (isResp(r)) return r
  if (!r.p.merge_base_oid) return c.text('')
  const res = await gitx(dirOf(r.repo), ['diff', '-M', '--no-color', toHex(r.p.merge_base_oid)!.slice(2), toHex(r.p.head_oid)!.slice(2), '--'])
  const MAX = 2_000_000
  return new Response(res.out.length > MAX ? res.out.slice(0, MAX) + '\n# diff truncated\n' : res.out, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
})

pulls.get('/repos/:owner/:repo/pulls/:number{[0-9]+}/commits', async (c) => {
  const r = await prCtx(c); if (isResp(r)) return r
  const base = r.p.merge_base_oid ? toHex(r.p.merge_base_oid)!.slice(2) : null
  const commits = base ? await listCommits(dirOf(r.repo), [`${base}..${toHex(r.p.head_oid)!.slice(2)}`], 250) : []
  return c.json({ commits: commits.map((m) => ({ oid: `0x${m.oid}`, subject: m.subject, message: m.message, author: m.authorName, email: m.authorEmail, authoredAt: new Date(m.authoredAt * 1000).toISOString() })) })
})

pulls.get('/repos/:owner/:repo/pulls/:number{[0-9]+}/mergeable', async (c) => {
  const r = await prCtx(c); if (isResp(r)) return r
  const blockers = await mergeBlockers(r.repo, r.p)
  return c.json({ mergeable: r.p.mergeable, canMerge: blockers.length === 0 && r.p.state === 'open', blockers })
})

// ---------- reviews ----------
pulls.get('/repos/:owner/:repo/pulls/:number{[0-9]+}/reviews', async (c) => {
  const r = await prCtx(c); if (isResp(r)) return r
  const rows = await sql`SELECT r.id, r.state, r.body, r.commit_oid, r.submitted_at, u.login FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.pr_issue_id = ${r.p.issue_id} ORDER BY r.id`
  const cm = await sql`SELECT c.id, c.review_id, c.path, c.side, c.line, c.start_line, c.body, c.resolved, u.login FROM review_comments c JOIN users u ON u.id = c.author_id WHERE c.pr_issue_id = ${r.p.issue_id} ORDER BY c.id`
  return c.json({ reviews: rows.map((v: Record<string, any>) => ({
    id: Number(v.id), state: v.state, body: v.body, author: v.login, commitOid: toHex(v.commit_oid), submittedAt: v.submitted_at,
    comments: cm.filter((m: Record<string, any>) => Number(m.review_id) === Number(v.id)).map((m: Record<string, any>) => ({ id: Number(m.id), path: m.path, side: m.side, line: m.line, startLine: m.start_line, body: m.body, author: m.login, resolved: m.resolved })) })) })
})

pulls.post('/repos/:owner/:repo/pulls/:number{[0-9]+}/reviews', async (c) => {
  const r = await prCtx(c, 'read', true); if (isResp(r)) return r
  const { user, repo, p } = r
  let b: { event?: string; body?: string; comments?: Array<{ path?: string; line?: number; startLine?: number; side?: string; body?: string }> }
  try { b = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  const state = ({ approve: 'approved', request_changes: 'changes_requested', comment: 'commented' } as Record<string, string>)[b.event ?? '']
  if (!state) return c.json({ error: "event must be 'approve', 'request_changes' or 'comment'" }, 400)
  if (p.state !== 'open') return c.json({ error: 'pull request is not open' }, 409)
  if (state !== 'commented') {
    if (Number(p.author_id) === user!.id) return c.json({ error: 'authors cannot approve or request changes on their own pull request' }, 403)
    if (!(await can(user, repo, 'write'))) return c.json({ error: 'approving or requesting changes needs write access' }, 403)
  }
  const body = typeof b.body === 'string' ? b.body.slice(0, 65_536) : null
  const comments = b.comments ?? []
  if (!Array.isArray(comments) || comments.length > 100) return c.json({ error: 'comments: up to 100' }, 400)
  if ((state === 'changes_requested' || (state === 'commented' && !comments.length)) && !body?.trim()) return c.json({ error: 'body is required' }, 400)
  for (const m of comments) {
    if (typeof m.path !== 'string' || !m.path || !safePath(m.path) || m.path.length > 1024 || typeof m.body !== 'string' || !m.body.trim() || m.body.length > 16_384
      || !Number.isInteger(m.line) || m.line! < 1 || !['LEFT', 'RIGHT'].includes(m.side ?? 'RIGHT')) return c.json({ error: 'each comment needs path, line, body and side LEFT|RIGHT' }, 400)
  }
  const id = await sql.begin(async (tx) => {
    const [rv] = await tx`INSERT INTO reviews (pr_issue_id, author_id, commit_oid, state, body, submitted_at) VALUES (${p.issue_id}, ${user!.id}, ${p.head_oid}, ${state}, ${body}, now()) RETURNING id`
    for (const m of comments) await tx`INSERT INTO review_comments (review_id, pr_issue_id, author_id, commit_oid, path, side, line, start_line, body)
      VALUES (${rv.id}, ${p.issue_id}, ${user!.id}, ${p.head_oid}, ${m.path}, ${m.side ?? 'RIGHT'}, ${m.line}, ${m.startLine ?? null}, ${m.body})`
    await issueEvent(tx, Number(p.issue_id), user!.id, `review_${state}`, { reviewId: Number(rv.id) })
    await activity(tx, Number(repo.id), user!.id, 'pr.reviewed', { number: Number(p.number), state })
    await tx`UPDATE issues SET updated_at = now() WHERE id = ${p.issue_id}`
    return Number(rv.id)
  })
  return c.json({ id, state, commitOid: toHex(p.head_oid) }, 201)
})

// ---------- merge ----------
async function mergeBlockers(repo: RepoRow, p: Record<string, any>): Promise<string[]> {
  const out: string[] = []
  if (p.state !== 'open') return [`pull request is ${p.state}`]
  if (p.draft) out.push('pull request is a draft')
  if (p.mergeable === 'conflict') out.push('merge conflicts with the base branch')
  const rule = await protectionFor(Number(repo.id), p.base_ref)
  const rs = await reviewState(repo, p)
  if (rs.changesRequested.length) out.push(`changes requested by ${rs.changesRequested.join(', ')}`)
  if (rule) {
    const need = Number(rule.required_approvals)
    if (rs.approvals.length < need) out.push(`needs ${need} approving review(s) on the current head, has ${rs.approvals.length}`)
    for (const name of rule.require_status_checks as string[]) {
      const [ck] = await sql`SELECT conclusion FROM check_runs WHERE repo_id = ${repo.id} AND head_oid = ${p.head_oid} AND name = ${name} ORDER BY id DESC LIMIT 1`
      if (ck?.conclusion !== 'success') out.push(`required status check "${name}" has not passed`)
    }
  }
  return out
}

const identity = (name: string, email: string, date?: string) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, ...(date ? { GIT_AUTHOR_DATE: date } : {}) })
const noreply = (login: string) => `${login}@users.noreply.dheet`

async function commitTree(dir: string, tree: string, parents: string[], message: string, env: Record<string, string>) {
  const r = await gitx(dir, ['commit-tree', tree, ...parents.flatMap((x) => ['-p', x]), '-F', '-'], { env, input: message })
  if (r.code !== 0) throw new Error(`commit-tree failed: ${r.err.trim()}`)
  return r.out.trim()
}

/** Merge entirely with plumbing (merge-tree + commit-tree) in memory: no worktree or checkout is created, so nothing needs cleanup. */
async function computeMerge(dir: string, method: 'merge' | 'squash' | 'rebase', base: string, head: string, mergerEnv: Record<string, string>, msg: string, author: { name: string; email: string }):
  Promise<{ ok: true; oid: string } | { ok: false; error: string }> {
  if (method === 'rebase') {
    const list = await gitx(dir, ['rev-list', '--reverse', '--topo-order', '--no-merges', `${base}..${head}`])
    let cur = base
    for (const cm of list.out.split('\n').filter(Boolean)) {
      const parent = await gitx(dir, ['rev-parse', '--verify', '--quiet', `${cm}^`])
      if (parent.code !== 0) return { ok: false, error: 'cannot rebase a root commit' }
      const mt = await mergeTree(dir, cur, cm, parent.out.trim())
      if (mt.clean !== true) return { ok: false, error: `conflict while rebasing ${cm.slice(0, 8)}` }
      const curTree = (await gitx(dir, ['rev-parse', `${cur}^{tree}`])).out.trim()
      if (mt.tree === curTree) continue
      const info = (await gitx(dir, ['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', cm])).out.split('\0')
      cur = await commitTree(dir, mt.tree, [cur], (info[3] ?? '').trimEnd() + '\n', { ...mergerEnv, GIT_AUTHOR_NAME: info[0]!, GIT_AUTHOR_EMAIL: info[1]!, GIT_AUTHOR_DATE: info[2]! })
    }
    return cur === base ? { ok: false, error: 'nothing to merge' } : { ok: true, oid: cur }
  }
  if ((await gitx(dir, ['merge-base', '--is-ancestor', head, base])).code === 0) return { ok: false, error: 'nothing to merge: base already contains head' }
  const mt = await mergeTree(dir, base, head)
  if (mt.clean !== true) return { ok: false, error: mt.clean === false ? 'merge conflicts with the base branch' : 'branches cannot be merged' }
  const env = method === 'squash' ? { ...mergerEnv, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : mergerEnv
  return { ok: true, oid: await commitTree(dir, mt.tree, method === 'squash' ? [base] : [base, head], msg, env) }
}

pulls.post('/repos/:owner/:repo/pulls/:number{[0-9]+}/merge', async (c) => {
  const r = await prCtx(c, 'write'); if (isResp(r)) return r
  const { user, repo } = r
  let b: { method?: string; commitTitle?: string; commitMessage?: string } = {}
  try { b = await c.req.json() } catch { /* body optional */ }
  const method = (b.method ?? 'merge') as 'merge' | 'squash' | 'rebase'
  if (!['merge', 'squash', 'rebase'].includes(method)) return c.json({ error: "method must be 'merge', 'squash' or 'rebase'" }, 400)
  return withRepoLock(Number(repo.id), async () => {
    const p = await syncPr(repo, (await findPr(repo, Number(r.p.number)))!)
    const blockers = await mergeBlockers(repo, p)
    if (blockers.length) return c.json({ error: 'pull request cannot be merged', blockers }, 409)
    const dir = dirOf(repo), repoIdHex = toHex(repo.dheet_repo_id)!
    const base = toHex(p.base_oid)!.slice(2), head = toHex(p.head_oid)!.slice(2)
    const title = (b.commitTitle ?? (method === 'merge' ? `Merge pull request #${p.number} from ${p.head_ref}` : `${p.title} (#${p.number})`)).slice(0, 300)
    const msg = `${title}\n\n${(b.commitMessage ?? (method === 'merge' ? p.title : '')).slice(0, 10_000)}`.trimEnd() + '\n'
    const res = await computeMerge(dir, method, base, head, identity(user!.login, noreply(user!.login)), msg, { name: p.author_login ?? user!.login, email: noreply(p.author_login ?? user!.login) })
    if (!res.ok) return c.json({ error: res.error }, 409)
    // Server-side ref update: compare-and-swap on the base ref. receive-pack (and its pre-receive rules) is bypassed on purpose: merging a PR is how protected branches advance.
    const upd = await gitx(dir, ['update-ref', '-m', `merge pull request #${p.number}`, `refs/heads/${p.base_ref}`, res.oid, base])
    if (upd.code !== 0) return c.json({ error: 'base branch moved while merging; retry' }, 409)
    await recordRefUpdates(repo, user!, repoIdHex, [{ oldOid: base, newOid: res.oid, ref: `refs/heads/${p.base_ref}` }])
    await sql.begin(async (tx: Tx) => {
      await tx`UPDATE pull_requests SET state = 'merged', merge_method = ${method}, merged_by = ${user!.id}, merged_at = now(), merge_commit_oid = ${hex(res.oid)} WHERE issue_id = ${p.issue_id}`
      await tx`UPDATE issues SET state = 'closed', state_reason = 'completed', closed_at = now(), closed_by = ${user!.id}, updated_at = now() WHERE id = ${p.issue_id}`
      await issueEvent(tx, Number(p.issue_id), user!.id, 'merged', { method, commit: res.oid })
      await activity(tx, Number(repo.id), user!.id, 'pr.merged', { number: Number(p.number), method, commit: res.oid })
    })
    return c.json({ merged: true, method, mergeCommitOid: `0x${res.oid}`, ref: `refs/heads/${p.base_ref}` })
  })
})
