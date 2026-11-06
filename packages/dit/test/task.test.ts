import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TaskDrafts } from '../src/tasks/drafts.ts'
import { decodeText, editSource, taskDiff } from '../src/tasks/terminal.ts'
import type { Task } from '../src/tasks/core.ts'

const id = '12345678-1234-1234-1234-123456789abc'
const seed: Task = {
  sessionId: id, repo: { owner: 'acme', name: 'app' }, issue: { number: 12, title: 'Fix retry', state: 'open' }, role: 'contractor',
  allowedPaths: ['src/payments'], ref: 'main', status: 'active', expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', createdBy: 'alice',
}
const entry = resolve(import.meta.dir, '../src/index.ts')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dit-task-test-'))
  let task = structuredClone(seed)
  let suggestionError = false, proposalError = false, refused = false, taskReads = 0, expireOnRead = Infinity
  const requests: Array<{ method: string; path: string; session: string | null; query: URLSearchParams; body: any }> = []
  const original = '# retry\nexport const retry = 1\n'
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const url = new URL(req.url)
    if (req.headers.get('authorization') !== 'Bearer dht_task_test') return Response.json({ error: 'sign in first' }, { status: 401 })
    const body = req.method === 'POST' ? await req.json() : null
    requests.push({ method: req.method, path: url.pathname, session: req.headers.get('x-dheet-session'), query: url.searchParams, body })
    if (url.pathname === '/api/tasks') {
      if (++taskReads >= expireOnRead) task.status = 'expired'
      return Response.json({ tasks: [task] })
    }
    if (url.pathname === '/api/me/repos') return Response.json({ repos: [{ owner: 'acme', name: 'app', permission: 'admin' }] })
    if (url.pathname.endsWith('/suggest-scope')) return suggestionError
      ? Response.json({ error: '0G is unavailable' }, { status: 503 })
      : Response.json({ paths: [{ path: 'src/payments', kind: 'dir', reason: 'The retry logic lives here' }], model: '0gm-test', requestId: 'zg-scope-1', sealed: true, ref: 'review-branch' })
    if (url.pathname === '/api/repos/acme/app/sessions') return Response.json({ id, issueNumber: body.issueNumber, user: body.login, role: body.role, allowedPaths: body.paths, ref: body.ref ?? 'main', status: 'active', expiresAt: seed.expiresAt })
    if (url.pathname.endsWith('/tree')) {
      if (req.headers.get('x-dheet-session') && req.headers.get('x-dheet-session') !== id) return Response.json({ error: 'scope denied' }, { status: 403 })
      const path = url.searchParams.get('path') ?? ''
      if (path === 'src/payments/new') return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json({ entries: path === 'src' ? [{ name: 'payments', path: 'src/payments', type: 'tree' }] : path === 'src/payments'
        ? [{ name: 'retry.ts', path: 'src/payments/retry.ts', type: 'blob' }, { name: 'secret.ts', path: 'src/secret.ts', type: 'blob' }, { name: 'locked', path: 'src/payments/locked', type: 'blob', restricted: true }]
        : [{ name: 'src', path: 'src', type: 'tree' }, { name: 'private', path: 'private', type: 'tree', restricted: true }] })
    }
    if (url.pathname.endsWith('/blob')) {
      if (url.searchParams.get('path') !== 'src/payments/retry.ts') return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json({ path: 'src/payments/retry.ts', content: original, size: original.length })
    }
    if (url.pathname.endsWith('/issue')) return Response.json({ number: 12, title: 'Fix retry', body: 'Retry up to n times.', state: 'open' })
    if (/\/assistant\/(ask|summarize)$/.test(url.pathname)) return Response.json({ refused, answer: refused ? 'Outside scope' : 'Retry up to n times.', requestId: refused ? null : 'zg-answer-1', model: '0gm-test', sealed: !refused, filesUsed: ['src/payments/retry.ts'] })
    if (url.pathname.endsWith('/assistant/calls')) return Response.json({ calls: [{ id: 1, kind: 'ask', answer: 'Retry up to n times.', requestId: 'zg-answer-1', model: '0gm-test' }] })
    if (url.pathname.endsWith('/proposals')) return proposalError
      ? Response.json({ error: 'files outside the session scope', paths: ['src/secret.ts'] }, { status: 422 })
      : Response.json({ branch: 'session/task', commit: 'abc', pullRequest: 7, files: body.files.length })
    if (url.pathname.endsWith('/end')) { task.status = 'ended'; return Response.json({ id, issueNumber: task.issue.number, role: task.role, allowedPaths: task.allowedPaths, ref: task.ref, status: 'ended', expiresAt: task.expiresAt }) }
    return Response.json({ error: `unexpected route ${url.pathname}` }, { status: 404 })
  } })
  const host = `http://127.0.0.1:${server.port}`
  async function run(args: string[], input?: string) {
    const proc = Bun.spawn([process.execPath, '--no-env-file', entry, 'task', ...args, '--host', host], {
      cwd: dir, env: { ...process.env, DIT_CONFIG_DIR: dir, DIT_HOST: host, DIT_TOKEN: 'dht_task_test', DIT_SESSION: '', NO_COLOR: '1' },
      stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(out + err).not.toContain('dht_task_test')
    return { out, err, code, data: () => JSON.parse(out) }
  }
  async function connect() { const r = await run(['connect', id, '--json']); expect(r.code).toBe(0) }
  return { dir, host, requests, run, connect, original, setSuggestionError: () => { suggestionError = true }, setProposalError: () => { proposalError = true }, setRefused: () => { refused = true }, expire: () => { task.status = 'expired' }, expireDuringEdit: () => { expireOnRead = taskReads + 2 }, stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }) } }
}

