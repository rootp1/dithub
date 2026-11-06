import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { sql, hex, toHex } from './db.ts'
import { authenticate, type AuthUser } from './auth.ts'
import { can, findRepo, type RepoRow } from './perm.ts'

export const rbac = new Hono()

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const PERMS = ['read', 'triage', 'write', 'maintain', 'admin'] as const
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest()

type Tx = import('bun').TransactionSQL

/** Append an RBAC change. Always lands in audit_log. Public orgs also get a hash-chained event that the worker mirrors to Arkiv. */
export async function recordRbac(tx: Tx, args: { orgId: number | null; actor: AuthUser; action: string; payload: Record<string, unknown> }) {
  await tx`INSERT INTO audit_log (actor_id, actor_wallet, action, target_type, target_id, metadata)
    VALUES (${args.actor.id}, ${args.actor.wallet ? hex(args.actor.wallet) : null}, ${args.action}, 'org', ${args.orgId}, ${JSON.stringify(args.payload)}::text::jsonb)`
  if (!args.orgId) return
  const [org] = await tx`UPDATE orgs SET rbac_seq = rbac_seq + 1 WHERE id = ${args.orgId} RETURNING rbac_seq, rbac_head, visibility`
  const isPublic = org.visibility === 'public'
  const event = { seq: Number(org.rbac_seq), action: args.action, actor: args.actor.login, payload: args.payload, at: new Date().toISOString() }
  const prev: Buffer | null = org.rbac_head ? Buffer.from(org.rbac_head) : null
  const hash = sha(Buffer.concat([prev ?? Buffer.alloc(32), Buffer.from(canonical(event))]))
  const [row] = await tx`INSERT INTO rbac_events (org_id, seq, actor_id, actor_login, action, payload, prev_hash, hash, public)
    VALUES (${args.orgId}, ${event.seq}, ${args.actor.id}, ${args.actor.login}, ${args.action},
            ${canonical({ ...args.payload, at: event.at })}::text::jsonb, ${prev}, ${hash}, ${isPublic}) RETURNING id`
  await tx`UPDATE orgs SET rbac_head = ${hash} WHERE id = ${args.orgId}`
  if (isPublic) await tx`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload)
    VALUES ('rbac', ${row.id}, 'rbac', ${JSON.stringify({ eventId: Number(row.id) })}::text::jsonb)`
}

async function requireUser(c: import('hono').Context) {
  const user = await authenticate(c)
  return user
}
async function orgByLogin(login: string) {
  const [o] = await sql`SELECT * FROM orgs WHERE login = ${login}`
  return o as { id: number; login: string; visibility: 'public' | 'private'; rbac_head: Buffer | null; rbac_seq: number } | undefined
}
async function orgRole(org: { id: number }, user: AuthUser | null): Promise<'owner' | 'member' | null> {
  if (!user) return null
  const [m] = await sql`SELECT role FROM org_members WHERE org_id = ${org.id} AND user_id = ${user.id}`
  return user.isAdmin ? 'owner' : ((m?.role as 'owner' | 'member' | undefined) ?? null)
}
async function userByLogin(login: string) {
  const [u] = await sql`SELECT id, login FROM users WHERE login = ${login} AND suspended_at IS NULL`
  return u as { id: number; login: string } | undefined
}

// ----- organisations -----
rbac.post('/orgs', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const b = await c.req.json<{ login: string; visibility?: 'public' | 'private'; refRegistry?: string }>()
  if (!LOGIN.test(b.login ?? '')) return c.json({ error: 'invalid org login' }, 400)
  if ((await sql`SELECT 1 FROM users WHERE login = ${b.login}`).length) return c.json({ error: 'name is taken' }, 409)
  if ((await sql`SELECT 1 FROM orgs WHERE login = ${b.login}`).length) return c.json({ error: 'name is taken' }, 409)
  const visibility = b.visibility === 'private' ? 'private' : 'public'
  const org = await sql.begin(async (tx) => {
    const [o] = await tx`INSERT INTO orgs (login, visibility, ref_registry, chain_id) VALUES (${b.login}, ${visibility}, ${b.refRegistry ? hex(b.refRegistry) : null}, 11155111) RETURNING id, login, visibility`
    await tx`INSERT INTO org_members (org_id, user_id, role) VALUES (${o.id}, ${user.id}, 'owner')`
    await recordRbac(tx, { orgId: Number(o.id), actor: user, action: 'org.create', payload: { org: b.login, visibility } })
    return o
  })
  return c.json({ org }, 201)
})

