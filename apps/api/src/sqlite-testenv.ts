// Test-only: a throwaway SQLite file + repos dir for API route tests. Import this BEFORE any module that loads config.ts,
// and run API tests with `bun test --isolate apps/api` so every file gets its own module registry (config is read at import).
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'

const g = globalThis as { __dithubTestEnv?: { dir: string; ready?: Promise<void> } }
if (!g.__dithubTestEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'dithub-api-test-'))
  mkdirSync(join(dir, 'repos'))
  process.env.DATABASE_PATH = join(dir, 'dithub.sqlite')
  process.env.REPOS_DIR = join(dir, 'repos')
  process.env.SESSION_SECRET ??= randomBytes(32).toString('hex')
  g.__dithubTestEnv = { dir }
}
export const testDir = g.__dithubTestEnv.dir

/** Migrate the temp database once per process and return the db module. */
export async function setupDb() {
  const db = await import('./db.ts')
  const { config } = await import('./config.ts')
  if (config.databasePath !== process.env.DATABASE_PATH) throw new Error('config.ts was loaded before sqlite-testenv.ts (another test file shares this process); refusing to touch the real database. Run with `bun test --isolate`.')
  const { migrate } = await import('../../../packages/db/src/index.ts')
  g.__dithubTestEnv!.ready ??= migrate(db.sql, { log: () => {} })
  await g.__dithubTestEnv!.ready
  return db
}

let seq = 0
const uniq = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 39)

export async function createUser(prefix = 'u'): Promise<{ id: number; login: string; cookie: string }> {
  const { sql } = await setupDb()
  const { signSession } = await import('./session-token.ts')
  const { COOKIE } = await import('./auth.ts')
  const login = uniq(prefix)
  const [u] = await sql`INSERT INTO users (login) VALUES (${login}) RETURNING id, token_version`
  return { id: Number(u.id), login, cookie: `${COOKIE}=${signSession({ uid: Number(u.id), ver: Number(u.token_version) })}` }
}

const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: testDir }
export function run(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...gitEnv }, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/**
 * A user-owned public repo row plus a bare git repo with `main` (README.md, src/app.ts, docs/guide.md) and `feature`
 * (one more commit changing src/app.ts and adding src/new.ts).
 */
export async function createRepo(ownerId: number, name = uniq('r')): Promise<{ id: number; name: string; idHex: string }> {
  const { sql } = await setupDb()
  const { repoPath } = await import('./gitrepo.ts')
  const idBytes = randomBytes(32)
  const [r] = await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name) VALUES (${idBytes}, 'user', ${ownerId}, ${name}) RETURNING id`
  const idHex = `0x${idBytes.toString('hex')}`
  const bare = repoPath(idHex)
  run(testDir, ['init', '--bare', '-q', '-b', 'main', bare])
  const work = mkdtempSync(join(testDir, 'work-'))
  run(work, ['init', '-q', '-b', 'main'])
  await Bun.write(join(work, 'README.md'), '# demo\n')
  await Bun.write(join(work, 'src/app.ts'), 'export const a = 1\n')
  await Bun.write(join(work, 'docs/guide.md'), 'guide\n')
  run(work, ['add', '.']); run(work, ['commit', '-q', '-m', 'init'])
  run(work, ['checkout', '-q', '-b', 'feature'])
  await Bun.write(join(work, 'src/app.ts'), 'export const a = 2\n')
  await Bun.write(join(work, 'src/new.ts'), 'export const b = 1\n')
  run(work, ['add', '.']); run(work, ['commit', '-q', '-m', 'feature work'])
  run(work, ['push', '-q', bare, 'main', 'feature'])
  return { id: Number(r.id), name, idHex }
}

/** Call a Hono app with an optional session cookie and JSON body; returns status and parsed JSON (or text). */
export async function call(app: Hono, method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  const res = await app.request(path, init)
  const text = await res.text()
  let data: any = text
  try { data = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, data }
}
