import { Hono, type Context } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, toHex } from './db.ts'
import { authenticate, type AuthUser } from './auth.ts'
import { can, findRepo, type RepoRow } from './perm.ts'
import { recordRbac } from './rbac.ts'
import { repoPath, safeRef, ZERO_OID } from './gitrepo.ts'
import { gitx } from './gitx.ts'
import { recordRefUpdates } from './internal.ts'
import { createPullRequest } from './pulls.ts'
import { issueEvent } from './issues.ts'

export const sessions = new Hono()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
export type Role = 'contractor' | 'employee' | 'maintainer'

// ---------- path scope ----------
/** Canonical form of a repo path: NFC, no empty/./.. segments, no leading slash, no control, bidi or zero-width characters, no backslash, no `.git` segment. */
export function normalizePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 1024) return null
  if (/[\u0000-\u001f\u007f\\]/.test(p) || /[​-‏‪-‮⁠-⁤﻿]/.test(p)) return null
  if (p !== p.normalize('NFC') || p.startsWith('/')) return null
  const segs = p.endsWith('/') ? p.slice(0, -1).split('/') : p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) return null
  return segs.join('/')
}
/** For paths a caller wants to read: additionally no glob or pathspec-magic characters. */
export const normalizeReadPath = (p: unknown) => { const n = normalizePath(p); return n && !/[*?[\]]/.test(n) && !n.startsWith(':') ? n : null }
/** Scope entries may use `*` inside a segment and `**` as a final segment ("everything below"). */
export function normalizeScopeEntry(p: unknown): string | null {
  const n = normalizePath(p); if (!n || /[?[\]]/.test(n) || n.startsWith(':')) return null
  const segs = n.split('/')
  if (segs.some((s, i) => (s.includes('**') && s !== '**') || (s === '**' && i !== segs.length - 1))) return null
  return n
}
const segMatch = (pat: string, seg: string) => !pat.includes('*') ? pat === seg
  : new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(seg)

/** True when `path` equals an allowed entry or lies below it (segment boundaries, case-sensitive like git). */
export function pathInScope(allowedPaths: string[], path: string): boolean {
  const n = normalizePath(path); if (!n) return false
  const p = n.split('/')
  return allowedPaths.some((entry) => {
    const e = entry.split('/')
    for (let i = 0; i < e.length; i++) {
      if (e[i] === '**') return true
      if (i >= p.length || !segMatch(e[i]!, p[i]!)) return false
    }
    return true
  })
}
/** True when `dir` is a strict or equal ancestor of an allowed entry (needed to navigate down to in-scope files). */
export function isAncestorOfScope(allowedPaths: string[], dir: string): boolean {
  const d = dir === '' ? [] : dir.split('/')
  return allowedPaths.some((entry) => {
    const e = entry.split('/')
    for (let i = 0; i < d.length; i++) {
      if (e[i] === '**') return true
      if (i >= e.length || !segMatch(e[i]!, d[i]!)) return false
    }
    return true
  })
}

// ---------- session lookup / audit ----------
export type SessionScope = NonNullable<Awaited<ReturnType<typeof loadSessionForUser>>>

export async function loadSessionForUser(sessionId: string, userId: number): Promise<{ id: string; repoId: number; repoIdHex: string; issueId: number; issueNumber: number; userId: number; role: 'contractor' | 'employee' | 'maintainer'; allowedPaths: string[]; ref: string; expiresAt: Date } | null> {
  if (!UUID.test(sessionId)) return null
  const [s] = await sql`SELECT s.id, s.repo_id, s.issue_id, s.user_id, s.role, s.allowed_paths, s.ref, s.expires_at, i.number, r.dheet_repo_id
    FROM task_sessions s JOIN issues i ON i.id = s.issue_id JOIN repos r ON r.id = s.repo_id
    WHERE s.id = ${sessionId}::uuid AND s.user_id = ${userId} AND s.status = 'active' AND s.expires_at > now() AND r.deleted_at IS NULL`
  if (!s) return null
  return { id: s.id, repoId: Number(s.repo_id), repoIdHex: toHex(s.dheet_repo_id)!, issueId: Number(s.issue_id), issueNumber: Number(s.number), userId: Number(s.user_id),
    role: s.role, allowedPaths: s.allowed_paths, ref: s.ref, expiresAt: new Date(s.expires_at) }
}