// Every organisation the signed-in user belongs to, for the home page column.
rbac.get('/me/orgs', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const rows = await sql`SELECT o.login, o.visibility, m.role,
      (SELECT count(*)::int FROM org_members x WHERE x.org_id = o.id) AS members,
      (SELECT count(*)::int FROM repos r WHERE r.owner_kind = 'org' AND r.owner_id = o.id AND r.deleted_at IS NULL) AS repos
    FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ${user.id} ORDER BY lower(o.login)`
  return c.json({ orgs: rows.map((r: { login: string; visibility: string; role: string; members: number; repos: number }) => ({ login: r.login, visibility: r.visibility, role: r.role, members: r.members, repos: r.repos })) })
})

rbac.get('/orgs/:org', async (c) => {
  const user = await requireUser(c)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  const role = await orgRole(org, user)
  if (org.visibility === 'private' && !role) return c.json({ error: 'not found' }, 404)
  const members = await sql`SELECT u.login, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ${org.id} ORDER BY u.login`
  const teams = await sql`SELECT t.slug, t.name, (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS members FROM teams t WHERE t.org_id = ${org.id} ORDER BY t.slug`
  return c.json({ login: org.login, visibility: org.visibility, yourRole: role, members, teams, rbacHead: toHex(org.rbac_head), rbacSeq: Number(org.rbac_seq) })
})

rbac.put('/orgs/:org/members/:login', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  if ((await orgRole(org, user)) !== 'owner') return c.json({ error: 'only org owners can manage members' }, 403)
  const { role } = await c.req.json<{ role?: 'owner' | 'member' }>()
  if (role !== 'owner' && role !== 'member') return c.json({ error: "role must be 'owner' or 'member'" }, 400)
  const target = await userByLogin(c.req.param('login')); if (!target) return c.json({ error: 'no such user' }, 404)
  const [existing] = await sql`SELECT role FROM org_members WHERE org_id = ${org.id} AND user_id = ${target.id}`
  if (existing?.role === 'owner' && role === 'member') {
    const [n] = await sql`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${org.id} AND role = 'owner'`
    if (n.n <= 1) return c.json({ error: 'an organisation needs at least one owner' }, 409)
  }
  await sql.begin(async (tx) => {
    await tx`INSERT INTO org_members (org_id, user_id, role) VALUES (${org.id}, ${target.id}, ${role})
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`
    await recordRbac(tx, { orgId: org.id, actor: user, action: existing ? 'member.role' : 'member.add', payload: { user: target.login, role, was: existing?.role ?? null } })
  })
  return c.json({ ok: true })
})

rbac.delete('/orgs/:org/members/:login', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  const target = await userByLogin(c.req.param('login')); if (!target) return c.json({ error: 'no such user' }, 404)
  const self = target.id === user.id
  if ((await orgRole(org, user)) !== 'owner' && !self) return c.json({ error: 'only org owners can remove members' }, 403)
  const [m] = await sql`SELECT role FROM org_members WHERE org_id = ${org.id} AND user_id = ${target.id}`
  if (!m) return c.json({ error: 'not a member' }, 404)
  if (m.role === 'owner') {
    const [n] = await sql`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${org.id} AND role = 'owner'`
    if (n.n <= 1) return c.json({ error: 'cannot remove the last owner' }, 409)
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM team_members WHERE user_id = ${target.id} AND team_id IN (SELECT id FROM teams WHERE org_id = ${org.id})`
    await tx`DELETE FROM org_members WHERE org_id = ${org.id} AND user_id = ${target.id}`
    await recordRbac(tx, { orgId: org.id, actor: user, action: 'member.remove', payload: { user: target.login } })
  })
  return c.json({ ok: true })
})

// ----- teams -----
rbac.post('/orgs/:org/teams', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  if ((await orgRole(org, user)) !== 'owner') return c.json({ error: 'only org owners can create teams' }, 403)
  const { slug, name } = await c.req.json<{ slug: string; name?: string }>()
  if (!LOGIN.test(slug ?? '')) return c.json({ error: 'invalid team slug' }, 400)
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO teams (org_id, slug, name) VALUES (${org.id}, ${slug}, ${name ?? slug})`
      await recordRbac(tx, { orgId: org.id, actor: user, action: 'team.create', payload: { team: slug } })
    })
  } catch { return c.json({ error: 'team already exists' }, 409) }
  return c.json({ ok: true }, 201)
})

