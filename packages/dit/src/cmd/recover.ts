// `dit recover`: discover through Arkiv or a saved pointer, then verify and restore from either storage backend.
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import type { SnapshotPointer } from '../../../sdk/src/snapshot.ts'
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

export interface RecoverArgs { target: string; dir: string | undefined; manifestHash?: string; accessKey: string; arkivOnly: boolean; json: boolean; host?: string; beeUrl?: string; writer?: `0x${string}`; recoveryFile?: string; maxBytes?: number }

export function parseRecoverArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RecoverArgs {
  const p = parse(argv, { 'manifest-hash': { type: 'string' }, 'access-key': { type: 'string' }, 'arkiv-only': { type: 'boolean' }, 'bee-url': { type: 'string' }, writer: { type: 'string' }, 'recovery-file': { type: 'string' }, 'max-bytes': { type: 'string' } })
  const target = p.positionals[0]
  if (!target) throw new UsageError('missing <repo-id|owner/repo>', 'Usage: dit recover owner/repo [dir] [--manifest-hash 0x...] [--access-key KEY]')
  if (p.positionals.length > 2) throw new UsageError('too many arguments')
  if (!HEX32.test(target) && !parseRepoRef(target)) throw new UsageError(`cannot understand "${target}"`, 'Use a 0x repo id (64 hex) or owner/repo.')
  const mh = str(p.values['manifest-hash'])
  if (mh !== undefined && !HEX32.test(mh)) throw new UsageError('--manifest-hash must be 0x followed by 64 hex characters')
  const accessKey = str(p.values['access-key']) ?? env.ARKIV_ACCESS_KEY ?? ''
  const recoveryFile = str(p.values['recovery-file'])
  if (!accessKey && !recoveryFile) throw new UsageError('no Arkiv access key', KEY_HELP)
  const host = str(p.values.host)
  const beeUrl = str(p.values['bee-url']) ?? env.SWARM_READ_URL
  if (beeUrl) { try { if (!['http:', 'https:'].includes(new URL(beeUrl).protocol)) throw new Error() } catch { throw new UsageError('--bee-url must be an HTTP or HTTPS URL') } }
  const writer = str(p.values.writer) ?? env.DHEET_RECOVERY_WRITER
  if (writer && !/^0x[0-9a-f]{40}$/i.test(writer)) throw new UsageError('--writer must be an Ethereum address')
  const maxBytes = Number(str(p.values['max-bytes']) ?? env.SWARM_MAX_BYTES ?? 10 * 1024 ** 3)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new UsageError('--max-bytes must be a positive integer')
  return { target, dir: p.positionals[1], ...(mh ? { manifestHash: mh.toLowerCase() } : {}), accessKey, arkivOnly: flag(p.values['arkiv-only']), json: flag(p.values.json), ...(host ? { host } : {}), ...(beeUrl ? { beeUrl } : {}), ...(writer ? { writer: writer as `0x${string}` } : {}), ...(recoveryFile ? { recoveryFile } : {}), maxBytes }
}

// The part of the SDK we use, so tests can inject a fake.
export interface Sdk {
  connect(accessKey: string): unknown
  resolveName(conn: unknown, name: string): Promise<string | null>
  newestPushManifest(conn: unknown, repoId: string): Promise<string | null>
  materialise(o: { conn: unknown; repoId: string; manifestHash: string; dest: string; tmp: string; pointer?: SnapshotPointer }): Promise<{ chunks: number; objects: number; name: string; sequence: number; backend?: string }>
}