export async function logSessionEvent(sessionId: string, actorId: number | null, kind: string, detail: Record<string, unknown>): Promise<void> {
  if (!UUID.test(sessionId)) return
  await sql`INSERT INTO session_events (session_id, actor_id, kind, detail) VALUES (${sessionId}::uuid, ${actorId}, ${kind}, ${JSON.stringify(detail)}::text::jsonb)`
}

export interface Access { user: AuthUser | null; scope: SessionScope | null; ok: boolean; status: 401 | 403 | 404; error?: string }

/** Decide how the caller may use `repo`. A session (header `x-dheet-session` or `?session=`) limits the caller to that session's scope and, for contractor/employee, is the ONLY thing that grants access. */
export async function resolveAccess(c: Context, repo: RepoRow, need: 'read' | 'write' = 'read'): Promise<Access> {
  const user = await authenticate(c)
  const sid = c.req.header('x-dheet-session') ?? c.req.query('session')
  if (!sid) return { user, scope: null, ok: await can(user, repo, need), status: user ? 404 : 401 }
  if (!user) return { user, scope: null, ok: false, status: 401, error: 'sign in first' }
  const scope = await loadSessionForUser(sid, user.id)
  if (!scope || scope.repoId !== Number(repo.id)) {
    if (UUID.test(sid)) {
      const [own] = await sql`SELECT 1 FROM task_sessions WHERE id = ${sid}::uuid AND user_id = ${user.id}`
      if (own) await logSessionEvent(sid, user.id, 'denied', { reason: scope ? 'wrong repository' : 'session not active' })
    }
    return { user, scope: null, ok: false, status: 403, error: 'invalid, expired or revoked session' }
  }
  if (need !== 'read') return { user, scope, ok: false, status: 403, error: 'sessions grant read access only' }
  return { user, scope, ok: true, status: 404 }
}

const unrestricted = (s: SessionScope) => s.role === 'maintainer'

/** Validate ref/path of a code-browser read against the scope. Every call is audited. */
export async function scopeGuard(scope: SessionScope, kind: 'tree' | 'blob', ref: string | undefined, path: string):
  Promise<{ ok: true; ref: string; path: string } | { ok: false; status: 400 | 403; error: string }> {
  const deny = async (why: string) => { await logSessionEvent(scope.id, scope.userId, 'denied', { kind, path: path.slice(0, 200), why }); return { ok: false as const, status: 403 as const, error: 'outside the scope of this session' } }
  if (ref !== undefined && ref !== scope.ref && !unrestricted(scope)) return deny('ref')
  const useRef = ref ?? scope.ref
  if (!safeRef(useRef)) return { ok: false, status: 400, error: 'bad ref' }
  let p = path.replace(/\/$/, '')
  if (p !== '') { const n = normalizeReadPath(p); if (!n) return deny('bad path'); p = n }
  if (!unrestricted(scope)) {
    const rootOk = p === '' && kind === 'tree'
    const ok = rootOk || pathInScope(scope.allowedPaths, p) || (kind === 'tree' && isAncestorOfScope(scope.allowedPaths, p))
    if (!ok) return deny('out of scope')
  }
  await logSessionEvent(scope.id, scope.userId, kind, { path: p })
  return { ok: true, ref: useRef, path: p }
}

/** Filter a directory listing: contractors see in-scope entries and the directories leading to them; employees also see top-level names (no metadata) at the root. */
type TreeEntry = { type?: string | undefined; path?: string | undefined; name?: string | undefined }
export function filterTree<T extends TreeEntry>(scope: SessionScope, dir: string, entries: T[]): Array<T | (TreeEntry & { restricted: true })> {
  if (unrestricted(scope)) return entries
  const out: Array<T | (TreeEntry & { restricted: true })> = []
  for (const e of entries) {
    const p = e.path ?? ''
    if (pathInScope(scope.allowedPaths, p) || (e.type === 'tree' && isAncestorOfScope(scope.allowedPaths, p))) out.push(e)
    else if (scope.role === 'employee' && dir === '') out.push({ type: e.type, name: e.name, path: e.path, restricted: true })
  }
  return out
}

