import { describe, expect, test } from 'bun:test'
import {
  assignSummary, buildProposal, countdown, diffOverlay, emptyOverlay, escapeHtml, friendlyError, isAncestorOfScope, isDeadSessionError, isLive,
  normalizeReadPath, overlayChildren, overlayHasDir, parseAssistant, parseBlob, parseCalls, parseIssues, parseLogin, parseMyRepos, parseOverlay, parseProposal,
  parseSuggestScope, parseTasks, parseTree, pathInScope, prUrl, ProtocolError, repoPathFromUri, taskDescription, taskLabel, taskTooltip, visibleEntries,
  visiblePath, writablePath, type Task,
} from '../src/core.ts'
import { chatHtml, csp, parseMsg, taskHtml } from '../src/html.ts'

const SID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const task = (over: Partial<Task> = {}): Task => ({
  sessionId: SID, repo: { owner: 'alice', name: 'web' }, issue: { number: 7, title: 'Retry is broken', state: 'open' }, role: 'contractor',
  allowedPaths: ['src/payments', 'docs/pay.md'], ref: 'main', status: 'active', expiresAt: new Date(Date.now() + 3 * 3600_000 + 60_000).toISOString(),
  createdAt: new Date().toISOString(), createdBy: 'alice', ...over,
})

describe('parseLogin', () => {
  test('strips @ and whitespace', () => { expect(parseLogin('  @bob ')).toEqual({ ok: true, login: 'bob' }); expect(parseLogin('dev-1')).toEqual({ ok: true, login: 'dev-1' }) })
  test('rejects bad logins', () => {
    for (const bad of ['', '@', 'a b', '-bob', 'bob-', 'b_b', 'a'.repeat(40), 'bob/x', '@@']) expect(parseLogin(bad).ok).toBe(false)
  })
  test('uppercase gets a lowercase hint', () => { const r = parseLogin('@Bob'); expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toContain('@bob') })
})

describe('scope checks (mirror of the server)', () => {
  const allowed = ['src/payments', 'docs/pay.md', 'lib/*.ts', 'gen/**']
  test('pathInScope matches whole segments, case-sensitive', () => {
    expect(pathInScope(allowed, 'src/payments')).toBe(true)
    expect(pathInScope(allowed, 'src/payments/a/b.ts')).toBe(true)
    expect(pathInScope(allowed, 'src/paymentsx/a.ts')).toBe(false)
    expect(pathInScope(allowed, 'SRC/payments/a.ts')).toBe(false)
    expect(pathInScope(allowed, 'docs/pay.md')).toBe(true)
    expect(pathInScope(allowed, 'docs/other.md')).toBe(false)
    expect(pathInScope(allowed, 'lib/x.ts')).toBe(true)
    expect(pathInScope(allowed, 'lib/x.js')).toBe(false)
    expect(pathInScope(allowed, 'gen/a/b/c')).toBe(true)
    expect(pathInScope(allowed, 'README.md')).toBe(false)
  })
  test('traversal and odd paths are never in scope', () => {
    for (const p of ['src/payments/../other/x.ts', '/src/payments/a', 'src//payments', 'src/payments/.git/config', 'src\\payments', 'src/payments/‮a', 'src/payments/*', ':src/payments', '']) expect(pathInScope(allowed, p)).toBe(false)
  })
  test('ancestors', () => {
    expect(isAncestorOfScope(allowed, '')).toBe(true)
    expect(isAncestorOfScope(allowed, 'src')).toBe(true)
    expect(isAncestorOfScope(allowed, 'docs')).toBe(true)
    expect(isAncestorOfScope(allowed, 'other')).toBe(false)
    expect(isAncestorOfScope(allowed, '../src')).toBe(false)
  })
  test('visible/writable', () => {
    expect(visiblePath(allowed, '', true)).toBe(true)
    expect(visiblePath(allowed, 'src', true)).toBe(true)
    expect(visiblePath(allowed, 'src', false)).toBe(false)
    expect(writablePath(allowed, 'src/payments/new.ts')).toBe(true)
    expect(writablePath(allowed, 'src/new.ts')).toBe(false)
    expect(writablePath(allowed, '')).toBe(false)
  })
  test('visibleEntries drops restricted names, submodules and out-of-scope entries', () => {
    const entries = [
      { type: 'tree', name: 'src', path: 'src' }, { type: 'blob', name: 'README.md', path: 'README.md' }, { type: 'tree', name: 'secret', path: 'secret', restricted: true },
      { type: 'commit', name: 'sub', path: 'src/payments/sub' }, { type: 'blob', name: 'pay.ts', path: 'src/payments/pay.ts' }, { type: 'tree', name: 'other', path: 'src/other' },
    ]
    expect(visibleEntries(['src/payments'], entries).map((e) => e.path)).toEqual(['src', 'src/payments/pay.ts'])
  })
  test('repoPathFromUri', () => {
    expect(repoPathFromUri('/')).toBe('')
    expect(repoPathFromUri('/src/a.ts')).toBe('src/a.ts')
    expect(repoPathFromUri('/src/../x')).toBeNull()
    expect(repoPathFromUri('/.git/config')).toBeNull()
    expect(normalizeReadPath('a/b/')).toBe('a/b')
  })
})

