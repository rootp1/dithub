import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { call, createRepo, createUser, setupDb } from './sqlite-testenv.ts'
import { suggestScope, suggestDeps, SUGGEST_RATE_PER_HOUR } from './suggest-scope.ts'
import { issues } from './issues.ts'
import { ZeroGError } from './zerog.ts'

let owner: Awaited<ReturnType<typeof createUser>>, repo: Awaited<ReturnType<typeof createRepo>>
let base = ''
const realChat = suggestDeps.chat
const realKey = process.env.ZG_API_KEY

beforeAll(async () => {
  await setupDb()
  process.env.ZG_API_KEY = 'sk-test'
  owner = await createUser('gown')
  repo = await createRepo(owner.id)
  base = `/repos/${owner.login}/${repo.name}`
  expect((await call(issues, 'POST', `${base}/issues`, { cookie: owner.cookie, body: { title: 'App constant is wrong', body: 'see app' } })).status).toBe(201)
})
afterAll(() => {
  suggestDeps.chat = realChat
  if (realKey === undefined) delete process.env.ZG_API_KEY; else process.env.ZG_API_KEY = realKey
})

describe('suggest-scope on SQLite', () => {
  test('validated paths are returned and recorded with an audit row; failures are recorded too', async () => {
    const { sql, parseJson } = await setupDb()
    suggestDeps.chat = async () => ({ text: JSON.stringify({ paths: [{ path: 'src/app.ts', reason: 'the constant' }, { path: 'src/invented.ts' }] }),
      requestId: 'r-1', model: 'm-test', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, provider: null, sealed: true, teeVerified: null })
    const res = await call(suggestScope, 'POST', `${base}/issues/1/suggest-scope`, { cookie: owner.cookie, body: { maxPaths: 5 } })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ paths: [{ path: 'src/app.ts', kind: 'file', reason: 'the constant' }], model: 'm-test', requestId: 'r-1', sealed: true, ref: 'main', considered: 3 })

    suggestDeps.chat = async () => { throw new ZeroGError('boom', 500, 'upstream', 'r-2') }
    expect((await call(suggestScope, 'POST', `${base}/issues/1/suggest-scope`, { cookie: owner.cookie })).status).toBe(502)

    const rows = await sql`SELECT zg_request_id, paths, error FROM scope_suggestions WHERE repo_id = ${repo.id} ORDER BY created_at, rowid`
    expect(rows.map((r: any) => [r.zg_request_id, parseJson(r.paths), r.error])).toEqual([
      ['r-1', [{ path: 'src/app.ts', kind: 'file', reason: 'the constant' }], null], ['r-2', null, 'boom']])
    const audit = await sql`SELECT metadata FROM audit_log WHERE action = 'issue.suggest_scope' AND target_id = ${repo.id} ORDER BY id`
    expect(audit.map((a: any) => parseJson(a.metadata))).toEqual([
      { issue: 1, pathCount: 1, model: 'm-test', requestId: 'r-1' }, { issue: 1, pathCount: 0, model: expect.any(String), requestId: 'r-2', failed: true }])
  })

  test('rate limit and access checks', async () => {
    const { sql, now } = await setupDb()
    const stranger = await createUser('gstr')
    expect((await call(suggestScope, 'POST', `${base}/issues/1/suggest-scope`, { cookie: stranger.cookie })).status).toBe(403)
    expect((await call(suggestScope, 'POST', `${base}/issues/9/suggest-scope`, { cookie: owner.cookie })).status).toBe(404)
    const [i] = await sql`SELECT id FROM issues WHERE repo_id = ${repo.id} AND number = 1`
    for (let n = 0; n < SUGGEST_RATE_PER_HOUR; n++) await sql`INSERT INTO scope_suggestions (repo_id, issue_id, user_id, created_at) VALUES (${repo.id}, ${i.id}, ${owner.id}, ${now()})`
    expect((await call(suggestScope, 'POST', `${base}/issues/1/suggest-scope`, { cookie: owner.cookie })).status).toBe(429)
  })
})
