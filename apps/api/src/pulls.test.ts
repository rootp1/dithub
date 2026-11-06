import { beforeAll, describe, expect, test } from 'bun:test'
import { call, createRepo, createUser, setupDb } from './sqlite-testenv.ts'
import { pulls } from './pulls.ts'

let owner: Awaited<ReturnType<typeof createUser>>, reviewer: Awaited<ReturnType<typeof createUser>>, repo: Awaited<ReturnType<typeof createRepo>>
let base = ''

beforeAll(async () => {
  const { sql } = await setupDb()
  owner = await createUser('pown')
  reviewer = await createUser('prev')
  repo = await createRepo(owner.id)
  await sql`INSERT INTO repo_collaborators (repo_id, user_id, permission) VALUES (${repo.id}, ${reviewer.id}, 'write')`
  await sql`INSERT INTO branch_protections (repo_id, pattern, required_approvals, require_status_checks) VALUES (${repo.id}, 'main', 1, ${JSON.stringify(['ci'])})`
  base = `/repos/${owner.login}/${repo.name}`
})

describe('pull requests on SQLite', () => {
  test('create, list, get, files, commits', async () => {
    const created = await call(pulls, 'POST', `${base}/pulls`, { cookie: owner.cookie, body: { title: 'Add feature', head: 'feature', base: 'main', draft: true } })
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({ number: 1, title: 'Add feature', state: 'open', draft: true, isPullRequest: true, head: 'feature', base: 'main',
      mergeable: 'clean', additions: 2, deletions: 1, changedFiles: 2, fromSession: false, mergedAt: null, mergeCommitOid: null, locked: false,
      reviews: { approvals: [], changesRequested: [], requiredApprovals: 1 }, protection: { pattern: 'main', requireStatusChecks: ['ci'] } })
    expect(created.data.headOid).toMatch(/^0x[0-9a-f]{40}$/)
    expect((await call(pulls, 'POST', `${base}/pulls`, { cookie: owner.cookie, body: { title: 'dup', head: 'feature', base: 'main' } })).status).toBe(409)
    expect((await call(pulls, 'POST', `${base}/pulls`, { cookie: reviewer.cookie, body: { title: 'no', head: 'main', base: 'feature' } })).status).toBe(422)

    const list = await call(pulls, 'GET', `${base}/pulls`)
    expect(list.data).toMatchObject({ total: 1, page: 1, perPage: 30 })
    expect(list.data.pulls[0]).toMatchObject({ number: 1, draft: true, state: 'open', author: owner.login, mergeable: 'clean', mergedAt: null })
    expect((await call(pulls, 'GET', `${base}/pulls?state=closed`)).data.total).toBe(0)
    expect((await call(pulls, 'GET', `${base}/pulls/1`)).data.title).toBe('Add feature')
    const files = (await call(pulls, 'GET', `${base}/pulls/1/files`)).data.files.map((f: any) => [f.path, f.status])
    expect(files).toEqual([['src/app.ts', 'modified'], ['src/new.ts', 'added']])
    expect((await call(pulls, 'GET', `${base}/pulls/1/commits`)).data.commits.map((m: any) => m.subject)).toEqual(['feature work'])
  })

  test('update, reviews and merge blockers', async () => {
    const closed = await call(pulls, 'PATCH', `${base}/pulls/1`, { cookie: owner.cookie, body: { state: 'closed', draft: false } })
    expect(closed.data).toMatchObject({ state: 'closed', draft: false, stateReason: 'not_planned' })
    expect(typeof closed.data.closedAt).toBe('string')
    const reopened = await call(pulls, 'PATCH', `${base}/pulls/1`, { cookie: owner.cookie, body: { state: 'open', title: 'Add feature v2' } })
    expect(reopened.data).toMatchObject({ state: 'open', title: 'Add feature v2', stateReason: 'reopened', closedAt: null, draft: false })

    let mg = await call(pulls, 'GET', `${base}/pulls/1/mergeable`)
    expect(mg.data.canMerge).toBe(false)
    expect(mg.data.blockers).toEqual(['needs 1 approving review(s) on the current head, has 0', 'required status check "ci" has not passed'])

    expect((await call(pulls, 'POST', `${base}/pulls/1/reviews`, { cookie: owner.cookie, body: { event: 'approve' } })).status).toBe(403)
    expect((await call(pulls, 'POST', `${base}/pulls/1/reviews`, { cookie: reviewer.cookie, body: { event: 'request_changes', body: 'please fix',
      comments: [{ path: 'src/app.ts', line: 1, body: 'why 2?' }] } })).status).toBe(201)
    mg = await call(pulls, 'GET', `${base}/pulls/1/mergeable`)
    expect(mg.data.blockers).toContain(`changes requested by ${reviewer.login}`)
    const ok = await call(pulls, 'POST', `${base}/pulls/1/reviews`, { cookie: reviewer.cookie, body: { event: 'approve' } })
    expect(ok.status).toBe(201)
    expect(ok.data).toMatchObject({ state: 'approved' })
    expect(ok.data.commitOid).toMatch(/^0x[0-9a-f]{40}$/)

    const view = await call(pulls, 'GET', `${base}/pulls/1`)
    expect(view.data.reviews).toEqual({ approvals: [reviewer.login], changesRequested: [], requiredApprovals: 1 })
    const reviews = await call(pulls, 'GET', `${base}/pulls/1/reviews`)
    expect(reviews.data.reviews.map((r: any) => r.state)).toEqual(['changes_requested', 'approved'])
    expect(reviews.data.reviews[0].comments).toEqual([expect.objectContaining({ path: 'src/app.ts', line: 1, side: 'RIGHT', body: 'why 2?', resolved: false, author: reviewer.login })])
    expect(typeof reviews.data.reviews[0].submittedAt).toBe('string')

    const { sql, hex } = await setupDb()
    await sql`INSERT INTO check_runs (repo_id, head_oid, name, status, conclusion) VALUES (${repo.id}, ${hex(view.data.headOid)}, 'ci', 'completed', 'success')`
    mg = await call(pulls, 'GET', `${base}/pulls/1/mergeable`)
    expect(mg.data).toEqual({ mergeable: 'clean', canMerge: true, blockers: [] })
  })

  test('merge (squash) records the merge on the PR and issue', async () => {
    const res = await call(pulls, 'POST', `${base}/pulls/1/merge`, { cookie: owner.cookie, body: { method: 'squash' } })
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ merged: true, method: 'squash', ref: 'refs/heads/main' })
    const view = await call(pulls, 'GET', `${base}/pulls/1`)
    expect(view.data).toMatchObject({ state: 'merged', mergeMethod: 'squash', mergeCommitOid: res.data.mergeCommitOid, stateReason: 'completed' })
    expect(typeof view.data.mergedAt).toBe('string')
    expect((await call(pulls, 'GET', `${base}/pulls?state=merged`)).data.total).toBe(1)
  })
})