/** Commits that touch in-scope paths only, with out-of-scope file names omitted. */
export async function scopedCommits(scope: SessionScope) {
  const dir = repoPath(scope.repoIdHex)
  const specs = unrestricted(scope) ? [] : scope.allowedPaths.map((e) => `:(top,glob)${e}`)
  const SEP = '\u0001', F = '\u0002'
  const r = await gitx(dir, ['-c', 'core.quotePath=false', 'log', '--max-count=100', '--name-only', `--format=${SEP}%H${F}%an${F}%ae${F}%ct${F}%s`, scope.ref, '--', ...specs])
  if (r.code !== 0) return []
  await logSessionEvent(scope.id, scope.userId, 'commits', {})
  return r.out.split(SEP).filter(Boolean).map((chunk) => {
    const [head, ...files] = chunk.split('\n')
    const [oid, author, email, ct, subject] = head!.split(F)
    return { oid: `0x${oid}`, subject, author, email, committedAt: new Date(Number(ct) * 1000).toISOString(),
      files: files.filter((f) => f && (unrestricted(scope) || pathInScope(scope.allowedPaths, f))) }
  }).filter((c) => unrestricted(scope) || c.files.length > 0)
}

// ---------- helpers ----------
async function sessionRow(id: string) {
  if (!UUID.test(id)) return null
  await sql`UPDATE task_sessions SET status = 'expired', ended_at = expires_at WHERE id = ${id}::uuid AND status = 'active' AND expires_at <= now()`
  const [s] = await sql`SELECT s.*, i.number AS issue_number, d.login AS user_login, m.login AS created_by_login FROM task_sessions s
    JOIN issues i ON i.id = s.issue_id JOIN users d ON d.id = s.user_id JOIN users m ON m.id = s.created_by WHERE s.id = ${id}::uuid`
  return s as Record<string, any> | undefined
}
const view = (s: Record<string, any>) => ({
  id: s.id, repoId: Number(s.repo_id), issueNumber: Number(s.issue_number), user: s.user_login, createdBy: s.created_by_login, role: s.role,
  allowedPaths: s.allowed_paths, ref: s.ref, status: s.status, expiresAt: s.expires_at, createdAt: s.created_at, endedAt: s.ended_at, endReason: s.end_reason,
})
async function repoById(id: number): Promise<RepoRow | null> {
  const [r] = await sql`SELECT r.*, COALESCE(u.login, o.login) AS owner_login FROM repos r LEFT JOIN users u ON r.owner_kind='user' AND u.id=r.owner_id LEFT JOIN orgs o ON r.owner_kind='org' AND o.id=r.owner_id WHERE r.id = ${id} AND r.deleted_at IS NULL`
  return (r as RepoRow | undefined) ?? null
}
const orgIdOf = (repo: RepoRow) => (repo.owner_kind === 'org' ? Number(repo.owner_id) : null)

