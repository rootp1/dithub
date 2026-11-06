import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { call, createRepo, createUser, setupDb } from './sqlite-testenv.ts'
import { assistant, deps, RATE_LIMIT_PER_HOUR } from './assistant.ts'
import { allocateIssue } from './issues.ts'
import { ZeroGError, type ChatFn } from './zerog.ts'

let dev: Awaited<ReturnType<typeof createUser>>, other: Awaited<ReturnType<typeof createUser>>
let sessionId = ''
const realChat = deps.chat

beforeAll(async () => {
  const { sql, json, now, newId } = await setupDb()
  const owner = await createUser('aown')
  dev = await createUser('adev')
  other = await createUser('aoth')
  const repo = await createRepo(owner.id)
  const issue = await sql.begin((tx) => allocateIssue(tx, { repoId: repo.id, authorId: owner.id, title: 'Make a configurable', body: 'src/app.ts exports a constant' }))
  sessionId = newId()
  await sql`INSERT INTO task_sessions (id, repo_id, issue_id, user_id, created_by, role, allowed_paths, ref, expires_at)
    VALUES (${sessionId}, ${repo.id}, ${issue.id}, ${dev.id}, ${owner.id}, 'contractor', ${json(['src'])}, 'main', ${now(3_600_000)})`
})
afterAll(() => { deps.chat = realChat })

const ok: ChatFn = async () => ({ text: 'Change `a` in src/app.ts.', requestId: 'req-1', model: 'm-test', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  provider: null, sealed: true, teeVerified: null })

describe('assistant on SQLite', () => {
  test('summarize records a call, failures are recorded, calls list keeps the JSON shape', async () => {
    deps.chat = ok
    const res = await call(assistant, 'POST', `/api/sessions/${sessionId}/assistant/summarize`, { cookie: dev.cookie })
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ refused: false, answer: 'Change `a` in src/app.ts.', requestId: 'req-1', model: 'm-test', sealed: true, teeVerified: null,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })
    expect(res.data.callId).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof res.data.createdAt).toBe('string')

    deps.chat = async () => { throw new ZeroGError('upstream down', 503, 'unavailable', 'req-2') }
    const bad = await call(assistant, 'POST', `/api/sessions/${sessionId.toUpperCase()}/assistant/ask`, { cookie: dev.cookie, body: { question: 'What does src/app.ts export?' } })
    expect(bad.status).toBe(502)
    expect(bad.data).toEqual({ error: '0G Private Computer is unavailable: upstream down', answer: null })

    const calls = await call(assistant, 'GET', `/api/sessions/${sessionId}/assistant/calls`, { cookie: dev.cookie })
    expect(calls.data.calls.length).toBe(2)
    const byKind = Object.fromEntries(calls.data.calls.map((c: any) => [c.kind, c]))
    expect(byKind.summarize).toMatchObject({ id: res.data.callId, refused: false, sealed: true, teeVerified: null, tokensIn: 10, tokensOut: 5, failed: false, requestId: 'req-1', model: 'm-test', question: null })
    expect(byKind.ask).toMatchObject({ refused: false, sealed: null, teeVerified: null, failed: true, requestId: 'req-2', question: 'What does src/app.ts export?' })
    expect((await call(assistant, 'GET', `/api/sessions/${sessionId}/assistant/calls`, { cookie: other.cookie })).data.calls).toEqual([])
    expect((await call(assistant, 'POST', `/api/sessions/${sessionId}/assistant/summarize`, { cookie: other.cookie })).status).toBe(404)
  })

  test('hourly rate limit counts only the last hour', async () => {
    const { sql, now } = await setupDb()
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) await sql`INSERT INTO assistant_calls (session_id, user_id, kind, created_at) VALUES (${sessionId}, ${dev.id}, 'summarize', ${now(-2 * 3_600_000)})`
    deps.chat = ok
    expect((await call(assistant, 'POST', `/api/sessions/${sessionId}/assistant/summarize`, { cookie: dev.cookie })).status).toBe(200)
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) await sql`INSERT INTO assistant_calls (session_id, user_id, kind) VALUES (${sessionId}, ${dev.id}, 'summarize')`
    expect((await call(assistant, 'POST', `/api/sessions/${sessionId}/assistant/summarize`, { cookie: dev.cookie })).status).toBe(429)
  })
})
