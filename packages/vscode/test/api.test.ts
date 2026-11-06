import { describe, expect, test } from 'bun:test'
import { ApiError, DithubClient, OutOfScopeError, type FetchFn } from '../src/api.ts'

const SID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const TOKEN = 'dht_test_secret_token_value'
interface Call { url: URL; method: string; headers: Record<string, string>; body: unknown }

function mock(handler: (c: Call) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const calls: Call[] = []
  const f: FetchFn = async (input, init) => {
    const c: Call = { url: new URL(input), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const r = await handler(c)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, f }
}
const client = (f: FetchFn, extra: Partial<ConstructorParameters<typeof DithubClient>[0]> = {}) => new DithubClient({ host: 'https://dithub.test/', getToken: () => TOKEN, fetch: f, ...extra })
const target = { owner: 'alice', repo: 'web', ref: 'main', sessionId: SID, allowedPaths: ['src/payments'] }

describe('DithubClient', () => {
  test('bearer token only in the Authorization header, never in the URL', async () => {
    const m = mock(() => ({ body: { user: { login: 'alice' } } }))
    expect(await client(m.f).me()).toEqual({ login: 'alice' })
    expect(m.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(m.calls[0]!.url.toString()).not.toContain(TOKEN)
    expect(m.calls[0]!.url.origin).toBe('https://dithub.test')
  })
  test('device login: start, pending, slow_down, denied, expired, ok; anonymous requests', async () => {
    const answers = [
      { status: 201, body: { deviceCode: 'd'.repeat(43), userCode: 'ABCD-EFGH', verificationUrl: 'https://dithub.test/cli?code=ABCD-EFGH', expiresIn: 600, interval: 5 } },
      { status: 400, body: { error: 'authorization_pending' } }, { status: 429, body: { error: 'slow_down' } }, { status: 403, body: { error: 'access_denied' } },
      { status: 400, body: { error: 'expired_token' } }, { status: 200, body: { token: TOKEN, login: 'alice', note: 'shown once' } },
    ]
    const m = mock(() => answers.shift()!)
    const c = client(m.f)
    const d = await c.startDeviceLogin('VS Code on test')
    expect(d.userCode).toBe('ABCD-EFGH')
    expect(m.calls[0]!.body).toEqual({ name: 'VS Code on test' })
    expect(m.calls[0]!.headers.authorization).toBeUndefined()
    const seq = []
    for (let i = 0; i < 5; i++) seq.push((await c.pollDeviceToken(d.deviceCode)).status)
    expect(seq).toEqual(['pending', 'slow_down', 'denied', 'expired', 'ok'])
    expect(m.calls.slice(1).every((x) => x.url.pathname === '/api/cli/token' && x.method === 'POST' && !x.headers.authorization)).toBe(true)
  })
  test('revokeToken sends DELETE with the token as bearer; 404 means already revoked', async () => {
    const m = mock((c) => ({ status: c.headers.authorization === 'Bearer gone' ? 404 : 200, body: c.headers.authorization === 'Bearer gone' ? { error: 'token not found or already revoked' } : { ok: true } }))
    const c = client(m.f)
    expect(await c.revokeToken('tok1')).toBe(true)
    expect(m.calls[0]!.method).toBe('DELETE'); expect(m.calls[0]!.url.pathname).toBe('/api/cli/token')
    expect(await c.revokeToken('gone')).toBe(false)
  })
  test('401 calls onUnauthorized and throws ApiError', async () => {
    let n = 0
    const m = mock(() => ({ status: 401, body: { error: 'sign in first' } }))
    const err = await client(m.f, { onUnauthorized: () => { n++ } }).tasks().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(401); expect(n).toBe(1)
    expect(String(err.message)).not.toContain(TOKEN)
  })
  test('myRepos, issues', async () => {
    const m = mock((c) => c.url.pathname === '/api/me/repos'
      ? { body: { repos: [{ owner: 'alice', name: 'web', visibility: 'private', permission: 'admin', defaultBranch: 'main', repoId: '0x1' }] } }
      : { body: { total: 1, page: 1, perPage: 100, issues: [{ number: 7, title: 'Bug', state: 'open', assignees: [], labels: [] }] } })
    const c = client(m.f)
    expect((await c.myRepos())[0]!.name).toBe('web')
    expect(m.calls[0]!.url.searchParams.get('min')).toBe('maintain')
    expect((await c.issues('alice', 'web'))[0]!.number).toBe(7)
    expect(m.calls[1]!.url.pathname).toBe('/api/repos/alice/web/issues'); expect(m.calls[1]!.url.searchParams.get('state')).toBe('open')
  })
  test('suggestScope: request body and parsed result; 502 surfaces as ApiError (no invented paths)', async () => {
    const m = mock(() => ({ body: { paths: [{ path: 'src/payments', kind: 'dir', reason: 'retry logic' }], model: '0gm-1.0-35b-a3b', requestId: 'req-9', sealed: true, ref: 'main', considered: 12 } }))
    const s = await client(m.f).suggestScope('alice', 'web', 7, { maxPaths: 8 })
    expect(m.calls[0]!.method).toBe('POST'); expect(m.calls[0]!.url.pathname).toBe('/api/repos/alice/web/issues/7/suggest-scope'); expect(m.calls[0]!.body).toEqual({ maxPaths: 8 })
    expect(s).toMatchObject({ model: '0gm-1.0-35b-a3b', requestId: 'req-9', sealed: true, paths: [{ path: 'src/payments', kind: 'dir', reason: 'retry logic' }] })
    const bad = mock(() => ({ status: 502, body: { error: '0G unavailable' } }))
    const err = await client(bad.f).suggestScope('alice', 'web', 7).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(502); expect(bad.calls.length).toBe(1)
  })
  test('assign + createSession bodies', async () => {
    const m = mock((c) => c.url.pathname.endsWith('/assignees') ? { body: { assignees: ['bob'] } }
      : { status: 201, body: { id: SID, repoId: 1, issueNumber: 7, user: 'bob', createdBy: 'alice', role: 'contractor', allowedPaths: ['src/payments'], ref: 'main', status: 'active', expiresAt: '2030-01-01T00:00:00Z' } })
    const c = client(m.f)
    expect(await c.assign('alice', 'web', 7, ['bob'])).toEqual(['bob'])
    expect(m.calls[0]!.body).toEqual({ assignees: ['bob'] })
    const s = await c.createSession('alice', 'web', { issueNumber: 7, login: 'bob', role: 'contractor', paths: ['src/payments'], ttlMinutes: 480 })
    expect(s.id).toBe(SID)
    expect(m.calls[1]!.url.pathname).toBe('/api/repos/alice/web/sessions')
    expect(m.calls[1]!.body).toEqual({ issueNumber: 7, login: 'bob', role: 'contractor', paths: ['src/payments'], ttlMinutes: 480 })
    expect(await c.assign('alice', 'web', 7, ['Bad Name']).catch((e) => e)).toBeInstanceOf(ApiError)
    expect(await c.createSession('alice', 'web', { issueNumber: 7, login: 'bob', role: 'contractor', paths: ['../x'], ttlMinutes: 60 }).catch((e) => e)).toBeInstanceOf(ApiError)
    expect(m.calls.length).toBe(2)
  })
  test('tasks', async () => {
    const m = mock(() => ({ body: { tasks: [{ sessionId: SID, repo: { owner: 'alice', name: 'web' }, issue: { number: 7, title: 'Bug', state: 'open' }, role: 'contractor', allowedPaths: ['src/payments'], ref: 'main', status: 'active', expiresAt: '2030-01-01T00:00:00Z', createdAt: '2029-01-01T00:00:00Z', createdBy: 'alice' }] } }))
    const t = await client(m.f).tasks()
    expect(t[0]!.sessionId).toBe(SID); expect(m.calls[0]!.url.pathname).toBe('/api/tasks')
  })
  test('scoped tree/blob send x-dheet-session and ref; out-of-scope paths never hit the network', async () => {
    const m = mock((c) => c.url.pathname.endsWith('/tree') ? { body: { entries: [{ type: 'tree', name: 'src', path: 'src', size: null }] } } : { body: { path: 'src/payments/pay.ts', size: 3, binary: false, content: 'abc' } })
    const c = client(m.f)
    await c.scopedTree(target, '')
    await c.scopedTree(target, 'src')
    const b = await c.scopedBlob(target, 'src/payments/pay.ts')
    expect(b.content).toBe('abc')
    for (const call of m.calls) { expect(call.headers['x-dheet-session']).toBe(SID); expect(call.url.searchParams.get('ref')).toBe('main') }
    expect(m.calls[2]!.url.searchParams.get('path')).toBe('src/payments/pay.ts')
    for (const p of ['README.md', 'src/other/x.ts', 'src/payments/../other/x.ts', '.git/config']) expect(await c.scopedBlob(target, p).catch((e) => e)).toBeInstanceOf(OutOfScopeError)
    expect(await c.scopedTree(target, 'src/other').catch((e) => e)).toBeInstanceOf(OutOfScopeError)
    expect(m.calls.length).toBe(3)
  })
  test('GET retries 503 then succeeds; POST is not retried', async () => {
    let n = 0
    const m = mock(() => (++n < 2 ? { status: 503, body: { error: 'busy' } } : { body: { tasks: [] } }))
    expect(await client(m.f).tasks()).toEqual([])
    expect(m.calls.length).toBe(2)
    const p = mock(() => ({ status: 503, body: { error: 'busy' } }))
    expect((await client(p.f).endSession(SID).catch((e) => e)).status).toBe(503)
    expect(p.calls.length).toBe(1)
  })
  test('assistant summarize/ask/calls', async () => {
    const m = mock((c) => c.url.pathname.endsWith('/calls') ? { body: { calls: [{ id: 1, kind: 'ask', refused: true, question: 'q', answer: 'no' }] } }
      : { body: { callId: 3, refused: false, answer: 'It retries.', requestId: 'zg-1', model: '0gm', sealed: true, teeVerified: null, filesUsed: ['src/payments/pay.ts'] } })
    const c = client(m.f)
    expect((await c.summarize(SID)).requestId).toBe('zg-1')
    expect(m.calls[0]!.url.pathname).toBe(`/api/sessions/${SID}/assistant/summarize`)
    await c.ask(SID, 'how?')
    expect(m.calls[1]!.body).toEqual({ question: 'how?' })
    expect((await c.assistantCalls(SID))[0]!.refused).toBe(true)
  })
  test('proposeFiles: files variant body; local scope check; 422 reasons kept', async () => {
    const m = mock(() => ({ status: 201, body: { branch: 'session/7-bob', commit: '0xabc', pullRequest: 8, files: 1 } }))
    const c = client(m.f)
    const r = await c.proposeFiles(SID, ['src/payments'], { title: 'Fix', files: [{ path: 'src/payments/pay.ts', content: 'x' }] })
    expect(r.pullRequest).toBe(8)
    expect(m.calls[0]!.body).toEqual({ title: 'Fix', files: [{ path: 'src/payments/pay.ts', content: 'x' }] })
    const local = await c.proposeFiles(SID, ['src/payments'], { files: [{ path: 'src/other/x.ts', content: '' }] }).catch((e) => e)
    expect(local.status).toBe(422); expect(local.body.paths).toEqual(['src/other/x.ts']); expect(m.calls.length).toBe(1)
    const rej = mock(() => ({ status: 422, body: { error: 'patch produces no change', paths: [] } }))
    const e = await client(rej.f).proposeFiles(SID, ['src/payments'], { files: [{ path: 'src/payments/pay.ts', content: 'x' }] }).catch((x) => x)
    expect(e.status).toBe(422); expect(e.message).toBe('patch produces no change')
  })
  test('network failure and timeout become ApiError(0) without the token', async () => {
    const f: FetchFn = async () => { throw new TypeError(`connect ECONNREFUSED`) }
    const e = await new DithubClient({ host: 'http://localhost:1', getToken: () => TOKEN, fetch: f }).endSession(SID).catch((x) => x)
    expect(e).toBeInstanceOf(ApiError); expect(e.status).toBe(0); expect(e.message).toContain('cannot reach'); expect(e.message).not.toContain(TOKEN)
    const slow: FetchFn = (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))))
    const t = await new DithubClient({ host: 'http://localhost:1', fetch: slow, timeoutMs: 20 }).endSession(SID).catch((x) => x)
    expect(t.message).toContain('timed out')
  })
})
