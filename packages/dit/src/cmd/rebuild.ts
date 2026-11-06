// `dit verify rebuild`: prove that the on-chain release equals a fresh build of the public source at that commit.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { flag, parse, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { SEL, SOURCE_REPO, l1, needRegistry } from '../constants.ts'
import { c, info, printJson } from '../ui.ts'
import { bundleHashOf, report, rpc, sha256, type Row } from './verify.ts'

const FETCH_TIMEOUT = 5 * 60_000, BUILD_TIMEOUT = 10 * 60_000, MAX_DIST_BYTES = 50 * 1024 * 1024, MAX_LOG = 4000

// ---------- pure helpers ----------
/** bytes32 with the 20-byte git sha right-aligned -> 40 hex chars. */
export function decodeCommit(b32: string): string {
  const h = b32.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{64}$/.test(h)) throw new DitError(`release commit field is not a bytes32: ${b32}`)
  if (!/^0{24}$/.test(h.slice(0, 24))) throw new DitError(`release commit field is not a right-aligned 20-byte git sha: 0x${h}`)
  return h.slice(24)
}

export interface RebuildOpts { release?: number; commit?: string; source: string; site?: string; sandbox: 'auto' | 'docker' | 'none'; unsafeLocalBuild: boolean; json: boolean }

export function parseRebuildArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RebuildOpts {
  const p = parse(argv, { release: { type: 'string' }, commit: { type: 'string' }, source: { type: 'string' }, site: { type: 'string' }, sandbox: { type: 'string' }, 'unsafe-local-build': { type: 'boolean' } }, { allowPositionals: false })
  const rel = str(p.values.release), commit = str(p.values.commit)
  if (rel !== undefined && commit !== undefined) throw new UsageError('use either --release or --commit, not both')
  if (rel !== undefined && !/^[1-9]\d*$/.test(rel)) throw new UsageError('--release must be a positive integer')
  if (commit !== undefined && !/^[0-9a-fA-F]{40}$/.test(commit)) throw new UsageError('--commit must be a full 40-hex git sha')
  const sandbox = (str(p.values.sandbox) ?? 'auto') as RebuildOpts['sandbox']
  if (!['auto', 'docker', 'none'].includes(sandbox)) throw new UsageError('--sandbox must be auto, docker or none')
  const unsafe = flag(p.values['unsafe-local-build'])
  if (sandbox === 'none' && !unsafe) throw new UsageError('--sandbox none runs the repository\'s build script on this machine and needs --unsafe-local-build', 'Pass both `--sandbox none --unsafe-local-build` to confirm.')
  if (unsafe && sandbox === 'docker') throw new UsageError('--unsafe-local-build only applies with --sandbox none (or auto)')
  return {
    ...(rel !== undefined ? { release: Number(rel) } : {}), ...(commit !== undefined ? { commit: commit.toLowerCase() } : {}),
    source: str(p.values.source) ?? env.DIT_SOURCE_REPO ?? SOURCE_REPO, ...(str(p.values.site) ? { site: str(p.values.site)!.replace(/\/$/, '') } : {}),
    sandbox, unsafeLocalBuild: unsafe, json: flag(p.values.json),
  }
}

/** Decide where the build runs. Never silently falls back to the local machine. */
export function chooseSandbox(o: { sandbox: RebuildOpts['sandbox']; unsafeLocalBuild: boolean; dockerAvailable: boolean }): 'docker' | 'none' {
  if (o.sandbox === 'none') {
    if (!o.unsafeLocalBuild) throw new UsageError('--sandbox none needs --unsafe-local-build as well')
    return 'none'
  }
  if (o.dockerAvailable) return 'docker'
  if (o.sandbox === 'docker') throw new DitError('--sandbox docker was requested but Docker is not available')
  throw new DitError('Docker is not available, and building untrusted code on this machine needs explicit consent: refusing.', 1,
    'Install/start Docker, or pass both `--sandbox none --unsafe-local-build` to build with your local bun in an empty-environment child process.')
}

/** The only environment a local build child gets: no inherited secrets. */
export function emptyBuildEnv(sha: string, home: string, pathVar: string | undefined = process.env.PATH): Record<string, string> {
  return { PATH: pathVar ?? '/usr/bin:/bin', HOME: home, GIT_COMMIT: sha }
}

