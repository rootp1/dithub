// Everything that shells out to git, plus remote-URL parsing and repo inference.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { DitError } from './errors.ts'
import { normalizeHost, storedHosts } from './config.ts'

export interface GitResult { code: number; out: string; err: string }

export function git(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer } = {}): GitResult {
  const r = spawnSync('git', args, {
    cwd: o.cwd, env: o.env ?? process.env, ...(o.input !== undefined ? { input: o.input } : {}),
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  })
  if (r.error) throw new DitError(`could not run git: ${(r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not installed or not on PATH' : r.error.message}`)
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/** Run git with the terminal attached (TTY intact) and return its exit code. */
export function gitInherit(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): number {
  const r = spawnSync('git', args, { cwd: o.cwd, env: o.env ?? process.env, stdio: 'inherit' })
  if (r.error) throw new DitError(`could not run git: ${(r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not installed or not on PATH' : r.error.message}`)
  if (r.status === null) return r.signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGPIPE: 13 } as Record<string, number>)[r.signal] ?? 1) : 1
  return r.status
}

export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Command that re-invokes this program (for the credential helper). */
export function selfCommand(): string[] {
  const main = (globalThis as { Bun?: { main?: string } }).Bun?.main ?? process.argv[1] ?? ''
  if (!main || main.startsWith('/$bunfs') || main.startsWith('B:/~BUN') || !existsSync(main)) return [process.execPath]
  return [process.execPath, main]
}

/** Value for credential.<url>.helper: `!dit credential` when `dit` is on PATH, else an absolute command. */
export function helperValue(): string {
  const onPath = (globalThis as { Bun?: { which(n: string): string | null } }).Bun?.which('dit')
  return onPath ? '!dit credential' : `!${selfCommand().map(shQuote).join(' ')} credential`
}

/** Environment that makes git ask `dit credential` for this origin. Contains no secret. */
export function withHelperEnv(origin: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  const n = Number(env.GIT_CONFIG_COUNT ?? '0') || 0
  const key = `credential.${origin}.helper`
  env.GIT_CONFIG_COUNT = String(n + 2)
  env[`GIT_CONFIG_KEY_${n}`] = key; env[`GIT_CONFIG_VALUE_${n}`] = ''          // reset: keep other helpers (keychain) from storing the token
  env[`GIT_CONFIG_KEY_${n + 1}`] = key; env[`GIT_CONFIG_VALUE_${n + 1}`] = helperValue()
  return env
}

/** Persist the helper in a repo's local config so plain `git push/pull` keep working. */
export function configureCredentialHelper(dir: string, origin: string): void {
  const key = `credential.${origin}.helper`
  const have = git(['config', '--local', '--get-all', key], { cwd: dir }).out.split('\n')
  if (have.includes(helperValue())) return
  git(['config', '--local', '--unset-all', key], { cwd: dir })
  git(['config', '--local', '--add', key, ''], { cwd: dir })
  git(['config', '--local', '--add', key, helperValue()], { cwd: dir })
}

// ---------- remote URL parsing ----------
export interface RepoRef { origin: string | null; owner: string; repo: string }
const NAME = /^[A-Za-z0-9._-]+$/
const clean = (s: string) => s.replace(/\.git$/, '')

/** Parse owner/repo, owner/repo@host, https://host/git/owner/repo(.git), https://host/owner/repo, git@host:owner/repo.git, ssh://git@host/owner/repo. */
export function parseRepoRef(input: string): RepoRef | null {
  const s = input.trim()
  if (!s) return null
  const at = /^([^/@:\s]+)\/([^/@:\s]+)@(.+)$/.exec(s)
  if (at) {
    const [, o, r, h] = at
    if (!NAME.test(o!) || !NAME.test(clean(r!))) return null
    try { return { origin: normalizeHost(h!), owner: o!, repo: clean(r!) } } catch { return null }
  }
  if (/^[^/@:\s]+\/[^/@:\s]+$/.test(s) && !s.includes('://')) {
    const [o, r] = s.split('/')
    return NAME.test(o!) && NAME.test(clean(r!)) ? { origin: null, owner: o!, repo: clean(r!) } : null
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(s)
  if (scp && !s.includes('://')) {
    const parts = clean(scp[2]!.replace(/^\/+/, '')).split('/').filter(Boolean)
    if (parts[0] === 'git') parts.shift()
    if (parts.length !== 2 || !NAME.test(parts[0]!) || !NAME.test(parts[1]!)) return null
    return { origin: null, owner: parts[0]!, repo: parts[1]! }
  }
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (!/^(https?|ssh|git):$/.test(u.protocol)) return null
  const parts = clean(u.pathname.replace(/^\/+|\/+$/g, '')).split('/').filter(Boolean)
  if (parts[0] === 'git') parts.shift()
  if (parts.length !== 2 || !NAME.test(parts[0]!) || !NAME.test(parts[1]!)) return null
  const origin = u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null   // userinfo is dropped
  return { origin, owner: parts[0]!, repo: parts[1]! }
}

export function toplevel(cwd = process.cwd()): string | null {
  const r = git(['rev-parse', '--show-toplevel'], { cwd })
  return r.code === 0 ? r.out.trim() : null
}
export const currentBranch = (cwd?: string): string | null => { const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd ? { cwd } : {}); return r.code === 0 ? r.out.trim() : null }
export const remoteUrl = (name = 'origin', cwd?: string): string | null => { const r = git(['remote', 'get-url', name], cwd ? { cwd } : {}); return r.code === 0 ? r.out.trim() : null }
export const hasRemote = (name = 'origin', cwd?: string) => remoteUrl(name, cwd) !== null

/** Infer the Dithub repo from `origin` (or the only/first remote). */
export function inferFromGit(cwd = process.cwd()): RepoRef | null {
  if (!existsSync(cwd) || !toplevel(cwd)) return null
  let url = remoteUrl('origin', cwd)
  if (!url) {
    const first = git(['remote'], { cwd }).out.split('\n').find(Boolean)
    url = first ? remoteUrl(first, cwd) : null
  }
  return url ? parseRepoRef(url) : null
}

/** Hosts we hold credentials for (used by the credential helper to decide whether to answer). */
export const knownOrigins = (): string[] => storedHosts()
