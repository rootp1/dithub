import { Hono } from 'hono'
import { sql, hex, json, now, bool } from './db.ts'
import { config } from './config.ts'
import { can, type RepoRow } from './perm.ts'
import { git, listCommits, repoPath, ZERO_OID, safeRef } from './gitrepo.ts'
import type { AuthUser } from './auth.ts'

export const internal = new Hono()

internal.use('*', async (c, next) => {
  if (c.req.header('authorization') !== `Bearer ${config.internalToken}`) return c.text('forbidden', 403)
  await next()
})

export interface Update { oldOid: string; newOid: string; ref: string; ff?: boolean }

async function loadContext(repoIdHex: string, userId: string | undefined) {
  const [repo] = await sql`SELECT r.*, COALESCE(u.login, o.login) AS owner_login FROM repos r
    LEFT JOIN users u ON r.owner_kind = 'user' AND u.id = r.owner_id
    LEFT JOIN orgs o ON r.owner_kind = 'org' AND o.id = r.owner_id
    WHERE r.dheet_repo_id = ${hex(repoIdHex)}`
  if (!repo) return null
  let user: AuthUser | null = null
  if (userId) {
    const [u] = await sql`SELECT u.id, u.login, u.is_site_admin, (SELECT address FROM wallets WHERE user_id = u.id AND is_primary = 1 LIMIT 1) AS address
      FROM users u WHERE u.id = ${Number(userId)}`
    if (u) user = { id: Number(u.id), login: u.login, isAdmin: bool(u.is_site_admin), wallet: u.address ? `0x${Buffer.from(u.address).toString('hex')}` : null }
  }
  return { repo: repo as RepoRow, user }
}

const globToRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

internal.post('/pre-receive', async (c) => {
  const body = await c.req.json<{ repoId: string; userId?: string; updates: Update[] }>()
  const ctx = await loadContext(body.repoId, body.userId)
  if (!ctx || !ctx.user) return c.text('unauthenticated push', 401)
  const { repo, user } = ctx
  if (!(await can(user, repo, 'write'))) return c.text(`${user.login} has no write access to ${repo.owner_login}/${repo.name}`, 403)

  const rules = await sql`SELECT * FROM branch_protections WHERE repo_id = ${repo.id}`
  for (const u of body.updates) {
    if (!safeRef(u.ref)) return c.text(`invalid ref name ${u.ref}`, 400)
    const branch = u.ref.replace(/^refs\/heads\//, '')
    const rule = u.ref.startsWith('refs/heads/') ? rules.find((r: { pattern: string }) => globToRegex(r.pattern).test(branch)) : undefined
    if (!rule) continue
    const isAdmin = await can(user, repo, 'admin')
    if (ZERO_OID.test(u.newOid) && !bool(rule.allow_deletions)) return c.text(`deleting protected branch ${branch} is not allowed`, 403)
    if (!ZERO_OID.test(u.oldOid) && !ZERO_OID.test(u.newOid)) {
      if (u.ff === false && !bool(rule.allow_force_push)) return c.text(`force-push to protected branch ${branch} is not allowed`, 403)
    }
    if (bool(rule.require_pr) && !isAdmin) return c.text(`branch ${branch} requires a pull request`, 403)
  }
  return c.text('ok')
})

internal.post('/post-receive', async (c) => {
  const body = await c.req.json<{ repoId: string; userId?: string; updates: Update[] }>()
  const ctx = await loadContext(body.repoId, body.userId)
  if (!ctx) return c.text('unknown repo', 404)
  await recordRefUpdates(ctx.repo, ctx.user, body.repoId, body.updates)
  return c.text('ok')
})

/** Record ref updates exactly like a push: pushes row, git_refs, commits, commit_anchors, activity and the outbox 'push' entry the worker anchors.
 *  Used by post-receive and by server-side merges / session proposals (which update refs without receive-pack). */
export async function recordRefUpdates(repo: RepoRow, user: AuthUser | null, repoIdHex: string, updates: Update[]): Promise<void> {
  const dir = repoPath(repoIdHex)
  let firstBranch: string | null = null

  for (const u of updates) {
    const deleted = ZERO_OID.test(u.newOid)
    const created = ZERO_OID.test(u.oldOid)
    let forced = false
    if (!created && !deleted) forced = (await git(dir, ['merge-base', '--is-ancestor', u.oldOid, u.newOid])).code !== 0
    const range = deleted ? [] : created ? [u.newOid, '--not', ...(await otherRefs(dir, u.ref))] : [`${u.oldOid}..${u.newOid}`]
    const commits = deleted ? [] : await listCommits(dir, range, 200)

    const at = now()
    await sql.begin(async (tx) => {
      const [push] = await tx`INSERT INTO pushes (repo_id, pusher_id, pusher_wallet, ref_name, old_oid, new_oid, forced)
        VALUES (${repo.id}, ${user?.id ?? null}, ${user?.wallet ? hex(user.wallet) : null}, ${u.ref},
                ${created ? null : hex(u.oldOid)}, ${deleted ? null : hex(u.newOid)}, ${forced ? 1 : 0}) RETURNING id`
      if (deleted) await tx`DELETE FROM git_refs WHERE repo_id = ${repo.id} AND name = ${u.ref}`
      else await tx`INSERT INTO git_refs (repo_id, name, oid) VALUES (${repo.id}, ${u.ref}, ${hex(u.newOid)})
        ON CONFLICT (repo_id, name) DO UPDATE SET oid = EXCLUDED.oid, updated_at = ${at}`
      for (const cm of commits) {
        await tx`INSERT INTO commits (repo_id, oid, tree_oid, parent_oids, author_name, author_email, authored_at, committed_at, message, subject)
          VALUES (${repo.id}, ${hex(cm.oid)}, ${hex(cm.tree)}, ${json(cm.parents.map((p) => p.toLowerCase()))}, ${cm.authorName}, ${cm.authorEmail},
                  ${new Date(cm.authoredAt * 1000).toISOString()}, ${new Date(cm.committedAt * 1000).toISOString()}, ${cm.message}, ${cm.subject})
          ON CONFLICT DO NOTHING`
        await tx`INSERT INTO commit_anchors (repo_id, commit_oid, push_id, ref_name)
          VALUES (${repo.id}, ${hex(cm.oid)}, ${push.id}, ${u.ref}) ON CONFLICT DO NOTHING`
      }
      await tx`UPDATE repos SET pushed_at = ${at}, updated_at = ${at} WHERE id = ${repo.id}`
      await tx`INSERT INTO activity (repo_id, actor_id, kind, payload) VALUES (${repo.id}, ${user?.id ?? null}, 'push',
        ${json({ ref: u.ref, commits: commits.length, forced, deleted })})`
      await tx`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload)
        VALUES ('push', ${push.id}, 'push', ${json({ pushId: Number(push.id), repoId: repoIdHex })})`
    })
    if (!deleted && u.ref.startsWith('refs/heads/') && !firstBranch) firstBranch = u.ref.replace('refs/heads/', '')
  }
  if (firstBranch) {
    const heads = await git(dir, ['symbolic-ref', '--short', 'HEAD'])
    if (heads.code === 0) await sql`UPDATE repos SET default_branch = ${heads.out.trim()} WHERE id = ${repo.id}`
  }
}

async function otherRefs(dir: string, ref: string): Promise<string[]> {
  const res = await git(dir, ['for-each-ref', '--format=%(refname)'])
  return res.out.split('\n').filter((r) => r && r !== ref)
}