// ---------- endpoints ----------
sessions.post('/repos/:owner/:repo/sessions', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const repo = await findRepo(c.req.param('owner')!, c.req.param('repo')!)
  if (!repo || !(await can(user, repo, 'read'))) return c.json({ error: 'not found' }, 404)
  if (!(await can(user, repo, 'maintain'))) return c.json({ error: 'only repository maintainers and admins can create sessions' }, 403)
  let b: { issueNumber?: number; login?: string; role?: string; paths?: string[]; ttlMinutes?: number; ref?: string }
  try { b = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  if (!Number.isInteger(b.issueNumber)) return c.json({ error: 'issueNumber is required' }, 400)
  if (typeof b.login !== 'string' || !LOGIN.test(b.login)) return c.json({ error: 'login is required' }, 400)
  if (!['contractor', 'employee', 'maintainer'].includes(b.role ?? '')) return c.json({ error: "role must be 'contractor', 'employee' or 'maintainer'" }, 400)
  const role = b.role as Role
  const ttl = b.ttlMinutes ?? 480
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1440) return c.json({ error: 'ttlMinutes must be an integer between 1 and 1440' }, 400)
  let paths: string[]
  if (role === 'maintainer' && (!b.paths || b.paths.length === 0)) paths = ['**']
  else {
    if (!Array.isArray(b.paths) || b.paths.length < 1 || b.paths.length > 50) return c.json({ error: 'paths: 1-50 path prefixes required' }, 400)
    const norm = b.paths.map(normalizeScopeEntry)
    if (norm.some((n) => !n)) return c.json({ error: 'invalid path (no "..", absolute paths, backslashes, control characters, or odd globs)' }, 400)
    paths = [...new Set(norm as string[])]
    if (role !== 'maintainer' && paths.some((p) => p.split('/')[0]!.includes('*'))) return c.json({ error: 'a scope entry cannot start with a wildcard' }, 400)
  }
  const ref = b.ref ?? repo.default_branch
  if (!safeRef(ref)) return c.json({ error: 'bad ref' }, 400)
  const [target] = await sql`SELECT id, login FROM users WHERE login = ${b.login}`
  if (!target) return c.json({ error: 'no such user' }, 404)
  const [issue] = await sql`SELECT i.id, i.number FROM issues i LEFT JOIN pull_requests p ON p.issue_id = i.id WHERE i.repo_id = ${repo.id} AND i.number = ${b.issueNumber} AND p.issue_id IS NULL`
  if (!issue) return c.json({ error: 'issue not found' }, 404)
  if ((await gitx(repoPath(toHex(repo.dheet_repo_id)!), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code !== 0) return c.json({ error: `ref ${ref} does not exist (push something first)` }, 422)
  await sql`UPDATE task_sessions SET status = 'expired', ended_at = expires_at WHERE user_id = ${target.id} AND issue_id = ${issue.id} AND status = 'active' AND expires_at <= now()`
  const res = await sql.begin(async (tx) => {
    const ins = await tx`INSERT INTO task_sessions (repo_id, issue_id, user_id, created_by, role, allowed_paths, ref, expires_at)
      VALUES (${repo.id}, ${issue.id}, ${target.id}, ${user.id}, ${role}, ${paths}, ${ref}, now() + (${ttl} * interval '1 minute'))
      ON CONFLICT DO NOTHING RETURNING id`
    if (!ins.length) return null
    const id = ins[0].id as string
    await tx`INSERT INTO issue_assignees (issue_id, user_id) VALUES (${issue.id}, ${target.id}) ON CONFLICT DO NOTHING`
    await issueEvent(tx, Number(issue.id), user.id, 'session_started', { sessionId: id })
    await tx`INSERT INTO session_events (session_id, actor_id, kind, detail) VALUES (${id}::uuid, ${user.id}, 'create', ${JSON.stringify({ role, paths: paths.length, ttlMinutes: ttl })}::text::jsonb)`
    await recordRbac(tx, { orgId: orgIdOf(repo), actor: user, action: 'session.create', payload: { session: id, repo: Number(repo.id), issue: Number(issue.number), user: Number(target.id), role, pathCount: paths.length, ttlMinutes: ttl } })
    return id
  })
  if (!res) return c.json({ error: 'this user already has an active session for this issue' }, 409)
  return c.json(view((await sessionRow(res))!), 201)
})

sessions.get('/repos/:owner/:repo/sessions', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const repo = await findRepo(c.req.param('owner')!, c.req.param('repo')!)
  if (!repo || !(await can(user, repo, 'read'))) return c.json({ error: 'not found' }, 404)
  const all = await can(user, repo, 'maintain')
  await sql`UPDATE task_sessions SET status = 'expired', ended_at = expires_at WHERE repo_id = ${repo.id} AND status = 'active' AND expires_at <= now()`
  const status = c.req.query('status') ?? null
  const rows = await sql`SELECT s.id FROM task_sessions s WHERE s.repo_id = ${repo.id} AND (${all} OR s.user_id = ${user.id}) AND (${status}::text IS NULL OR s.status = ${status}) ORDER BY s.created_at DESC LIMIT 200`
  return c.json({ sessions: (await Promise.all(rows.map((r: { id: string }) => sessionRow(r.id)))).map((s) => view(s!)) })
})