export type Hasher = (bytes: Uint8Array) => string
/** Re-hash every top-level file of a built dist directory (build.json excluded), exactly as apps/web/build.ts does. */
export function rehashDist(dir: string, hash: Hasher = sha256): { files: Record<string, string>; bundleHash: string } {
  const files: Record<string, string> = {}
  let total = 0
  for (const name of readdirSync(dir).filter((f) => f !== 'build.json').sort()) {
    const full = join(dir, name), st = lstatSync(full)
    if (!st.isFile()) throw new DitError(`build output contains a non-file entry: ${name}`)
    total += st.size
    if (total > MAX_DIST_BYTES) throw new DitError('build output is unreasonably large; refusing')
    files[name] = hash(readFileSync(full))
  }
  if (!Object.keys(files).length) throw new DitError('build produced no files')
  return { files, bundleHash: bundleHashOf(files) }
}

export interface FileDiff { name: string; rebuilt: string | null; other: string | null }
export function diffFiles(rebuilt: Record<string, string>, other: Record<string, string>): FileDiff[] {
  const names = [...new Set([...Object.keys(rebuilt), ...Object.keys(other)])].sort()
  return names.filter((n) => (rebuilt[n] ?? null)?.toLowerCase() !== (other[n] ?? null)?.toLowerCase()).map((n) => ({ name: n, rebuilt: rebuilt[n] ?? null, other: other[n] ?? null }))
}

export const pinnedBunVersion = (ciYaml: string): string | null => /bun-version:\s*['"]?(\d+\.\d+\.\d+)['"]?/.exec(ciYaml)?.[1] ?? null

// ---------- chain ----------
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0')
async function rpcRetry<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown
  for (let i = 0; i < 5; i++) {
    try { return await rpc<T>(method, params) } catch (e) { last = e; await new Promise((r) => setTimeout(r, 700 * 2 ** i)) }
  }
  throw new DitError(`${l1().label} RPC failed: ${(last as Error)?.message ?? last}`)
}
const call = (data: string) => rpcRetry<string>('eth_call', [{ to: needRegistry(), data }, 'latest'])

export interface ChainRelease { id: number; commit: string; bundleHash: string; url: string; publishedAt: number; publisher: string }
export function decodeGetRelease(id: number, data: string): ChainRelease {
  const h = data.replace(/^0x/, '')
  const w = (i: number) => h.slice(i * 64, i * 64 + 64)
  if (h.length < 64 * 6) throw new Error('malformed getRelease data')
  const off = Number(BigInt('0x' + w(2))) / 32, len = Number(BigInt('0x' + w(off)))
  if ((off + 1) * 64 + len * 2 > h.length) throw new Error('ABI string out of range')
  return { id, commit: '0x' + w(0), bundleHash: '0x' + w(1), url: Buffer.from(h.slice((off + 1) * 64, (off + 1) * 64 + len * 2), 'hex').toString('utf8'), publishedAt: Number(BigInt('0x' + w(3))), publisher: '0x' + w(4).slice(24) }
}
export async function releaseCount(): Promise<number> { return Number(BigInt(await call(SEL.selReleaseCount))) }
export async function getRelease(id: number): Promise<ChainRelease> { return decodeGetRelease(id, await call(SEL.selGetRelease + word(id))) }

async function findRelease(o: RebuildOpts): Promise<ChainRelease> {
  const count = await releaseCount()
  if (count === 0) throw new DitError('no release has been published on-chain yet')
  if (o.release !== undefined) {
    if (o.release > count) throw new DitError(`release ${o.release} does not exist (latest is ${count})`)
    return getRelease(o.release)
  }
  if (!o.commit) return getRelease(count)
  for (let id = count; id >= 1; id--) {
    const r = await getRelease(id)
    try { if (decodeCommit(r.commit) === o.commit) return r } catch { /* legacy release without a git sha */ }
  }
  throw new DitError(`no on-chain release was built from commit ${o.commit}`, 1, `Searched ${count} release(s) newest first.`)
}

// ---------- source + build ----------
function run(cmd: string, args: string[], o: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; timeout: number }) {
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: o.env, encoding: 'utf8', timeout: o.timeout, maxBuffer: 20 * 1024 * 1024 })
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? ''), timedOut: r.error?.message.includes('ETIMEDOUT') ?? false }
}
const tail = (s: string) => (s.length > MAX_LOG ? '...' + s.slice(-MAX_LOG) : s).trim()

export function tmpBase(): string {
  const b = process.env.DIT_TMPDIR ?? (process.platform === 'darwin' ? join(homedir(), '.cache', 'dit-tmp') : tmpdir())
  mkdirSync(b, { recursive: true, mode: 0o700 })
  return b
}

