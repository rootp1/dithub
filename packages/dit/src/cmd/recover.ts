// `dit recover`: rebuild a repository from Arkiv alone (no Dithub server). The SDK is imported lazily so other commands stay fast.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { flag, parse, str } from '../args.ts'
import { ApiError, DitError, UsageError } from '../errors.ts'
import { primaryHost } from '../config.ts'
import { apiFor } from '../api.ts'
import { git, parseRepoRef } from '../git.ts'
import { c, info, printJson } from '../ui.ts'

const KEY_HELP = 'Arkiv reads need an access key: get one at https://hub.arkiv.network/access-keys and pass it with --access-key or the ARKIV_ACCESS_KEY environment variable.'
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const ZERO = '0x' + '0'.repeat(64)

/** Never let the access key reach the terminal (viem puts the RPC URL, which contains it, into error messages). */
export function scrub(text: string, secret: string): string {
  let out = secret.length >= 8 ? text.split(secret).join('***') : text
  out = out.replace(/(https?:\/\/[^\s"']*?\/)[A-Za-z0-9_-]{20,}(?=[\s"'/)]|$)/g, '$1***')
  return out
}

/** Arkiv SDK returns attribute values as string, bytes or {value}; normalise to a string / 0x-hex. */
export function attrString(v: unknown): string {
  if (v instanceof Uint8Array) return '0x' + Buffer.from(v).toString('hex')
  if (v && typeof v === 'object' && 'value' in v) return attrString((v as { value: unknown }).value)
  return String(v ?? '')
}

export interface RecoverArgs { target: string; dir: string | undefined; manifestHash?: string; accessKey: string; arkivOnly: boolean; json: boolean; host?: string }

export function parseRecoverArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RecoverArgs {
  const p = parse(argv, { 'manifest-hash': { type: 'string' }, 'access-key': { type: 'string' }, 'arkiv-only': { type: 'boolean' } })
  const target = p.positionals[0]
  if (!target) throw new UsageError('missing <repo-id|owner/repo>', 'Usage: dit recover owner/repo [dir] [--manifest-hash 0x...] [--access-key KEY]')
  if (p.positionals.length > 2) throw new UsageError('too many arguments')
  if (!HEX32.test(target) && !parseRepoRef(target)) throw new UsageError(`cannot understand "${target}"`, 'Use a 0x repo id (64 hex) or owner/repo.')
  const mh = str(p.values['manifest-hash'])
  if (mh !== undefined && !HEX32.test(mh)) throw new UsageError('--manifest-hash must be 0x followed by 64 hex characters')
  const accessKey = str(p.values['access-key']) ?? env.ARKIV_ACCESS_KEY ?? ''
  if (!accessKey) throw new UsageError('no Arkiv access key', KEY_HELP)
  const host = str(p.values.host)
  return { target, dir: p.positionals[1], ...(mh ? { manifestHash: mh.toLowerCase() } : {}), accessKey, arkivOnly: flag(p.values['arkiv-only']), json: flag(p.values.json), ...(host ? { host } : {}) }
}

// The part of the SDK we use, so tests can inject a fake.
export interface Sdk {
  connect(accessKey: string): unknown
  resolveName(conn: unknown, name: string): Promise<string | null>
  newestPushManifest(conn: unknown, repoId: string): Promise<string | null>
  materialise(o: { conn: unknown; repoId: string; manifestHash: string; dest: string; tmp: string }): Promise<{ chunks: number; objects: number; name: string; sequence: number }>
}

export async function loadSdk(): Promise<Sdk> {
  const sdk = await import('../../../sdk/src/index.ts')
  const query = await import('@arkiv-network/sdk/query')
  const schema = await import('@arkiv-network/sdk/schema')
  return {
    connect: (accessKey) => sdk.createArkivConnection({ privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', accessKey }),
    async resolveName(conn, name) {
      const found = await sdk.resolveNameOnArkiv(conn as never, name)         // oldest claim first: first valid claim wins
      const first = found[0] as unknown as { repo?: unknown } | undefined
      const id = first ? attrString(first.repo) : ''
      return HEX32.test(id) ? id.toLowerCase() : null
    },
    async newestPushManifest(conn, repoId) {
      const res = await (conn as ReturnType<typeof sdk.createArkivConnection>).publicClient
        .select({ $key: true, kind: true, seq: true, manifestHash: true })
        .from(sdk.ArkivActivitySchema, { onMismatch: 'throw' })
        .where(query.and(query.eq('repo', schema.key(repoId as `0x${string}`)), query.eq('kind', 'push')))
        .orderBy(query.desc('seq'))
        .limit(100)
        .fetch()
      for (const e of res.entities as unknown as Array<{ manifestHash?: unknown }>) {
        const h = attrString(e.manifestHash).toLowerCase()
        if (HEX32.test(h) && h !== ZERO) return h
      }
      return null
    },
    async materialise({ conn, repoId, manifestHash, dest, tmp }) {
      const store = new sdk.LocalNetworkStore(tmp)
      const manifest = await sdk.fetchRepositoryFromArkiv({ repoId: repoId as never, manifestHash: manifestHash as never, connection: conn as never, store })
      sdk.cloneRepository(repoId, dest, store)
      const chunks = new Set<string>(manifest.bundleChunks.map((d) => d.hash))
      for (const o of manifest.objects) for (const d of o.chunks) chunks.add(d.hash)
      return { chunks: chunks.size, objects: manifest.objects.length, name: manifest.name, sequence: manifest.sequence }
    },
  }
}

export async function recover(a: RecoverArgs, sdk?: Sdk): Promise<Record<string, unknown>> {
  const dest = resolve(a.dir ?? (HEX32.test(a.target) ? `repo-${a.target.slice(2, 10)}` : parseRepoRef(a.target)!.repo))
  if (existsSync(dest)) throw new DitError(`destination already exists: ${dest}`)
  const s = sdk ?? await loadSdk()
  const conn = s.connect(a.accessKey)
  const tmp = mkdtempSync(join(tmpdir(), 'dit-recover-'))
  try {
    let repoId = a.target.toLowerCase(), via = 'repo id given'
    if (!HEX32.test(a.target)) {
      const ref = parseRepoRef(a.target)!
      const name = `${ref.owner}/${ref.repo}`
      let fromApi: string | null = null
      if (!a.arkivOnly) {
        try {
          const host = ref.origin ?? primaryHost(a.host)
          fromApi = (await apiFor(host, { flagHost: a.host, timeoutMs: 8000 }).get<{ repoId: string }>(`/api/names/${ref.owner}/${ref.repo}`)).repoId
          via = `Dithub API (${host})`
        } catch (e) { if (e instanceof ApiError && e.status === 404) info(c.dim('The server does not know this name; trying Arkiv.')); else info(c.dim('Dithub server unreachable; resolving the name through Arkiv.')) }
      }
      if (fromApi && HEX32.test(fromApi)) repoId = fromApi.toLowerCase()
      else {
        const id = await s.resolveName(conn, name)
        if (!id) throw new DitError(`no Arkiv name entity found for ${name}`, 1, 'Check the spelling, or pass the 0x repo id directly.')
        repoId = id; via = 'Arkiv name entity (dheet-name-v1, first claim wins)'
      }
    }
    let manifestHash = a.manifestHash, how = 'given with --manifest-hash'
    if (!manifestHash) {
      const newest = await s.newestPushManifest(conn, repoId)
      if (!newest) throw new DitError(`no push with a code manifest was found on Arkiv for ${repoId}`, 1, 'Only small PUBLIC repos on the default branch are mirrored to Arkiv.')
      manifestHash = newest; how = 'newest push activity entity on Arkiv'
    }
    const r = await s.materialise({ conn, repoId, manifestHash, dest, tmp })
    const fsck = git(['fsck', '--strict', '--no-progress'], { cwd: dest })
    if (fsck.code !== 0) throw new DitError(`git fsck failed on the recovered repository: ${fsck.err.trim().slice(0, 300)}`)
    const commit = git(['rev-parse', 'HEAD'], { cwd: dest }).out.trim()
    return { dir: dest, repoId, resolvedVia: via, manifestHash, manifestFrom: how, commit, chunksVerified: r.chunks, objects: r.objects, name: r.name, sequence: r.sequence, fsck: 'ok' }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true })
    if (err instanceof DitError) throw new DitError(scrub(err.message, a.accessKey), err.code, err.hint)
    const msg = scrub((err as Error).message ?? String(err), a.accessKey).replace(/\s+/g, ' ').slice(0, 300)
    throw new DitError(`recovery from Arkiv failed: ${msg}`, 1, /40[13]|unauthori|forbidden|access.?key|invalid key/i.test(msg) ? KEY_HELP : 'If the entities are older than about 182 days they may have expired (Arkiv entities need renewal).')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

export async function recoverCmd(argv: string[]): Promise<number> {
  const a = parseRecoverArgs(argv)
  info(`Recovering ${a.target} from Arkiv (no Dithub server needed once the repo id is known)...`)
  const r = await recover(a)
  if (a.json) { printJson(r); return 0 }
  console.log(`${c.green('Recovered')} ${HEX32.test(a.target) ? r.name : a.target} into ${r.dir}`)
  console.log(`repo id:        ${r.repoId}  (${r.resolvedVia})`)
  console.log(`manifest hash:  ${r.manifestHash}  (${r.manifestFrom})`)
  console.log(`commit:         ${r.commit}`)
  console.log(`verified:       ${r.chunksVerified} chunk(s) hash-checked, ${r.objects} git object(s) described by the manifest, git fsck ok`)
  return 0
}