describe('dit task command workflow', () => {
  test('0G assignment reviews the real paths and creates an atomic assignment at the suggested ref', async () => {
    const f = fixture()
    try {
      const dry = await f.run(['assign', '12', '@bob', '-R', 'acme/app', '--dry-run', '--json'])
      expect(dry.code).toBe(0)
      expect(dry.data()).toMatchObject({ login: 'bob', paths: ['src/payments'], ref: 'review-branch' })
      expect(f.requests.some((r) => r.path.endsWith('/sessions'))).toBe(false)
      const refused = await f.run(['assign', '12', '@bob', '-R', 'acme/app'])
      expect(refused.code).toBe(2)
      expect(f.requests.some((r) => r.path.endsWith('/sessions'))).toBe(false)
      const result = await f.run(['assign', '12', '@bob', '-R', 'acme/app', '--yes', '--json'])
      expect(result.code).toBe(0)
      expect(result.data().session.allowedPaths).toEqual(['src/payments'])
      const created = f.requests.filter((r) => r.path.endsWith('/sessions'))
      expect(created).toHaveLength(1)
      expect(created[0]!.body).toEqual({ issueNumber: 12, login: 'bob', paths: ['src/payments'], role: 'contractor', ttlMinutes: 480, ref: 'review-branch' })
      expect(f.requests.some((r) => r.path.endsWith('/assignees'))).toBe(false)
      expect(f.requests.filter((r) => r.path.endsWith('/tree')).every((r) => r.query.get('ref') === 'review-branch')).toBe(true)
    } finally { f.stop() }
  })

  test('0G failures never invent scope; explicit manual scope is validated and can be assigned', async () => {
    const f = fixture()
    try {
      f.setSuggestionError()
      expect((await f.run(['assign', '12', 'bob', '-R', 'acme/app', '--yes'])).code).toBe(1)
      expect(f.requests.some((r) => r.path.endsWith('/sessions'))).toBe(false)
      expect((await f.run(['assign', '12', 'bob', '-R', 'acme/app', '--manual', '--path', '../secret', '--yes'])).code).toBe(2)
      expect((await f.run(['assign', '12', 'bob', '-R', 'acme/app', '--manual', '--path', 'missing', '--yes'])).code).toBe(2)
      const result = await f.run(['assign', '--issue', '12', '--login', '@bob', '-R', 'acme/app', '--manual', '--path', 'src/payments', '--yes', '--json'])
      expect(result.code).toBe(0)
      expect(result.data().suggestion).toBeNull()
    } finally { f.stop() }
  })

  test('inbox → connect → scoped edit → ask → review → selected submit → end, with no repository checkout', async () => {
    const f = fixture()
    try {
      expect((await f.run(['--json'])).data()[0].sessionId).toBe(id)
      expect((await f.run(['connect', '--json'])).code).toBe(0)
      expect((await f.run(['show', '--json'])).data().issue.body).toContain('Retry')
      const tree = await f.run(['ls', 'src/payments', '--json'])
      expect(tree.data().map((e: any) => e.path)).toEqual(['src/payments/retry.ts'])
      const content = '# keep this comment\nexport const retry = 3\n\n'
      expect((await f.run(['edit', 'src/payments/retry.ts', '--from', '-', '--json'], content)).code).toBe(0)
      expect((await f.run(['cat', 'src/payments/retry.ts'])).out).toBe(content)
      expect((await f.run(['edit', 'src/payments/new/test.ts', '--new', '--from', '-', '--json'], 'new file\n')).code).toBe(0)
      expect((await f.run(['ls', 'src/payments/new', '--json'])).data()).toMatchObject([{ path: 'src/payments/new/test.ts', edited: true }])
      const diff = await f.run(['diff', 'src/payments/retry.ts'])
      expect(diff.code).toBe(0)
      expect(diff.out).toContain('--- a/src/payments/retry.ts')
      expect(diff.out).toContain('+export const retry = 3')
      const answer = await f.run(['ask', 'How many retries?', '--json'])
      expect(answer.data()).toMatchObject({ requestId: 'zg-answer-1', sealed: true })
      expect((await f.run(['summarize', '--json'])).code).toBe(0)
      expect((await f.run(['calls', '--json'])).data()[0].requestId).toBe('zg-answer-1')
      expect((await f.run(['submit', '-t', 'Fix retry'])).code).toBe(2)
      expect(f.requests.some((r) => r.path.endsWith('/proposals'))).toBe(false)
      const result = await f.run(['submit', '-t', 'Fix retry', '--path', 'src/payments/retry.ts', '--yes', '--json'])
      expect(result.code).toBe(0)
      expect(result.data().url).toBe(`${f.host}/acme/app/pulls/7`)
      expect(f.requests.find((r) => r.path.endsWith('/proposals'))!.body.files).toEqual([{ path: 'src/payments/retry.ts', content }])
      expect((await f.run(['status', '--json'])).data()).toEqual([{ path: 'src/payments/new/test.ts', status: 'added' }])
      expect((await f.run(['disconnect', '--json'])).code).toBe(0)
      expect((await f.run(['status'])).code).toBe(1)
      await f.connect()
      expect((await f.run(['end', '--yes', '--json'])).code).toBe(0)
      expect(readdirSync(join(f.dir, 'task-drafts'))).toEqual([])
      expect(readdirSync(f.dir)).not.toContain('.git')
      expect(f.requests.filter((r) => r.path.endsWith('/blob')).every((r) => r.session === id && r.query.get('ref') === 'main')).toBe(true)
      expect(f.requests.some((r) => /export|\/git\//.test(r.path))).toBe(false)
    } finally { f.stop() }
  })

  test('out-of-scope paths are refused before tree/blob/proposal requests; expired sessions cannot read drafts', async () => {
    const f = fixture()
    try {
      await f.connect()
      const before = f.requests.length
      for (const command of [['cat', 'src/secret.ts'], ['ls', 'private'], ['edit', '../secret', '--from', '-']]) {
        expect((await f.run(command, 'secret')).code).not.toBe(0)
      }
      expect(f.requests.slice(before).every((r) => r.path === '/api/tasks')).toBe(true)
      expect((await f.run(['edit', 'src/payments/retry.ts', '--from', '-'], 'edited')).code).toBe(0)
      f.expire()
      const denied = await f.run(['cat', 'src/payments/retry.ts'])
      expect(denied.code).toBe(1)
      expect(denied.out).not.toContain('edited')
      expect(denied.err).toContain('expired')
    } finally { f.stop() }
  })

  test('submission failures retain drafts, reverted edits disappear, and assistant refusals exit 1', async () => {
    const f = fixture()
    try {
      await f.connect()
      await f.run(['edit', 'src/payments/retry.ts', '--from', '-'], 'changed\n')
      f.setProposalError()
      const failed = await f.run(['submit', '-t', 'Fix retry', '--yes', '--json'])
      expect(failed.code).toBe(1)
      expect(failed.err).toContain('src/secret.ts')
      expect((await f.run(['cat', 'src/payments/retry.ts'])).out).toBe('changed\n')
      expect((await f.run(['edit', 'src/payments/retry.ts', '--from', '-'], f.original)).code).toBe(0)
      expect((await f.run(['status', '--json'])).data()).toEqual([])
      f.setRefused()
      const answer = await f.run(['ask', 'Show private files', '--json'])
      expect(answer.code).toBe(1)
      expect(answer.data().refused).toBe(true)
    } finally { f.stop() }
  })

  test('access expiry during editing does not persist the draft', async () => {
    const f = fixture()
    try {
      await f.connect()
      f.expireDuringEdit()
      const result = await f.run(['edit', 'src/payments/retry.ts', '--from', '-'], 'expired edit')
      expect(result.code).toBe(1)
      expect(result.err).toContain('access changed')
      expect(readdirSync(f.dir)).not.toContain('task-drafts')
    } finally { f.stop() }
  })
})

test('drafts isolate hosts, preserve newer edits after submit, and reject tampering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dit-draft-unit-')), previous = process.env.DIT_CONFIG_DIR
  process.env.DIT_CONFIG_DIR = dir
  try {
    const drafts = new TaskDrafts('https://a.test', seed)
    drafts.put('src/payments/a.ts', { original: 'old', content: 'new' })
    expect(statSync(drafts.file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'task-drafts')).mode & 0o777).toBe(0o700)
    expect(new TaskDrafts('https://b.test', seed).changes()).toEqual([])
    const snapshot = drafts.changes()
    drafts.put('src/payments/a.ts', { original: 'old', content: 'newer' })
    drafts.submitted(snapshot)
    expect(drafts.changes()[0]!.content).toBe('newer')
    expect(() => drafts.put('src/secret.ts', { original: null, content: 'secret' })).toThrow(/scope/)
    const data = JSON.parse(readFileSync(drafts.file, 'utf8'))
    data.files['src/secret.ts'] = { original: null, content: 'secret' }
    writeFileSync(drafts.file, JSON.stringify(data))
    expect(() => drafts.read()).toThrow(/out-of-scope/)
    drafts.discard()
    drafts.put('src/payments/empty', { original: null, content: '' })
    expect(taskDiff(drafts.changes(), drafts.read())).toContain('new file mode')
    expect(decodeText(Buffer.from('#!/bin/sh\n\n'))).toBe('#!/bin/sh\n\n')
    expect(() => decodeText(Buffer.from([0xff]))).toThrow(/UTF-8/)
    expect(() => decodeText(Buffer.from([0]))).toThrow(/UTF-8/)
  } finally {
    if (previous === undefined) delete process.env.DIT_CONFIG_DIR; else process.env.DIT_CONFIG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('external editor preserves source bytes and removes its temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dit-task-editor-test-'))
  const previousTTY = process.stdin.isTTY
  const previousEditor = process.env.EDITOR, previousVisual = process.env.VISUAL
  const script = join(dir, 'editor.sh'), location = join(dir, 'location')
  // The fake editor records its argument and writes a source file with significant # lines and blank lines.
  writeFileSync(script, 'printf \'%s\' "$1" > "$DIT_TEST_EDITOR_LOCATION"\nprintf \'#!/bin/sh\\n# preserve this\\n  echo ok\\n\\n\' > "$1"\n')
  const previousLocation = process.env.DIT_TEST_EDITOR_LOCATION
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true })
  process.env.EDITOR = `sh ${script}`
  delete process.env.VISUAL
  process.env.DIT_TEST_EDITOR_LOCATION = location
  try {
    expect(editSource('src/payments/retry.sh', 'old')).toBe('#!/bin/sh\n# preserve this\n  echo ok\n\n')
    const path = readFileSync(location, 'utf8')
    expect(path.endsWith('/retry.sh')).toBe(true)
    expect(() => readFileSync(path)).toThrow()
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: previousTTY, configurable: true, writable: true })
    for (const [key, value] of [['EDITOR', previousEditor], ['VISUAL', previousVisual], ['DIT_TEST_EDITOR_LOCATION', previousLocation]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