function fetchSource(source: string, sha: string, dir: string, home: string): void {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'core.fsmonitor=false']
  const g = (args: string[], cwd?: string) => run('git', [...safe, ...args], { cwd, env, timeout: FETCH_TIMEOUT })
  const local = existsSync(source)
  if (local) {
    const r = g(['clone', '--quiet', '--no-checkout', '--no-hardlinks', resolve(source), dir])
    if (r.code !== 0) throw new DitError(`could not clone local source: ${tail(r.out)}`)
  } else {
    mkdirSync(dir, { recursive: true })
    g(['init', '--quiet'], dir)
    g(['remote', 'add', 'origin', source], dir)
    let r = g(['fetch', '--quiet', '--depth', '1', 'origin', sha], dir)
    if (r.code !== 0) {
      r = g(['fetch', '--quiet', 'origin'], dir)           // server refuses by-sha shallow fetch: fall back to a full fetch
      if (r.code !== 0) throw new DitError(`could not fetch ${source}: ${tail(r.out)}`)
    }
  }
  const co = g(['checkout', '--quiet', '--detach', sha], dir)
  if (co.code !== 0) throw new DitError(`commit ${sha} is not available in ${source}`, 1, tail(co.out))
  const head = g(['rev-parse', 'HEAD'], dir).out.trim()
  if (head !== sha) throw new DitError(`checked out ${head}, expected ${sha}`)
}

const dockerAvailable = () => run('docker', ['info'], { timeout: 20_000, env: process.env }).code === 0

interface BuildResult { sandbox: 'docker' | 'none'; bun: string; dist: string; log: string }

// ---------- orchestration ----------
export interface Deps {
  rehash?: (dir: string) => { files: Record<string, string>; bundleHash: string }
  fetchLive?: (site: string) => Promise<{ files: Record<string, string>; bundleHash: string }>
  dockerAvailable?: () => boolean
}

export async function fetchLive(site: string): Promise<{ files: Record<string, string>; bundleHash: string }> {
  const res = await fetch(`${site}/build.json`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`/build.json HTTP ${res.status}`)
  const build = JSON.parse(await res.text()) as { files: Record<string, string> }
  const files: Record<string, string> = {}
  for (const name of Object.keys(build.files).sort()) {
    if (/[\\/]|^\.\.?$/.test(name)) throw new Error(`unsafe file name in build.json: ${name}`)
    const r = await fetch(`${site}/${name}`, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`/${name} HTTP ${r.status}`)
    files[name] = sha256(new Uint8Array(await r.arrayBuffer()))
  }
  return { files, bundleHash: bundleHashOf(files) }
}