describe('overlay', () => {
  test('parseOverlay is defensive', () => {
    expect(parseOverlay(undefined)).toEqual(emptyOverlay())
    expect(parseOverlay({ version: 2 })).toEqual(emptyOverlay())
    const o = parseOverlay({ version: 1, files: { 'src/a.ts': { content: 'x', mtime: 5 }, '../evil': { content: 'y', mtime: 1 }, 'b': { content: 3 } }, dirs: ['src/new', '/abs', 3] })
    expect(Object.keys(o.files)).toEqual(['src/a.ts'])
    expect(o.dirs).toEqual(['src/new'])
  })
  test('children and implied dirs', () => {
    const o = { version: 1 as const, files: { 'src/payments/a.ts': { content: '', mtime: 0 }, 'src/payments/new/b.ts': { content: '', mtime: 0 } }, dirs: ['src/payments/empty'] }
    expect(overlayChildren(o, 'src/payments')).toEqual([
      { name: 'a.ts', path: 'src/payments/a.ts', type: 'file' }, { name: 'empty', path: 'src/payments/empty', type: 'dir' }, { name: 'new', path: 'src/payments/new', type: 'dir' },
    ])
    expect(overlayChildren(o, '')).toEqual([{ name: 'src', path: 'src', type: 'dir' }])
    expect(overlayHasDir(o, 'src/payments/new')).toBe(true)
    expect(overlayHasDir(o, 'src/payments/a.ts')).toBe(false)
  })
  test('diffOverlay drops reverted edits and marks new files', async () => {
    const o = { version: 1 as const, files: { 'src/payments/a.ts': { content: 'same', mtime: 0 }, 'src/payments/b.ts': { content: 'new b', mtime: 0 }, 'src/payments/c.ts': { content: 'c', mtime: 0 } }, dirs: [] }
    const orig: Record<string, string> = { 'src/payments/a.ts': 'same', 'src/payments/b.ts': 'old b' }
    const ch = await diffOverlay(o, async (p) => orig[p] ?? null)
    expect(ch).toEqual([{ path: 'src/payments/b.ts', status: 'modified', content: 'new b' }, { path: 'src/payments/c.ts', status: 'added', content: 'c' }])
  })
  test('buildProposal refuses out-of-scope paths and empty sets', () => {
    expect(() => buildProposal(['src/payments'], [{ path: 'src/other/x.ts', status: 'added', content: '' }], 't', '')).toThrow(/outside the task scope: src\/other\/x.ts/)
    expect(() => buildProposal(['src/payments'], [], 't', '')).toThrow(/no changes/)
    expect(buildProposal(['src/payments'], [{ path: 'src/payments/a.ts', status: 'modified', content: 'x' }], ' Fix ', '')).toEqual({ title: 'Fix', files: [{ path: 'src/payments/a.ts', content: 'x' }] })
    expect(buildProposal(['src/payments'], [{ path: 'src/payments/a.ts', status: 'modified', content: 'x' }], 'Fix', ' why ').body).toBe('why')
  })
})