rbac.put('/orgs/:org/teams/:team/members/:login', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  if ((await orgRole(org, user)) !== 'owner') return c.json({ error: 'only org owners can manage teams' }, 403)
  const [team] = await sql`SELECT id FROM teams WHERE org_id = ${org.id} AND slug = ${c.req.param('team')}`
  const target = await userByLogin(c.req.param('login'))
  if (!team || !target) return c.json({ error: 'team or user not found' }, 404)
  const [m] = await sql`SELECT 1 FROM org_members WHERE org_id = ${org.id} AND user_id = ${target.id}`
  if (!m) return c.json({ error: 'user must be an org member first' }, 409)
  await sql.begin(async (tx) => {
    await tx`INSERT INTO team_members (team_id, user_id) VALUES (${team.id}, ${target.id}) ON CONFLICT DO NOTHING`
    await recordRbac(tx, { orgId: org.id, actor: user, action: 'team.member.add', payload: { team: c.req.param('team'), user: target.login } })
  })
  return c.json({ ok: true })
})

rbac.delete('/orgs/:org/teams/:team/members/:login', async (c) => {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  if ((await orgRole(org, user)) !== 'owner') return c.json({ error: 'only org owners can manage teams' }, 403)
  const [team] = await sql`SELECT id FROM teams WHERE org_id = ${org.id} AND slug = ${c.req.param('team')}`
  const target = await userByLogin(c.req.param('login'))
  if (!team || !target) return c.json({ error: 'team or user not found' }, 404)
  await sql.begin(async (tx) => {
    await tx`DELETE FROM team_members WHERE team_id = ${team.id} AND user_id = ${target.id}`
    await recordRbac(tx, { orgId: org.id, actor: user, action: 'team.member.remove', payload: { team: c.req.param('team'), user: target.login } })
  })
  return c.json({ ok: true })
})

// ----- repo access: collaborators, team grants, branch protection -----
async function adminOf(c: import('hono').Context): Promise<{ user: AuthUser; repo: RepoRow } | Response> {
  const user = await requireUser(c); if (!user) return c.json({ error: 'sign in first' }, 401)
  const repo = await findRepo(c.req.param('owner')!, c.req.param('repo')!)
  if (!repo || !(await can(user, repo, 'read'))) return c.json({ error: 'not found' }, 404)
  if (!(await can(user, repo, 'admin'))) return c.json({ error: 'repository admin access required' }, 403)
  return { user, repo }
}
const orgIdOf = (repo: RepoRow) => (repo.owner_kind === 'org' ? Number(repo.owner_id) : null)

rbac.get('/repos/:owner/:repo/collaborators', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  const rows = await sql`SELECT u.login, rc.permission FROM repo_collaborators rc JOIN users u ON u.id = rc.user_id WHERE rc.repo_id = ${r.repo.id} ORDER BY u.login`
  const teams = await sql`SELECT t.slug, a.permission FROM repo_team_access a JOIN teams t ON t.id = a.team_id WHERE a.repo_id = ${r.repo.id}`
  return c.json({ collaborators: rows, teams })
})

rbac.put('/repos/:owner/:repo/collaborators/:login', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  const { permission } = await c.req.json<{ permission?: string }>()
  if (!PERMS.includes(permission as never)) return c.json({ error: `permission must be one of ${PERMS.join(', ')}` }, 400)
  const target = await userByLogin(c.req.param('login')); if (!target) return c.json({ error: 'no such user' }, 404)
  await sql.begin(async (tx) => {
    await tx`INSERT INTO repo_collaborators (repo_id, user_id, permission) VALUES (${r.repo.id}, ${target.id}, ${permission})
      ON CONFLICT (repo_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`
    await recordRbac(tx, { orgId: orgIdOf(r.repo), actor: r.user, action: 'collaborator.set', payload: { repo: `${r.repo.owner_login}/${r.repo.name}`, user: target.login, permission } })
  })
  return c.json({ ok: true })
})

rbac.delete('/repos/:owner/:repo/collaborators/:login', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  const target = await userByLogin(c.req.param('login')); if (!target) return c.json({ error: 'no such user' }, 404)
  await sql.begin(async (tx) => {
    await tx`DELETE FROM repo_collaborators WHERE repo_id = ${r.repo.id} AND user_id = ${target.id}`
    await recordRbac(tx, { orgId: orgIdOf(r.repo), actor: r.user, action: 'collaborator.remove', payload: { repo: `${r.repo.owner_login}/${r.repo.name}`, user: target.login } })
  })
  return c.json({ ok: true })
})