export async function rebuild(o: RebuildOpts, deps: Deps = {}): Promise<{ ok: boolean; rows: Row[]; data: Record<string, unknown> }> {
  const rows: Row[] = []
  const add = (check: string, status: Row['status'], detail: string) => rows.push({ check, status, detail })
  const data: Record<string, unknown> = {}
  const rehash = deps.rehash ?? ((d: string) => rehashDist(d))
  const sandbox = chooseSandbox({ sandbox: o.sandbox, unsafeLocalBuild: o.unsafeLocalBuild, dockerAvailable: o.sandbox === 'none' ? false : (deps.dockerAvailable ?? dockerAvailable)() })

  const rel = await findRelease(o)
  const sha = decodeCommit(rel.commit)
  const latest = await releaseCount()
  add('release found', 'PASS', `#${rel.id} commit ${sha.slice(0, 12)} published ${new Date(rel.publishedAt * 1000).toISOString()} (${rel.url})`)
  Object.assign(data, { release: rel.id, commit: sha, publishedAt: rel.publishedAt, onchainBundleHash: rel.bundleHash, sandbox })

  const base = mkdtempSync(join(tmpBase(), 'rebuild-'))
  try {
    const home = join(base, 'home'), src = join(base, 'src'), out = join(base, 'out')
    mkdirSync(home); mkdirSync(out, { mode: 0o777 })
    fetchSource(o.source, sha, src, home)
    add('commit fetched and checked out', 'PASS', `${sha} from ${existsSync(o.source) ? o.source : o.source.replace(/\/\/[^@/]*@/, '//')}`)

    // toolchain: the bun version CI pins at that commit
    let pinned: string | null = null
    try { pinned = pinnedBunVersion(readFileSync(join(src, '.github/workflows/ci.yml'), 'utf8')) } catch { /* no ci.yml */ }
    const localBun = Bun.version
    const bunVersion = pinned ?? localBun
    if (!pinned) add('pinned bun version', 'WARN', `no bun-version in .github/workflows/ci.yml; using local bun ${localBun}`)
    else if (sandbox === 'none' && pinned !== localBun) add('pinned bun version', 'WARN', `CI pins ${pinned} but local bun is ${localBun}; output may differ`)

    let dist: string, log = ''
    if (sandbox === 'docker') {
      const r = run('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--pids-limit', '512',
        '-v', `${src}:/src:ro`, '-v', `${out}:/out`, '-e', `GIT_COMMIT=${sha}`, `oven/bun:${bunVersion}`,
        'sh', '-c', 'set -e; mkdir /tmp/w; cp -R /src/. /tmp/w; cd /tmp/w; bun apps/web/build.ts; cp apps/web/dist/* /out/'], { timeout: BUILD_TIMEOUT, env: process.env })
      log = tail(r.out)
      if (r.code !== 0) throw new DitError(`docker build failed${r.timedOut ? ' (timed out)' : ''}; refusing to fall back to a local build`, 1, log)
      dist = out
    } else {
      const bun = Bun.which('bun')
      if (!bun) throw new DitError('bun is not on PATH; cannot run a local build')
      const r = run(bun, ['apps/web/build.ts'], { cwd: src, env: emptyBuildEnv(sha, home), timeout: BUILD_TIMEOUT })
      log = tail(r.out)
      if (r.code !== 0) throw new DitError(`build failed${r.timedOut ? ' (timed out)' : ''}`, 1, log)
      dist = join(src, 'apps/web/dist')
    }
    add('build toolchain', 'PASS', `bun ${bunVersion}${sandbox === 'none' ? ` (local ${localBun})` : ''}, sandbox ${sandbox === 'docker' ? 'docker (--network none, source read-only)' : 'none (empty-env local child)'}`)

    const built = rehash(dist)                      // never trust the build's own build.json
    try {
      const claimed = (JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8')) as { bundleHash?: string }).bundleHash
      if (claimed && claimed.toLowerCase() !== built.bundleHash.toLowerCase()) add('build.json agrees with independent re-hash', 'WARN', `build.json says ${claimed.slice(0, 18)}..., re-hash says ${built.bundleHash.slice(0, 18)}...`)
    } catch { /* no build.json is fine, we do not rely on it */ }
    add('rebuilt bundleHash', 'PASS', `${built.bundleHash} (${Object.keys(built.files).length} files, re-hashed independently)`)
    const match = built.bundleHash.toLowerCase() === rel.bundleHash.toLowerCase()
    add('on-chain bundleHash', 'INFO', rel.bundleHash)
    add('source == on-chain release', match ? 'PASS' : 'FAIL', match ? 'MATCH' : `MISMATCH (rebuilt ${built.bundleHash.slice(0, 18)}..., chain ${rel.bundleHash.slice(0, 18)}...)`)
    Object.assign(data, { rebuiltBundleHash: built.bundleHash, files: built.files, match, bun: bunVersion })

    const site = o.site ?? (/^https?:\/\//.test(rel.url) && !/example\.invalid/.test(rel.url) ? rel.url.replace(/\/$/, '') : undefined)
    if (site) {
      try {
        const live = await (deps.fetchLive ?? fetchLive)(site)
        const same = live.bundleHash.toLowerCase() === built.bundleHash.toLowerCase()
        data.liveBundleHash = live.bundleHash
        const stale = !same && !o.site && rel.id !== latest   // an older release was verified; the site may legitimately serve a newer one
        add(`live site (${site}) == rebuilt`, same ? 'PASS' : stale ? 'WARN' : 'FAIL', same ? 'MATCH' : stale ? `site now serves a different release (latest is #${latest})` : `MISMATCH (live ${live.bundleHash.slice(0, 18)}...)`)
        if (!same) {
          const diffs = diffFiles(built.files, live.files)
          data.liveDiff = diffs
          for (const d of diffs) add(`  file ${d.name}`, stale ? 'INFO' : 'FAIL', `rebuilt ${d.rebuilt?.slice(0, 18) ?? 'missing'}... vs live ${d.other?.slice(0, 18) ?? 'missing'}...`)
        }
        if (same && match) add('source == release == live', 'PASS', 'nobody has to be trusted')
      } catch (e) { add(`live site (${site})`, o.site ? 'FAIL' : 'WARN', `could not check: ${(e as Error).message.slice(0, 120)}`) }
    }
    if (!match && !site) add('hint', 'INFO', 'pass --site <url> to see which files differ from what is live')
    return { ok: !rows.some((r) => r.status === 'FAIL'), rows, data }
  } finally { rmSync(base, { recursive: true, force: true }) }
}

export async function rebuildCmd(argv: string[]): Promise<number> {
  const o = parseRebuildArgs(argv)
  info(`Rebuilding the public source ${o.source === SOURCE_REPO ? '' : `(${o.source}) `}and comparing with ${l1().label}; this can take a minute...`)
  const r = await rebuild(o)
  void c; void statSync
  if (o.json) { printJson({ ok: r.ok, ...r.data, checks: r.rows }); return r.ok ? 0 : 1 }
  return report('dit verify rebuild', r.rows, false)
}