export async function loadSdk(options: { beeUrl?: string; writer?: `0x${string}`; json?: boolean; maxBytes?: number } = {}): Promise<Sdk> {
  const sdk = await import('../../../sdk/src/index.ts')
  const query = await import('@arkiv-network/sdk/query')
  const schema = await import('@arkiv-network/sdk/schema')
  const writer = options.writer ?? sdk.DEFAULT_RECOVERY_WRITER
  return {
    connect: (accessKey) => sdk.createArkivConnection({ privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', accessKey }),
    async resolveName(conn, name) {
      const found = await sdk.resolveNameOnArkiv(conn as never, name, writer)
      const first = found[0] as unknown as { repo?: unknown } | undefined
      const id = first ? attrString(first.repo) : ''
      return HEX32.test(id) ? id.toLowerCase() : null
    },
    async newestPushManifest(conn, repoId) {
      const snapshot = await sdk.findSnapshotPointer({ connection: conn as never, repoId: repoId as never, writer })
      const res = await (conn as ReturnType<typeof sdk.createArkivConnection>).publicClient
        .select({ $key: true, kind: true, ctime: true, manifestHash: true })
        .from(sdk.ArkivActivitySchema, { onMismatch: 'throw' })
        .where(query.and(query.eq('repo', schema.key(repoId as `0x${string}`)), query.eq('kind', 'push'), query.eq('$creator', schema.addr(writer))))
        .orderBy(query.desc('ctime'))
        .limit(100)
        .fetch()
      for (const e of res.entities as unknown as Array<{ manifestHash?: unknown; ctime?: unknown }>) {
        const h = attrString(e.manifestHash).toLowerCase()
        if (HEX32.test(h) && h !== ZERO) return snapshot && snapshot.createdAt >= Number(attrString(e.ctime)) ? snapshot.hash : h
      }
      return snapshot?.hash ?? null
    },
    async materialise({ conn, repoId, manifestHash, dest, tmp, pointer: savedPointer }) {
      const pointer = savedPointer ?? await sdk.findSnapshotPointer({ connection: conn as never, repoId: repoId as never, manifestHash: manifestHash as never, writer })
      if (pointer) {
        const swarm = new sdk.SwarmStore({ url: options.beeUrl ?? sdk.DEFAULT_SWARM_READ_URL, ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}) })
        let last = 0
        const manifest = await sdk.restoreSnapshot({ swarm, pointer, repoId, dir: tmp, destination: dest, progress: (bytes) => {
          if (!options.json && Date.now() - last > 2000) { last = Date.now(); info(`Downloaded ${(bytes / 1024 ** 2).toFixed(1)} MiB…`) }
        } })
        const counts = git(['count-objects', '-v'], { cwd: dest }).out
        const objects = Number(/^count: (\d+)/m.exec(counts)?.[1] ?? 0) + Number(/^in-pack: (\d+)/m.exec(counts)?.[1] ?? 0)
        return { chunks: 1, objects, name: manifest.name, sequence: manifest.sequence, backend: 'swarm' }
      }
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
  const s = sdk ?? await loadSdk(a)
  const conn = a.recoveryFile ? null : s.connect(a.accessKey)
  const tmp = mkdtempSync(join(tmpdir(), 'dit-recover-'))
  try {
    let repoId = a.target.toLowerCase(), via = 'repo id given'
    let saved: { repoId: string; pointer: SnapshotPointer; name: string } | undefined
    if (a.recoveryFile) {
      if (statSync(a.recoveryFile).size > 64 * 1024) throw new DitError('Recovery instructions exceed 64 KiB')
      const { RecoveryInstructionsSchema } = await import('../../../sdk/src/snapshot.ts')
      const data = RecoveryInstructionsSchema.parse(JSON.parse(readFileSync(a.recoveryFile, 'utf8')))
      if (HEX32.test(a.target) ? data.repoId !== repoId : data.name !== a.target) throw new DitError('Recovery file does not match the requested repository')
      saved = data as typeof saved
      repoId = data.repoId; via = 'downloaded recovery instructions'
    }
    if (!HEX32.test(a.target) && !saved) {
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
    if (saved && a.manifestHash && saved.pointer.hash !== a.manifestHash) throw new DitError('Recovery file manifest hash differs from --manifest-hash')
    let manifestHash = saved?.pointer.hash ?? a.manifestHash, how = saved ? 'downloaded recovery instructions' : 'given with --manifest-hash'
    if (!manifestHash) {
      const newest = await s.newestPushManifest(conn, repoId)
      if (!newest) throw new DitError(`no push with a code manifest was found on Arkiv for ${repoId}`, 1, 'A public repository needs a completed backup. For a self-hosted instance, pass --writer with its relayer address.')
      manifestHash = newest; how = 'newest trusted push or snapshot record on Arkiv'
    }
    const r = await s.materialise({ conn, repoId, manifestHash, dest, tmp, ...(saved ? { pointer: saved.pointer } : {}) })
    const fsck = git(['fsck', '--strict', '--no-progress'], { cwd: dest })
    if (fsck.code !== 0) throw new DitError(`git fsck failed on the recovered repository: ${fsck.err.trim().slice(0, 300)}`)
    const commit = git(['rev-parse', 'HEAD'], { cwd: dest }).out.trim()
    return { dir: dest, repoId, resolvedVia: via, manifestHash, manifestFrom: how, commit, backend: r.backend ?? 'arkiv', chunksVerified: r.chunks, objects: r.objects, name: r.name, sequence: r.sequence, fsck: 'ok' }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true })
    if (err instanceof DitError) throw new DitError(scrub(err.message, a.accessKey), err.code, err.hint)
    const msg = scrub((err as Error).message ?? String(err), a.accessKey).replace(/\s+/g, ' ').slice(0, 300)
    throw new DitError(`repository recovery failed: ${msg}`, 1, /40[13]|unauthori|forbidden|access.?key|invalid key/i.test(msg) && !/Swarm/.test(msg) ? KEY_HELP : /Swarm/.test(msg) ? 'Check the Swarm reader (--bee-url), storage availability and postage funding, then retry.' : 'If the entities are older than about 182 days they may have expired (Arkiv entities need renewal).')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

export async function recoverCmd(argv: string[]): Promise<number> {
  const a = parseRecoverArgs(argv)
  info(`Recovering ${a.target}; discovering the backup through Arkiv…`)
  const r = await recover(a)
  if (a.json) { printJson(r); return 0 }
  console.log(`${c.green('Recovered')} ${HEX32.test(a.target) ? r.name : a.target} into ${r.dir}`)
  console.log(`repo id:        ${r.repoId}  (${r.resolvedVia})`)
  console.log(`manifest hash:  ${r.manifestHash}  (${r.manifestFrom})`)
  console.log(`commit:         ${r.commit}`)
  console.log(`storage:        ${r.backend}`)
  console.log(`verified:       ${r.chunksVerified} ${r.backend === 'swarm' ? 'bundle' : 'chunk'}(s) hash-checked, ${r.objects} git object(s), git fsck ok`)
  return 0
}
