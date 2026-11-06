import { beforeAll, describe, expect, test } from 'bun:test'
import { call, createRepo, createUser, setupDb } from './sqlite-testenv.ts'
import { sessions, loadSessionForUser, logSessionEvent } from './sessions.ts'
import { issues } from './issues.ts'

let owner: Awaited<ReturnType<typeof createUser>>, dev: Awaited<ReturnType<typeof createUser>>, repo: Awaited<ReturnType<typeof createRepo>>
let base = ''

beforeAll(async () => {
  await setupDb()
  owner = await createUser('sown')
  dev = await createUser('sdev')
  repo = await createRepo(owner.id)
  base = `/repos/${owner.login}/${repo.name}`
  expect((await call(issues, 'POST', `${base}/issues`, { cookie: owner.cookie, body: { title: 'Fix the app' } })).status).toBe(201)
})

describe('task sessions on SQLite', () => {
  let id = ''

  test('create, list, get, issue, scoped load', async () => {
    expect((await call(sessions, 'POST', `${base}/sessions`, { cookie: dev.cookie, body: { issueNumber: 1, login: dev.login, role: 'contractor', paths: ['src'] } })).status).toBe(403)
    const created = await call(sessions, 'POST', `${base}/sessions`, { cookie: owner.cookie, body: { issueNumber: 1, login: dev.login, role: 'contractor', paths: ['src/', 'src', 'docs/*.md'], ttlMinutes: 30 } })
    expect(created.status).toBe(201)
    id = created.data.id
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(created.data).toMatchObject({ repoId: repo.id, issueNumber: 1, user: dev.login, createdBy: owner.login, role: 'contractor',
      allowedPaths: ['src', 'docs/*.md'], ref: 'main', status: 'active', endedAt: null, endReason: null })
    const ttl = Date.parse(created.data.expiresAt) - Date.parse(created.data.createdAt)
    expect(ttl).toBeGreaterThan(29 * 60_000)
    expect(ttl).toBeLessThan(31 * 60_000)
    expect((await call(sessions, 'POST', `${base}/sessions`, { cookie: owner.cookie, body: { issueNumber: 1, login: dev.login, role: 'contractor', paths: ['src'] } })).status).toBe(409)

    // creating a session assigns the developer and logs an issue event
    const issue = await call(issues, 'GET', `${base}/issues/1`)
    expect(issue.data.assignees).toEqual([dev.login])
    const ev = (await call(issues, 'GET', `${base}/issues/1/events`)).data.events.at(-1)
    expect(ev).toMatchObject({ event: 'session_started', payload: { sessionId: id } })

    const mine = await call(sessions, 'GET', '/sessions', { cookie: dev.cookie })
    expect(mine.data.sessions).toEqual([expect.objectContaining({ id, owner: owner.login, repo: repo.name, status: 'active', allowedPaths: ['src', 'docs/*.md'] })])
    expect((await call(sessions, 'GET', '/sessions?status=ended', { cookie: dev.cookie })).data.sessions).toEqual([])
    expect((await call(sessions, 'GET', `${base}/sessions`, { cookie: owner.cookie })).data.sessions.map((s: any) => s.id)).toEqual([id])
    expect((await call(sessions, 'GET', `/sessions/${id.toUpperCase()}`, { cookie: dev.cookie })).data.id).toBe(id)
    expect((await call(sessions, 'GET', `/sessions/${id}/issue`, { cookie: dev.cookie })).data).toEqual({ number: 1, title: 'Fix the app', body: null, state: 'open' })

    const scope = (await loadSessionForUser(id.toUpperCase(), dev.id))!
    expect(scope).toMatchObject({ id, repoId: repo.id, issueNumber: 1, userId: dev.id, role: 'contractor', allowedPaths: ['src', 'docs/*.md'], ref: 'main', repoIdHex: repo.idHex })
    expect(scope.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await loadSessionForUser(id, owner.id)).toBeNull()
  })

  test('events, export, end; expired sessions flip to expired', async () => {
    await logSessionEvent(id, dev.id, 'blob', { path: 'src/app.ts' })
    const events = await call(sessions, 'GET', `/sessions/${id}/events`, { cookie: owner.cookie })
    expect(events.data.events.map((e: any) => [e.kind, e.detail])).toEqual([['blob', { path: 'src/app.ts' }], ['create', { role: 'contractor', paths: 2, ttlMinutes: 30 }]])
    expect((await call(sessions, 'GET', `/sessions/${id}/events`, { cookie: dev.cookie })).status).toBe(404)

    const exp = await sessions.request(`/sessions/${id}/export`, { headers: { cookie: dev.cookie } })
    expect(exp.status).toBe(200)
    expect(exp.headers.get('x-dheet-files')).toBe('2')
    await exp.arrayBuffer()

    const ended = await call(sessions, 'POST', `/sessions/${id}/end`, { cookie: dev.cookie })
    expect(ended.data).toMatchObject({ id, status: 'ended', endReason: 'ended' })
    expect(typeof ended.data.endedAt).toBe('string')
    expect((await call(sessions, 'POST', `/sessions/${id}/revoke`, { cookie: owner.cookie })).status).toBe(409)
    expect(await loadSessionForUser(id, dev.id)).toBeNull()

    const { sql } = await setupDb()
    const again = await call(sessions, 'POST', `${base}/sessions`, { cookie: owner.cookie, body: { issueNumber: 1, login: dev.login, role: 'maintainer' } })
    expect(again.data.allowedPaths).toEqual(['**'])
    await sql`UPDATE task_sessions SET expires_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${again.data.id}`
    expect((await call(sessions, 'GET', `/sessions/${again.data.id}`, { cookie: dev.cookie })).data.status).toBe('expired')
  })
})
