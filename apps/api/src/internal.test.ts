// Push recording, pre-receive protection checks and the VS Code task/repo lists on SQLite.
import { call, createRepo, createUser, run, setupDb } from './sqlite-testenv.ts'
import { beforeAll, describe, expect, test } from 'bun:test'

const { sql, parseJson } = await setupDb()
process.env.INTERNAL_TOKEN ||= 'x'.repeat(32)
const { config } = await import('./config.ts')
config.internalToken ||= process.env.INTERNAL_TOKEN
const { internal, recordRefUpdates } = await import('./internal.ts')
const { findRepo } = await import('./perm.ts')
const { tasks } = await import('./tasks.ts')
const { repoPath } = await import('./gitrepo.ts')

let owner: Awaited<ReturnType<typeof createUser>>, repo: Awaited<ReturnType<typeof createRepo>>
beforeAll(async () => {
  owner = await createUser('inown')
  repo = await createRepo(owner.id)
})
const auth = () => ({ authorization: `Bearer ${config.internalToken}` })

describe('internal hooks on SQLite', () => {
  test('recordRefUpdates writes push, refs, commits, anchors, activity and outbox', async () => {
    const dir = repoPath(repo.idHex)
    const main = run(dir, ['rev-parse', 'main']), feature = run(dir, ['rev-parse', 'feature'])
    const r = (await findRepo(owner.login, repo.name))!
    const user = { id: owner.id, login: owner.login, wallet: null, isAdmin: false }
    await recordRefUpdates(r, user, repo.idHex, [{ oldOid: '0'.repeat(40), newOid: main, ref: 'refs/heads/main' }])
    await recordRefUpdates(r, user, repo.idHex, [{ oldOid: main, newOid: feature, ref: 'refs/heads/main' }])
    const [ref] = await sql`SELECT lower(hex(oid)) AS oid, updated_at FROM git_refs WHERE repo_id = ${repo.id} AND name = 'refs/heads/main'`
    expect(ref.oid).toBe(feature)
    const commits = await sql`SELECT lower(hex(oid)) AS oid, parent_oids, committed_at FROM commits WHERE repo_id = ${repo.id} ORDER BY committed_at`
    expect(commits.length).toBe(1)                              // `main` was already reachable from `feature` in the bare repo
    const child = commits.find((c: { oid: string }) => c.oid === feature)
    expect(parseJson<string[]>(child.parent_oids)).toEqual([main])
    expect(child.committed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    const pushes = await sql`SELECT forced FROM pushes WHERE repo_id = ${repo.id} ORDER BY id`
    expect(pushes.map((p: { forced: number }) => Number(p.forced))).toEqual([0, 0])
    const jobs = await sql`SELECT payload FROM outbox WHERE kind = 'push' AND aggregate_type = 'push' ORDER BY id DESC LIMIT 2`
    expect(parseJson<{ repoId: string }>(jobs[0].payload).repoId).toBe(repo.idHex)
    expect((await sql`SELECT count(*) AS n FROM commit_anchors WHERE repo_id = ${repo.id}`)[0].n).toBe(1)
    const [act] = await sql`SELECT payload FROM activity WHERE repo_id = ${repo.id} ORDER BY id DESC LIMIT 1`
    expect(parseJson<{ commits: number; forced: boolean }>(act.payload)).toMatchObject({ commits: 1, forced: false })
    const [rp] = await sql`SELECT pushed_at FROM repos WHERE id = ${repo.id}`
    expect(rp.pushed_at).toBeTruthy()
  })

  test('pre-receive enforces branch protection booleans', async () => {
    const other = await createUser('inoth')
    await sql`INSERT INTO repo_collaborators (repo_id, user_id, permission) VALUES (${repo.id}, ${other.id}, 'write')`
    await sql`INSERT INTO branch_protections (repo_id, pattern, require_pr, allow_force_push, allow_deletions) VALUES (${repo.id}, 'main', 0, 0, 0)`
    const body = (u: object) => ({ repoId: repo.idHex, userId: String(other.id), updates: [u] })
    const ok = await call(internal, 'POST', '/pre-receive', { headers: auth(), body: body({ oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40), ref: 'refs/heads/main', ff: true }) })
    expect(ok.data).toBe('ok')
    const force = await call(internal, 'POST', '/pre-receive', { headers: auth(), body: body({ oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40), ref: 'refs/heads/main', ff: false }) })
    expect(force.status).toBe(403)
    const del = await call(internal, 'POST', '/pre-receive', { headers: auth(), body: body({ oldOid: 'a'.repeat(40), newOid: '0'.repeat(40), ref: 'refs/heads/main' }) })
    expect(del.status).toBe(403)
    expect((await call(internal, 'POST', '/pre-receive', { body: body({}) })).status).toBe(403)
  })
})

describe('tasks on SQLite', () => {
  test('/me/repos lists owned repos with permission; /tasks expires old sessions', async () => {
    const res = await call(tasks, 'GET', '/me/repos?min=write', { cookie: owner.cookie })
    expect(res.data.repos.find((r: { name: string }) => r.name === repo.name)).toMatchObject({ permission: 'admin', owner: owner.login })
    const dev = await createUser('indev')
    const [issue] = await sql`INSERT INTO issues (repo_id, number, author_id, title) VALUES (${repo.id}, 99, ${owner.id}, 'task') RETURNING id`
    await sql`INSERT INTO task_sessions (repo_id, issue_id, user_id, created_by, role, allowed_paths, ref, expires_at)
      VALUES (${repo.id}, ${issue.id}, ${dev.id}, ${owner.id}, 'contractor', ${JSON.stringify(['src/'])}, 'main', '2000-01-01T00:00:00.000Z')`
    const t = await call(tasks, 'GET', '/tasks', { cookie: dev.cookie })
    expect(t.data.tasks).toHaveLength(1)
    expect(t.data.tasks[0]).toMatchObject({ status: 'expired', allowedPaths: ['src/'], issue: { number: 99, title: 'task' } })
    expect((await call(tasks, 'GET', '/me/repos', { cookie: dev.cookie })).data.repos).toEqual([])
  })
})
