// VS Code extension support: the developer's task inbox and the maintainer's repo picker.
import { Hono } from 'hono'
import { sql, toHex, now, parseJson } from './db.ts'
import { authenticate } from './auth.ts'
import { can, type RepoRow } from './perm.ts'

export const tasks = new Hono()

/**
 * Every task session of the caller (active first, then newest). Works without any repository permission: the session is the grant.
 * Only owner/name of the repo and number/title/state of the assigned issue are returned.
 */
tasks.get('/tasks', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  await sql`UPDATE task_sessions SET status = 'expired', ended_at = expires_at WHERE user_id = ${user.id} AND status = 'active' AND expires_at <= ${now()}`
  const rows = await sql`SELECT s.id, s.role, s.allowed_paths, s.ref, s.status, s.end_reason, s.expires_at, s.created_at,
      COALESCE(u.login, o.login) AS owner, r.name AS repo, i.number, i.title, i.state, m.login AS created_by
    FROM task_sessions s JOIN repos r ON r.id = s.repo_id JOIN issues i ON i.id = s.issue_id JOIN users m ON m.id = s.created_by
    LEFT JOIN users u ON r.owner_kind = 'user' AND u.id = r.owner_id LEFT JOIN orgs o ON r.owner_kind = 'org' AND o.id = r.owner_id
    WHERE s.user_id = ${user.id} AND r.deleted_at IS NULL
    ORDER BY (s.status = 'active') DESC, s.created_at DESC LIMIT 500`
  const iso = (d: unknown) => new Date(d as string).toISOString()
  return c.json({ tasks: rows.map((s: Record<string, any>) => ({
    sessionId: s.id,
    repo: { owner: s.owner, name: s.repo },
    issue: { number: Number(s.number), title: s.title, state: s.state },
    role: s.role, allowedPaths: parseJson<string[]>(s.allowed_paths) ?? [], ref: s.ref,
    status: s.status === 'ended' && s.end_reason === 'revoked' ? 'revoked' : s.status,
    expiresAt: iso(s.expires_at), createdAt: iso(s.created_at), createdBy: s.created_by,
  })) })
})

const LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const
type Level = typeof LEVELS[number]

/**
 * Repositories the caller has a role in (owner, org member, team grant, collaborator; site admins: all) at `min` or above.
 * Public repositories the caller has no relationship with are not listed; task sessions never count as access.
 */
tasks.get('/me/repos', async (c) => {
  const user = await authenticate(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const min = (c.req.query('min') ?? 'read') as Level
  if (!LEVELS.includes(min)) return c.json({ error: `min must be one of ${LEVELS.join(', ')}` }, 400)
  const rows = await sql`SELECT r.*, COALESCE(u.login, o.login) AS owner_login FROM repos r
    LEFT JOIN users u ON r.owner_kind = 'user' AND u.id = r.owner_id LEFT JOIN orgs o ON r.owner_kind = 'org' AND o.id = r.owner_id
    WHERE r.deleted_at IS NULL AND (${user.isAdmin ? 1 : 0} = 1
      OR (r.owner_kind = 'user' AND r.owner_id = ${user.id})
      OR (r.owner_kind = 'org' AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = r.owner_id AND m.user_id = ${user.id}))
      OR EXISTS (SELECT 1 FROM repo_collaborators rc WHERE rc.repo_id = r.id AND rc.user_id = ${user.id})
      OR EXISTS (SELECT 1 FROM repo_team_access a JOIN team_members tm ON tm.team_id = a.team_id WHERE a.repo_id = r.id AND tm.user_id = ${user.id}))
    ORDER BY COALESCE(r.pushed_at, r.created_at) DESC LIMIT 500`
  const out = []
  for (const r of rows as RepoRow[]) {
    if (!(await can(user, r, min))) continue
    let permission: Level = min
    for (const l of [...LEVELS].reverse()) { if (l === min) break; if (await can(user, r, l)) { permission = l; break } }
    out.push({ owner: r.owner_login, name: r.name, visibility: r.visibility, permission, defaultBranch: r.default_branch, repoId: toHex(r.dheet_repo_id) })
  }
  return c.json({ repos: out })
})