describe('formatting', () => {
  test('countdown', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(countdown('2026-01-01T02:05:00Z', now)).toBe('2h 5m left')
    expect(countdown('2026-01-01T00:04:30Z', now)).toBe('4m 30s left')
    expect(countdown('2025-12-31T00:00:00Z', now)).toBe('expired')
  })
  test('task label/description/tooltip', () => {
    const t = task()
    expect(taskLabel(t)).toBe('alice/web #7 Retry is broken')
    expect(taskDescription(t)).toMatch(/^contractor · 3h \dm left$/)
    expect(taskDescription(task({ status: 'revoked' }))).toBe('contractor · revoked')
    expect(taskTooltip(t)).toContain('  • src/payments')
    expect(isLive(t)).toBe(true)
    expect(isLive(task({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe(false)
  })
  test('escapeHtml', () => { expect(escapeHtml(`<img src=x onerror="a('b')">&\``)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;&#96;') })
  test('prUrl', () => { expect(prUrl('https://h.io/', 'a', 'b c', 3)).toBe('https://h.io/a/b%20c/pulls/3') })
  test('assignSummary', () => {
    const s = assignSummary({ owner: 'a', repo: 'r', issue: 4, login: 'bob', paths: ['src/x'], role: 'contractor', ttlMinutes: 480, model: '0gm-1.0', requestId: 'req-1' })
    expect(s).toContain('@bob a contractor session on a/r #4 for 8h'); expect(s).toContain('0gm-1.0'); expect(s).toContain('req-1'); expect(s).toContain('  src/x')
    expect(assignSummary({ owner: 'a', repo: 'r', issue: 4, login: 'bob', paths: ['x'], role: 'employee', ttlMinutes: 90 })).toContain('manually')
  })
  test('friendlyError', () => {
    expect(friendlyError({ status: 401, message: 'x', body: null })).toContain('Sign in')
    expect(friendlyError({ status: 422, message: 'patch touches files outside the session scope', body: { paths: ['a', 'b'] } })).toBe('rejected: patch touches files outside the session scope (paths: a, b)')
    expect(friendlyError({ status: 502, message: 'down', body: null }, 'Suggest')).toBe('Suggest: 0G or an upstream service is unavailable: down')
    expect(isDeadSessionError({ status: 403, message: 'invalid, expired or revoked session', body: null })).toBe(true)
    expect(isDeadSessionError({ status: 403, message: 'outside the scope of this session', body: null })).toBe(false)
  })
})

describe('response parsing (contract shapes)', () => {
  test('tasks', () => {
    const t = parseTasks({ tasks: [{ sessionId: SID, repo: { owner: 'a', name: 'r' }, issue: { number: 3, title: 'T', state: 'open' }, role: 'employee', allowedPaths: ['x'], ref: 'main', status: 'active', expiresAt: '2026-01-01T00:00:00Z', createdAt: '2025-12-31T00:00:00Z', createdBy: 'm' }] })
    expect(t[0]!.repo).toEqual({ owner: 'a', name: 'r' }); expect(t[0]!.status).toBe('active')
    expect(() => parseTasks({ tasks: [{ sessionId: 'nope' }] })).toThrow(ProtocolError)
    expect(() => parseTasks({})).toThrow(ProtocolError)
  })
  test('suggest-scope keeps only clean, unique paths', () => {
    const s = parseSuggestScope({ paths: [{ path: 'src/a.ts', kind: 'file', reason: 'r1' }, { path: 'src/dir/', kind: 'dir', reason: 'r2' }, { path: '../etc/passwd', kind: 'file', reason: 'x' }, { path: 'src/a.ts', kind: 'file', reason: 'dup' }], model: 'm', requestId: 'q', sealed: true, ref: 'main', considered: 40 })
    expect(s.paths).toEqual([{ path: 'src/a.ts', kind: 'file', reason: 'r1' }, { path: 'src/dir', kind: 'dir', reason: 'r2' }])
    expect([s.model, s.requestId, s.sealed, s.ref, s.considered]).toEqual(['m', 'q', true, 'main', 40])
  })
  test('repos, issues, tree, blob, assistant, calls, proposal', () => {
    expect(parseMyRepos({ repos: [{ owner: 'a', name: 'r', visibility: 'private', permission: 'admin', defaultBranch: 'main', repoId: '0x1' }] })[0]!.permission).toBe('admin')
    expect(parseIssues({ total: 1, issues: [{ number: 1, title: 't', state: 'open', author: 'a', assignees: ['b'], labels: [{ name: 'bug', color: 'f00' }] }] })[0]).toMatchObject({ assignees: ['b'], labels: ['bug'] })
    expect(parseTree({ entries: [{ type: 'tree', name: 'src', path: 'src', size: null }, { type: 'tree', name: 'x', path: 'x', restricted: true }] })[1]!.restricted).toBe(true)
    expect(parseBlob({ path: 'a', size: 3, binary: false, content: 'abc' }).content).toBe('abc')
    expect(parseBlob({ path: 'a', size: 9e6, truncated: true, content: null })).toMatchObject({ truncated: true, content: null })
    expect(parseAssistant({ callId: 5, refused: true, reason: 'out_of_scope', answer: 'no', requestId: null })).toMatchObject({ callId: '5', refused: true, reason: 'out_of_scope' })
    expect(parseCalls({ calls: [{ id: 1, kind: 'ask', refused: false, sealed: true, requestId: 'r', question: 'q', answer: 'a' }] })[0]).toMatchObject({ sealed: true, requestId: 'r' })
    expect(parseProposal({ branch: 'session/1-b', commit: '0xab', pullRequest: 9, files: 2 })).toEqual({ branch: 'session/1-b', commit: '0xab', pullRequest: 9, files: 2 })
  })
})

describe('webview html', () => {
  const evil = '<script>alert(1)</script>'
  test('chat panel: strict CSP with nonce, everything escaped', () => {
    const h = chatHtml(task({ issue: { number: 1, title: evil, state: 'open' }, allowedPaths: [evil] }), 'NONCE123')
    expect(h).toContain(`default-src 'none'`)
    expect(h).toContain(`script-src 'nonce-NONCE123'`)
    expect(h).not.toContain('<script>alert')
    expect(h.match(/<script/g)!.length).toBe(1)
    expect(h).toContain('<script nonce="NONCE123">')
    expect(h).not.toContain('innerHTML')
    expect(h).not.toMatch(/\beval\(/)
    expect(csp('n')).not.toContain('unsafe')
  })
  test('task view: no scripts at all, body escaped', () => {
    const h = taskHtml(task(), { number: 1, title: evil, body: `${evil}<img src=x onerror=alert(1)>`, state: 'open' }, 'N')
    expect(h).not.toContain('<script')
    expect(h).not.toContain('<img')
    expect(h).toContain('&lt;script&gt;')
  })
  test('message protocol validation', () => {
    expect(parseMsg({ type: 'ask', question: ' hi ' })).toEqual({ type: 'ask', question: 'hi' })
    expect(parseMsg({ type: 'ask', question: '' })).toBeNull()
    expect(parseMsg({ type: 'ask', question: 'x'.repeat(5000) })).toBeNull()
    expect(parseMsg({ type: 'exec', cmd: 'rm' })).toBeNull()
    expect(parseMsg('ready')).toBeNull()
    expect(parseMsg({ type: 'summarize' })).toEqual({ type: 'summarize' })
  })
})
