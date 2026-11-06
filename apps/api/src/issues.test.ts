import { beforeAll, describe, expect, test } from 'bun:test'
import { call, createRepo, createUser, setupDb } from './sqlite-testenv.ts'
import { issues } from './issues.ts'

let owner: Awaited<ReturnType<typeof createUser>>, other: Awaited<ReturnType<typeof createUser>>, repo: Awaited<ReturnType<typeof createRepo>>
let base = ''

beforeAll(async () => {
  await setupDb()
  owner = await createUser('iown')
  other = await createUser('ioth')
  repo = await createRepo(owner.id)
  base = `/repos/${owner.login}/${repo.name}`
})

describe('issues on SQLite', () => {
  test('labels, create, list with filters and search, get, events', async () => {
    expect((await call(issues, 'POST', `${base}/labels`, { cookie: owner.cookie, body: { name: 'bug', color: '#FF0000' } })).status).toBe(201)
    expect((await call(issues, 'POST', `${base}/labels`, { cookie: owner.cookie, body: { name: 'bug' } })).status).toBe(409)
    const labels = await call(issues, 'GET', `${base}/labels`)
    expect(labels.data.labels).toEqual([{ name: 'bug', color: 'ff0000', description: null }])

    const a = await call(issues, 'POST', `${base}/issues`, { cookie: owner.cookie, body: { title: 'Payments retry is broken', body: 'The 50%_off coupon fails', labels: ['bug'], assignees: [other.login] } })
    expect(a.status).toBe(201)
    expect(a.data).toMatchObject({ number: 1, title: 'Payments retry is broken', state: 'open', locked: false, isPullRequest: false, comments: 0, author: owner.login,
      labels: [{ name: 'bug', color: 'ff0000', description: null }], assignees: [other.login], source: null, stateReason: null, closedAt: null })
    expect(a.data.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    const b = await call(issues, 'POST', `${base}/issues`, { cookie: other.cookie, body: { title: 'Docs typo' } })
    expect(b.data.number).toBe(2)
    expect((await call(issues, 'POST', `${base}/issues`, { cookie: other.cookie, body: { title: 'x', labels: ['bug'] } })).status).toBe(403)
    expect((await call(issues, 'POST', `${base}/issues`, { cookie: owner.cookie, body: { title: 'x', labels: ['nope'] } })).data.error).toBe('unknown label nope')

    const all = await call(issues, 'GET', `${base}/issues`)
    expect(all.data.total).toBe(2)
    expect(all.data.issues.map((i: any) => i.number).sort()).toEqual([1, 2])
    expect((await call(issues, 'GET', `${base}/issues?label=bug`)).data.issues.map((i: any) => i.number)).toEqual([1])
    expect((await call(issues, 'GET', `${base}/issues?assignee=${other.login}`)).data.total).toBe(1)
    expect((await call(issues, 'GET', `${base}/issues?author=${other.login}`)).data.issues.map((i: any) => i.number)).toEqual([2])
    expect((await call(issues, 'GET', `${base}/issues?q=payments%20RETRY`)).data.issues.map((i: any) => i.number)).toEqual([1])
    expect((await call(issues, 'GET', `${base}/issues?q=payments%20docs`)).data.total).toBe(0)
    expect((await call(issues, 'GET', `${base}/issues?q=50%25_off`)).data.total).toBe(1)
    expect((await call(issues, 'GET', `${base}/issues?q=5_%25`)).data.total).toBe(0)
    expect((await call(issues, 'GET', `${base}/issues?state=closed`)).data.total).toBe(0)

    const one = await call(issues, 'GET', `${base}/issues/1`)
    expect(one.data.title).toBe('Payments retry is broken')
    const ev = await call(issues, 'GET', `${base}/issues/1/events`)
    expect(ev.data.events[0]).toMatchObject({ event: 'opened', actor: owner.login, payload: {} })
  })

  test('update: rename, close, reopen; comments; labels and assignees', async () => {
    const closed = await call(issues, 'PATCH', `${base}/issues/2`, { cookie: other.cookie, body: { title: 'Docs typo fixed', state: 'closed', stateReason: 'not_planned' } })
    expect(closed.status).toBe(200)
    expect(closed.data).toMatchObject({ title: 'Docs typo fixed', state: 'closed', stateReason: 'not_planned' })
    expect(typeof closed.data.closedAt).toBe('string')
    expect((await call(issues, 'GET', `${base}/issues?state=closed`)).data.issues.map((i: any) => i.number)).toEqual([2])
    const reopened = await call(issues, 'PATCH', `${base}/issues/2`, { cookie: other.cookie, body: { state: 'open' } })
    expect(reopened.data).toMatchObject({ state: 'open', stateReason: 'reopened', closedAt: null })
    const ev = (await call(issues, 'GET', `${base}/issues/2/events`)).data.events.map((e: any) => [e.event, e.payload])
    expect(ev).toEqual([['opened', {}], ['renamed', { from: 'Docs typo', to: 'Docs typo fixed' }], ['closed', { reason: 'not_planned' }], ['reopened', { reason: 'reopened' }]])
    expect((await call(issues, 'PATCH', `${base}/issues/1`, { cookie: other.cookie, body: { title: 'hijack' } })).status).toBe(403)

    const m = await call(issues, 'POST', `${base}/issues/1/comments`, { cookie: other.cookie, body: { body: 'same here' } })
    expect(m.status).toBe(201)
    expect(m.data).toMatchObject({ body: 'same here', author: other.login })
    expect((await call(issues, 'GET', `${base}/issues/1`)).data.comments).toBe(1)
    expect((await call(issues, 'PATCH', `${base}/comments/${m.data.id}`, { cookie: other.cookie, body: { body: 'edited' } })).status).toBe(200)
    expect((await call(issues, 'GET', `${base}/issues/1/comments`)).data.comments.map((x: any) => x.body)).toEqual(['edited'])
    expect((await call(issues, 'DELETE', `${base}/comments/${m.data.id}`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(issues, 'GET', `${base}/issues/1/comments`)).data.comments).toEqual([])
    expect((await call(issues, 'GET', `${base}/issues/1`)).data.comments).toBe(0)

    await call(issues, 'POST', `${base}/labels`, { cookie: owner.cookie, body: { name: 'ui' } })
    expect((await call(issues, 'POST', `${base}/issues/2/labels`, { cookie: owner.cookie, body: { labels: ['ui', 'bug'] } })).data.labels.map((l: any) => l.name)).toEqual(['bug', 'ui'])
    expect((await call(issues, 'GET', `${base}/issues?label=bug,ui`)).data.issues.map((i: any) => i.number)).toEqual([2])
    expect((await call(issues, 'DELETE', `${base}/issues/2/labels/ui`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(issues, 'DELETE', `${base}/issues/2/labels/ui`, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(issues, 'PATCH', `${base}/labels/bug`, { cookie: owner.cookie, body: { name: 'ui' } })).status).toBe(409)
    expect((await call(issues, 'PATCH', `${base}/labels/bug`, { cookie: owner.cookie, body: { color: '00ff00' } })).status).toBe(200)
    expect((await call(issues, 'DELETE', `${base}/labels/ui`, { cookie: owner.cookie })).status).toBe(200)

    expect((await call(issues, 'POST', `${base}/issues/2/assignees`, { cookie: owner.cookie, body: { assignees: [owner.login] } })).data.assignees).toEqual([owner.login])
    expect((await call(issues, 'DELETE', `${base}/issues/2/assignees/${owner.login}`, { cookie: owner.cookie })).status).toBe(200)
    const evs = (await call(issues, 'GET', `${base}/issues/2/events`)).data.events.map((e: any) => e.event)
    expect(evs.slice(-4)).toEqual(['labeled', 'unlabeled', 'assigned', 'unassigned'])
  })

  test('allocateIssue stores import source as JSON and returns it parsed', async () => {
    const { sql } = await setupDb()
    const { allocateIssue, findIssue, issueView } = await import('./issues.ts')
    const { findRepo } = await import('./perm.ts')
    const source = { provider: 'github', url: 'https://github.com/a/b/issues/1', labels: ['x'] }
    const created = await sql.begin((tx) => allocateIssue(tx, { repoId: repo.id, authorId: owner.id, title: 'imported', body: null, source }))
    const r = (await findRepo(owner.login, repo.name))!
    expect((await issueView((await findIssue(r, created.number))!)).source).toEqual(source)
  })
})
