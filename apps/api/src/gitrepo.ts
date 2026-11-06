import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config.ts'

export const repoPath = (repoIdHex: string) => join(config.reposDir, `${repoIdHex.replace(/^0x/, '')}.git`)

export async function git(dir: string, args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], {
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

export function deriveRepoId(owner: string, name: string): string {
  return `0x${createHash('sha256').update(`dheet:repo:v1:${owner}:${name}:${crypto.randomUUID()}`).digest('hex')}`
}

export async function initBare(repoIdHex: string, defaultBranch: string): Promise<string> {
  const dir = repoPath(repoIdHex)
  mkdirSync(dir, { recursive: true })
  const init = await git(dir, ['init', '--bare', `--initial-branch=${defaultBranch}`])
  if (init.code !== 0) throw new Error(`git init failed: ${init.err}`)
  for (const [k, v] of [['http.receivepack', 'true'], ['receive.denyDeleteCurrent', 'warn'], ['core.logAllRefUpdates', 'false']]) {
    await git(dir, ['config', k as string, v as string])
  }
  installHooks(dir)
  return dir
}

export function installHooks(dir: string): void {
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  for (const hook of ['pre-receive', 'post-receive']) {
    const source = readFileSync(join(config.hooksDir, hook), 'utf8')
    const target = join(dir, 'hooks', hook)
    if (existsSync(target) && readFileSync(target, 'utf8') === source) continue
    writeFileSync(target, source)
    chmodSync(target, 0o755)
  }
}

export interface ParsedCommit {
  oid: string; tree: string; parents: string[]; authorName: string; authorEmail: string
  authoredAt: number; committedAt: number; subject: string; message: string
}

const SEP = '\u001e', FIELD = '\u001f'
export async function listCommits(dir: string, range: string[], max = 200): Promise<ParsedCommit[]> {
  const fmt = ['%H', '%T', '%P', '%an', '%ae', '%at', '%ct', '%s', '%B'].join(FIELD) + SEP
  const res = await git(dir, ['log', `--max-count=${max}`, `--format=${fmt}`, ...range, '--'])
  if (res.code !== 0) return []
  return res.out.split(SEP).map((s) => s.replace(/^\n/, '')).filter(Boolean).map((chunk) => {
    const [oid, tree, parents, an, ae, at, ct, subject, ...rest] = chunk.split(FIELD)
    return {
      oid: oid!, tree: tree!, parents: parents ? parents.split(' ').filter(Boolean) : [],
      authorName: an ?? '', authorEmail: ae ?? '', authoredAt: Number(at), committedAt: Number(ct),
      subject: subject ?? '', message: rest.join(FIELD).trim(),
    }
  })
}

export const ZERO_OID = /^0+$/
export const safeRef = (ref: string) => /^[A-Za-z0-9._\-/]{1,200}$/.test(ref) && !ref.includes('..') && !ref.startsWith('-')
export const safePath = (path: string) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').some((p) => p === '..')
export { existsSync }

/** Bridge an HTTP request to `git http-backend` (CGI). */
export async function runHttpBackend(args: {
  repoIdHex: string; pathInfo: string; method: string; query: string; headers: Headers
  body: ReadableStream<Uint8Array> | null; remoteUser: string | null; extraEnv: Record<string, string>
}): Promise<Response> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1',
    GIT_PROJECT_ROOT: config.reposDir, GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${args.repoIdHex.replace(/^0x/, '')}.git${args.pathInfo}`,
    REQUEST_METHOD: args.method, QUERY_STRING: args.query,
    CONTENT_TYPE: args.headers.get('content-type') ?? '',
    REMOTE_ADDR: '127.0.0.1', ...args.extraEnv,
  }
  const enc = args.headers.get('content-encoding')
  if (enc) env.HTTP_CONTENT_ENCODING = enc
  const len = args.headers.get('content-length')
  if (len) env.CONTENT_LENGTH = len
  if (args.remoteUser) env.REMOTE_USER = args.remoteUser
  const proc = Bun.spawn(['git', 'http-backend'], {
    stdin: args.body ?? 'ignore', stdout: 'pipe', stderr: 'pipe', env,
  })
  const reader = proc.stdout.getReader()
  let buffer = new Uint8Array(0)
  let headerEnd = -1
  while (headerEnd < 0) {
    const { done, value } = await reader.read()
    if (done) break
    const merged = new Uint8Array(buffer.length + value.length)
    merged.set(buffer); merged.set(value, buffer.length); buffer = merged
    headerEnd = Buffer.from(buffer).indexOf('\r\n\r\n')
  }
  if (headerEnd < 0) return new Response(`git http-backend failed: ${await new Response(proc.stderr).text()}`, { status: 502 })
  const headText = Buffer.from(buffer.slice(0, headerEnd)).toString()
  const headers = new Headers()
  let status = 200
  for (const line of headText.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const name = line.slice(0, idx).trim(), value = line.slice(idx + 1).trim()
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
    else headers.set(name, value)
  }
  const first = buffer.slice(headerEnd + 4)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (first.length) controller.enqueue(first)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        controller.enqueue(value)
      }
      controller.close()
    },
  })
  return new Response(stream, { status, headers })
}
