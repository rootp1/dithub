import { sql } from './db.ts'
import type { AuthUser } from './auth.ts'

export interface RepoRow {
  id: number; dheet_repo_id: Buffer; owner_kind: 'user' | 'org'; owner_id: number; name: string
  visibility: 'public' | 'private' | 'internal'; default_branch: string; description: string | null
  owner_login: string; pushed_at: Date | null; created_at: Date
}

export async function findRepo(owner: string, name: string): Promise<RepoRow | null> {
  const rows = await sql`SELECT r.*, COALESCE(u.login, o.login) AS owner_login FROM repos r
    LEFT JOIN users u ON r.owner_kind = 'user' AND u.id = r.owner_id
    LEFT JOIN orgs o ON r.owner_kind = 'org' AND o.id = r.owner_id
    WHERE r.deleted_at IS NULL AND r.name = ${name} AND COALESCE(u.login, o.login) = ${owner}`
  return (rows[0] as RepoRow | undefined) ?? null
}

const rank = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 } as const
type Level = keyof typeof rank

async function level(user: AuthUser | null, repo: RepoRow): Promise<number> {
  if (!user) return repo.visibility === 'public' ? rank.read : 0
  if (user.isAdmin) return rank.admin
  if (repo.owner_kind === 'user' && Number(repo.owner_id) === user.id) return rank.admin
  let best = repo.visibility === 'public' ? rank.read : 0
  if (repo.owner_kind === 'org') {
    const [m] = await sql`SELECT role FROM org_members WHERE org_id = ${repo.owner_id} AND user_id = ${user.id}`
    if (m) best = Math.max(best, m.role === 'owner' ? rank.admin : repo.visibility === 'private' ? 0 : rank.read)
    const t = await sql`SELECT max(CASE a.permission WHEN 'admin' THEN 5 WHEN 'maintain' THEN 4 WHEN 'write' THEN 3 WHEN 'triage' THEN 2 ELSE 1 END) AS p
      FROM repo_team_access a JOIN team_members tm ON tm.team_id = a.team_id
      WHERE a.repo_id = ${repo.id} AND tm.user_id = ${user.id}`
    best = Math.max(best, Number(t[0]?.p ?? 0))
  }
  const [c] = await sql`SELECT permission FROM repo_collaborators WHERE repo_id = ${repo.id} AND user_id = ${user.id}`
  if (c) best = Math.max(best, rank[c.permission as Level])
  return best
}

export const can = async (user: AuthUser | null, repo: RepoRow, need: Level) => (await level(user, repo)) >= rank[need]