/** The caller's own sessions across repositories. */
sessions.get('/sessions', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  await sql`UPDATE task_sessions SET status = 'expired', ended_at = expires_at WHERE user_id = ${user.id} AND status = 'active' AND expires_at <= now()`
  const status = c.req.query('status') ?? null
  const rows = await sql`SELECT s.id, COALESCE(u.login, o.login) AS owner, r.name AS repo FROM task_sessions s JOIN repos r ON r.id = s.repo_id
    LEFT JOIN users u ON r.owner_kind='user' AND u.id=r.owner_id LEFT JOIN orgs o ON r.owner_kind='org' AND o.id=r.owner_id
    WHERE s.user_id = ${user.id} AND (${status}::text IS NULL OR s.status = ${status}) ORDER BY s.created_at DESC LIMIT 200`
  return c.json({ sessions: (await Promise.all(rows.map(async (r: Record<string, any>) => ({ ...view((await sessionRow(r.id))!), owner: r.owner, repo: r.repo })))) })
})

/** Load a session for its developer or a maintainer of its repo. */
async function sessionCtx(c: Context, who: 'user' | 'maintainer' | 'either') {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const s = await sessionRow(c.req.param('id')!)
  if (!s) return c.json({ error: 'not found' }, 404)
  const repo = (await repoById(Number(s.repo_id)))!
  const isUser = Number(s.user_id) === user.id
  const isMaint = await can(user, repo, 'maintain')
  if (!(who === 'user' ? isUser : who === 'maintainer' ? isMaint : isUser || isMaint)) return c.json({ error: 'not found' }, 404)
  return { user, s, repo, isUser, isMaint }
}
const isResp = (x: unknown): x is Response => x instanceof Response

sessions.get('/sessions/:id', async (c) => {
  const x = await sessionCtx(c, 'either'); if (isResp(x)) return x
  return c.json(view(x.s))
})

async function endSession(c: Context, reason: 'ended' | 'revoked') {
  const x = await sessionCtx(c, reason === 'revoked' ? 'maintainer' : 'either'); if (isResp(x)) return x
  if (x.s.status !== 'active') return c.json({ error: `session is already ${x.s.status}` }, 409)
  await sql.begin(async (tx) => {
    await tx`UPDATE task_sessions SET status = 'ended', ended_at = now(), ended_by = ${x.user.id}, end_reason = ${reason} WHERE id = ${x.s.id}::uuid`
    await tx`INSERT INTO session_events (session_id, actor_id, kind, detail) VALUES (${x.s.id}::uuid, ${x.user.id}, ${reason === 'revoked' ? 'revoke' : 'end'}, '{}'::jsonb)`
    await recordRbac(tx, { orgId: orgIdOf(x.repo), actor: x.user, action: reason === 'revoked' ? 'session.revoke' : 'session.end', payload: { session: x.s.id, repo: Number(x.repo.id), issue: Number(x.s.issue_number), user: Number(x.s.user_id) } })
  })
  return c.json(view((await sessionRow(x.s.id))!))
}
sessions.post('/sessions/:id/end', (c) => endSession(c, 'ended'))
sessions.post('/sessions/:id/revoke', (c) => endSession(c, 'revoked'))

sessions.get('/sessions/:id/events', async (c) => {
  const x = await sessionCtx(c, 'maintainer'); if (isResp(x)) return x
  const rows = await sql`SELECT e.id, e.kind, e.detail, e.created_at, u.login AS actor FROM session_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.session_id = ${x.s.id}::uuid ORDER BY e.id DESC LIMIT 500`
  return c.json({ events: rows.map((e: Record<string, any>) => ({ id: Number(e.id), kind: e.kind, actor: e.actor, detail: e.detail, createdAt: e.created_at })) })
})