rbac.put('/repos/:owner/:repo/teams/:team', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  if (r.repo.owner_kind !== 'org') return c.json({ error: 'team access only applies to organisation repos' }, 400)
  const { permission } = await c.req.json<{ permission?: string }>()
  if (!PERMS.includes(permission as never)) return c.json({ error: `permission must be one of ${PERMS.join(', ')}` }, 400)
  const [team] = await sql`SELECT id FROM teams WHERE org_id = ${r.repo.owner_id} AND slug = ${c.req.param('team')}`
  if (!team) return c.json({ error: 'team not found' }, 404)
  await sql.begin(async (tx) => {
    await tx`INSERT INTO repo_team_access (repo_id, team_id, permission) VALUES (${r.repo.id}, ${team.id}, ${permission})
      ON CONFLICT (repo_id, team_id) DO UPDATE SET permission = EXCLUDED.permission`
    await recordRbac(tx, { orgId: orgIdOf(r.repo), actor: r.user, action: 'team.access.set', payload: { repo: `${r.repo.owner_login}/${r.repo.name}`, team: c.req.param('team'), permission } })
  })
  return c.json({ ok: true })
})

rbac.get('/repos/:owner/:repo/protections', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  return c.json({ protections: await sql`SELECT pattern, require_pr, required_approvals, allow_force_push, allow_deletions FROM branch_protections WHERE repo_id = ${r.repo.id} ORDER BY pattern` })
})

rbac.put('/repos/:owner/:repo/protections', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  const b = await c.req.json<{ pattern: string; requirePr?: boolean; requiredApprovals?: number; allowForcePush?: boolean; allowDeletions?: boolean }>()
  if (!/^[A-Za-z0-9._\-/*]{1,100}$/.test(b.pattern ?? '')) return c.json({ error: 'invalid branch pattern' }, 400)
  await sql.begin(async (tx) => {
    await tx`INSERT INTO branch_protections (repo_id, pattern, require_pr, required_approvals, allow_force_push, allow_deletions)
      VALUES (${r.repo.id}, ${b.pattern}, ${b.requirePr ?? true}, ${b.requiredApprovals ?? 1}, ${b.allowForcePush ?? false}, ${b.allowDeletions ?? false})
      ON CONFLICT (repo_id, pattern) DO UPDATE SET require_pr = EXCLUDED.require_pr, required_approvals = EXCLUDED.required_approvals,
        allow_force_push = EXCLUDED.allow_force_push, allow_deletions = EXCLUDED.allow_deletions`
    await recordRbac(tx, { orgId: orgIdOf(r.repo), actor: r.user, action: 'protection.set', payload: { repo: `${r.repo.owner_login}/${r.repo.name}`, pattern: b.pattern, requirePr: b.requirePr ?? true, allowForcePush: b.allowForcePush ?? false } })
  })
  return c.json({ ok: true })
})

rbac.delete('/repos/:owner/:repo/protections', async (c) => {
  const r = await adminOf(c); if (r instanceof Response) return r
  const pattern = c.req.query('pattern') ?? ''
  await sql.begin(async (tx) => {
    await tx`DELETE FROM branch_protections WHERE repo_id = ${r.repo.id} AND pattern = ${pattern}`
    await recordRbac(tx, { orgId: orgIdOf(r.repo), actor: r.user, action: 'protection.remove', payload: { repo: `${r.repo.owner_login}/${r.repo.name}`, pattern } })
  })
  return c.json({ ok: true })
})

// ----- the verifiable log -----
rbac.get('/orgs/:org/rbac-log', async (c) => {
  const user = await requireUser(c)
  const org = await orgByLogin(c.req.param('org')); if (!org) return c.json({ error: 'not found' }, 404)
  if (org.visibility === 'private' && !(await orgRole(org, user))) return c.json({ error: 'not found' }, 404)
  const rows = await sql`SELECT seq, actor_login, action, payload, prev_hash, hash, public, arkiv_entity, arkiv_tx, created_at
    FROM rbac_events WHERE org_id = ${org.id} ORDER BY seq ASC`
  return c.json({
    visibility: org.visibility,
    verifiable: org.visibility === 'public',
    head: toHex(org.rbac_head),
    events: rows.map((r: Record<string, unknown>) => ({ seq: Number(r.seq), actor: r.actor_login, action: r.action, payload: r.payload, prevHash: toHex(r.prev_hash as Buffer),
      hash: toHex(r.hash as Buffer), arkivEntity: toHex(r.arkiv_entity as Buffer), arkivTx: toHex(r.arkiv_tx as Buffer), createdAt: r.created_at })),
  })
})