/** The task itself (title/body) for the assigned developer. */
sessions.get('/sessions/:id/issue', async (c) => {
  const x = await sessionCtx(c, 'either'); if (isResp(x)) return x
  if (x.isUser && x.s.status !== 'active') return c.json({ error: 'session is not active' }, 403)
  const [i] = await sql`SELECT number, title, body, state FROM issues WHERE id = ${x.s.issue_id}`
  return c.json({ number: Number(i.number), title: i.title, body: i.body, state: i.state })
})

// ---------- scoped export ----------
sessions.get('/sessions/:id/export', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const scope = await loadSessionForUser(c.req.param('id')!, user.id)
  if (!scope) return c.json({ error: 'invalid, expired or revoked session' }, 403)
  const dir = repoPath(scope.repoIdHex)
  const tmp = mkdtempSync(join(tmpdir(), 'dheet-export-'))
  const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } }
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    const ls = await gitx(dir, ['ls-tree', '-r', '-z', scope.ref])
    if (ls.code !== 0) { cleanup(); return c.json({ error: 'ref not found' }, 404) }
    const keep = ls.out.split('\0').filter((rec) => { const p = rec.slice(rec.indexOf('\t') + 1); return rec && (unrestricted(scope) || pathInScope(scope.allowedPaths, p)) })
    if (!keep.length) { cleanup(); return c.json({ error: 'no files in scope at this ref' }, 404) }
    const ui = await gitx(dir, ['update-index', '--add', '-z', '--index-info'], { env, input: keep.join('\0') + '\0' })
    if (ui.code !== 0) throw new Error(ui.err)
    const wt = await gitx(dir, ['write-tree'], { env }); if (wt.code !== 0) throw new Error(wt.err)
    const proc = Bun.spawn(['git', '-C', dir, 'archive', '--format=tar', wt.out.trim()], { stdout: 'pipe', stderr: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1' } })
    void proc.exited.then(cleanup)
    await logSessionEvent(scope.id, user.id, 'export', { files: keep.length })
    return new Response(proc.stdout, { headers: { 'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="session-${scope.issueNumber}-${scope.id.slice(0, 8)}.tar"`, 'x-dheet-files': String(keep.length) } })
  } catch (e) { cleanup(); return c.json({ error: `export failed: ${(e as Error).message}` }, 500) }
})

// ---------- scoped contribution ----------
function patchPaths(numstatZ: string): string[] {
  const t = numstatZ.split('\0'), out: string[] = []
  for (let i = 0; i < t.length;) {
    const m = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(t[i] ?? ''); if (!m) { i++; continue }
    if (m[3] === '') { out.push(t[i + 1] ?? '', t[i + 2] ?? ''); i += 3 } else { out.push(m[3]!); i++ }
  }
  return out
}

sessions.post('/sessions/:id/proposals', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const scope = await loadSessionForUser(c.req.param('id')!, user.id)
  if (!scope) return c.json({ error: 'invalid, expired or revoked session' }, 403)
  const repo = (await repoById(scope.repoId))!
  let b: { patch?: string; title?: string; body?: string }
  try { b = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  if (typeof b.patch !== 'string' || !b.patch.trim() || b.patch.length > 1_000_000) return c.json({ error: 'patch (unified diff, <= 1 MB) is required' }, 400)
  const patch = b.patch.endsWith('\n') ? b.patch : b.patch + '\n'
  const dir = repoPath(scope.repoIdHex)
  const reject = async (why: string, paths: string[] = []) => {
    await logSessionEvent(scope.id, user.id, 'proposal_rejected', { why, paths: paths.slice(0, 20) })
    return c.json({ error: why, paths: paths.slice(0, 20) }, 422)
  }
  const ns = await gitx(dir, ['apply', '--numstat', '-z', '-'], { input: patch })
  if (ns.code !== 0) return reject(`patch does not parse: ${ns.err.trim().slice(0, 300)}`)
  const touched = patchPaths(ns.out).filter(Boolean)
  if (!touched.length) return reject('patch changes no files')
  const bad = touched.filter((p) => !unrestricted(scope) && !pathInScope(scope.allowedPaths, p))
  if (bad.length) return reject('patch touches files outside the session scope', bad)

  const branch = `session/${scope.issueNumber}-${user.login}`
  const ref = `refs/heads/${branch}`
  if (!safeRef(branch)) return c.json({ error: 'bad branch name' }, 400)
  const tip = await gitx(dir, ['rev-parse', '--verify', '--quiet', `${scope.ref}^{commit}`])
  if (tip.code !== 0) return c.json({ error: 'session ref no longer exists' }, 422)
  const baseTip = tip.out.trim()
  const ex = await gitx(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const parent = ex.code === 0 ? ex.out.trim() : baseTip
  const tmp = mkdtempSync(join(tmpdir(), 'dheet-proposal-'))
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    if ((await gitx(dir, ['read-tree', parent], { env })).code !== 0) return c.json({ error: 'could not read tree' }, 500)
    const ap = await gitx(dir, ['apply', '--cached', '--whitespace=nowarn', '-'], { env, input: patch })
    if (ap.code !== 0) return reject(`patch does not apply: ${ap.err.trim().slice(0, 300)}`)
    // belt and braces: the whole branch diff against the session base must stay in scope
    const all = await gitx(dir, ['diff', '--cached', '--name-only', '-z', '--no-renames', baseTip], { env })
    const outside = all.out.split('\0').filter((p) => p && !unrestricted(scope) && !pathInScope(scope.allowedPaths, p))
    if (outside.length) return reject('resulting change touches files outside the session scope', outside)
    const tree = (await gitx(dir, ['write-tree'], { env })).out.trim()
    const parentTree = (await gitx(dir, ['rev-parse', `${parent}^{tree}`])).out.trim()
    if (tree === parentTree) return reject('patch produces no change')
    const title = (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : `Proposal for issue #${scope.issueNumber}`).slice(0, 300)
    const id = { GIT_AUTHOR_NAME: user.login, GIT_AUTHOR_EMAIL: `${user.login}@users.noreply.dithub`, GIT_COMMITTER_NAME: user.login, GIT_COMMITTER_EMAIL: `${user.login}@users.noreply.dithub` }
    const cm = await gitx(dir, ['commit-tree', tree, '-p', parent, '-F', '-'], { env: id, input: `${title}\n\nSession-Issue: #${scope.issueNumber}\n` })
    if (cm.code !== 0) throw new Error(cm.err)
    const commit = cm.out.trim()
    const upd = await gitx(dir, ['update-ref', ref, commit, ex.code === 0 ? parent : '0'.repeat(commit.length)])
    if (upd.code !== 0) return c.json({ error: 'branch moved concurrently; retry' }, 409)
    await recordRefUpdates(repo, user, scope.repoIdHex, [{ oldOid: ex.code === 0 ? parent : '0'.repeat(commit.length), newOid: commit, ref }])
    let prNumber: number
    const [open] = await sql`SELECT i.number, p.issue_id FROM pull_requests p JOIN issues i ON i.id = p.issue_id WHERE p.repo_id = ${repo.id} AND p.head_ref = ${branch} AND p.state = 'open'`
    if (open) prNumber = Number(open.number)
    else {
      const pr = await createPullRequest({ repo, user, title, body: (b.body ?? '').slice(0, 20_000) + `\n\nProposal from a task-scoped session for issue #${scope.issueNumber}.`, head: branch, base: scope.ref, sessionId: scope.id })
      if (!pr.ok) return c.json({ error: pr.error }, pr.status)
      prNumber = pr.number
    }
    await logSessionEvent(scope.id, user.id, 'proposal', { branch, commit, pr: prNumber, files: touched.length })
    return c.json({ branch, commit: `0x${commit}`, pullRequest: prNumber, files: touched.length }, 201)
  } finally { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } }
})

void ZERO_OID
