import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalJson } from './canonical.ts'
import { isolatedGitEnvironment } from './process.ts'
import { sha256 } from './hash.ts'
import { SwarmStore, SWARM_REFERENCE } from './swarm.ts'

const hex = z.string().regex(/^0x[0-9a-f]{64}$/)
export const SnapshotManifestSchema = z.object({
  protocol: z.literal('dheet-snapshot'), version: z.literal(2), repoId: hex,
  gitObjectFormat: z.enum(['sha1', 'sha256']),
  name: z.string().max(256), sequence: z.number().int().positive(), createdAt: z.number().int().positive(),
  headRef: z.string().startsWith('refs/heads/').max(1024),
  refs: z.array(z.object({ name: z.string().regex(/^refs\/(heads|tags)\//).max(1024), oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) })).min(1),
  bundle: z.object({ reference: z.string().regex(SWARM_REFERENCE), hash: hex, size: z.number().int().positive() }),
  lfsObjectsIncluded: z.literal(false),
})
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>
export interface SnapshotPointer { reference: string; hash: `0x${string}`; size: number }
export const RecoveryInstructionsSchema = z.object({
  version: z.literal(1), repoId: hex, name: z.string().max(256),
  pointer: z.object({ reference: z.string().regex(SWARM_REFERENCE), hash: hex, size: z.number().int().positive().max(8 * 1024 ** 2) }),
})

export async function snapshotGit(args: string[], cwd?: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { ...(cwd ? { cwd } : {}), env: { ...isolatedGitEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdin.on('error', () => {})
    proc.stdin.end(input)
    let out = '', err = ''
    proc.stdout.on('data', (data) => { out += data; if (out.length > 16 * 1024 ** 2) proc.kill() })
    proc.stderr.on('data', (data) => { err = (err + data).slice(-4000) })
    proc.once('error', reject)
    proc.once('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} failed: ${err.slice(-500)}`)))
  })
}

export async function fileDigest(path: string) {
  const digest = createHash('sha256')
  for await (const data of createReadStream(path)) digest.update(data)
  return { hash: `0x${digest.digest('hex')}` as `0x${string}`, size: (await stat(path)).size }
}

/** Build from an isolated mirror so pushes arriving during upload cannot change the recorded refs. */
export async function prepareSnapshot(args: { repoPath: string; repoId: string; name: string; sequence: number; defaultBranch: string; dir: string }) {
  const mirror = join(args.dir, 'mirror.git'), bundlePath = join(args.dir, 'repository.bundle')
  await snapshotGit(['clone', '--mirror', '--no-local', '--', args.repoPath, mirror])
  const refs = (await snapshotGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/tags/'], mirror))
    .split('\n').filter(Boolean).map((line) => { const [name, oid] = line.split(' '); return { name: name!, oid: oid! } })
  if (!refs.some((ref) => ref.name.startsWith('refs/heads/'))) throw new Error('No branches to snapshot')
  const headRef = refs.some((ref) => ref.name === `refs/heads/${args.defaultBranch}`) ? `refs/heads/${args.defaultBranch}` : refs.find((ref) => ref.name.startsWith('refs/heads/'))!.name
  const gitObjectFormat = await snapshotGit(['rev-parse', '--show-object-format'], mirror)
  // Explicit refs exclude session/internal refs; bundle output is streamed to disk by Git.
  await snapshotGit(['bundle', 'create', bundlePath, '--stdin'], mirror, refs.map((ref) => ref.name).join('\n') + '\n')
  await snapshotGit(['bundle', 'verify', bundlePath], mirror)
  return { bundlePath, refs, headRef, gitObjectFormat, digest: await fileDigest(bundlePath) }
}

export async function publishSnapshot(args: Parameters<typeof prepareSnapshot>[0] & { swarm: SwarmStore; onStage?: (stage: string) => Promise<void> }) {
  await args.onStage?.('preparing')
  const prepared = await prepareSnapshot(args)
  await args.onStage?.('uploading')
  const reference = await args.swarm.uploadFile(prepared.bundlePath)
  const manifest = SnapshotManifestSchema.parse({
    protocol: 'dheet-snapshot', version: 2, repoId: args.repoId, name: args.name, sequence: args.sequence,
    gitObjectFormat: prepared.gitObjectFormat,
    createdAt: Math.floor(Date.now() / 1000), headRef: prepared.headRef, refs: prepared.refs,
    bundle: { reference, ...prepared.digest }, lfsObjectsIncluded: false,
  })
  const bytes = canonicalJson(manifest)
  if (Buffer.byteLength(bytes) > 8 * 1024 ** 2) throw new Error('Snapshot manifest exceeds 8 MiB')
  const manifestPath = join(args.dir, 'snapshot.json')
  await writeFile(manifestPath, bytes)
  const pointer: SnapshotPointer = { reference: await args.swarm.uploadFile(manifestPath), hash: sha256(bytes), size: Buffer.byteLength(bytes) }
  await args.onStage?.('verifying')
  // Download the full bundle through the configured read node, which should be independent of the uploader.
  await args.swarm.downloadFile(reference, join(args.dir, 'verified.bundle'), prepared.digest)
  await args.swarm.downloadFile(pointer.reference, join(args.dir, 'verified.json'), pointer)
  return { manifest, pointer }
}

export async function readSnapshot(swarm: SwarmStore, pointer: SnapshotPointer, repoId: string, dir: string) {
  if (pointer.size > 8 * 1024 ** 2) throw new Error('Snapshot manifest exceeds 8 MiB')
  const path = join(dir, 'manifest.json')
  await swarm.downloadFile(pointer.reference, path, pointer)
  const manifest = SnapshotManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (manifest.repoId !== repoId.toLowerCase()) throw new Error('Snapshot repo ID mismatch')
  if (new Set(manifest.refs.map((ref) => ref.name)).size !== manifest.refs.length || !manifest.refs.some((ref) => ref.name === manifest.headRef)) throw new Error('Invalid snapshot refs')
  for (const ref of manifest.refs) await snapshotGit(['check-ref-format', ref.name])
  return manifest
}

export async function restoreSnapshot(args: { swarm: SwarmStore; pointer: SnapshotPointer; repoId: string; dir: string; destination: string; progress?: (bytes: number) => void }) {
  const manifest = await readSnapshot(args.swarm, args.pointer, args.repoId, args.dir)
  const bundlePath = join(args.dir, 'restore.bundle')
  await args.swarm.downloadFile(manifest.bundle.reference, bundlePath, manifest.bundle, args.progress)
  const mirror = join(args.dir, 'restore.git')
  await mkdir(mirror)
  await snapshotGit(['init', '--bare', `--object-format=${manifest.gitObjectFormat}`, mirror])
  await snapshotGit(['bundle', 'verify', bundlePath], mirror)
  const advertised = (await snapshotGit(['bundle', 'list-heads', bundlePath])).split('\n').filter(Boolean).map((line) => {
    const [oid, name] = line.split(' '); return { name, oid }
  })
  if (canonicalJson(advertised.sort((a, b) => a.name!.localeCompare(b.name!))) !== canonicalJson([...manifest.refs].sort((a, b) => a.name.localeCompare(b.name)))) throw new Error('Snapshot bundle refs mismatch')
  await snapshotGit(['fetch', '--stdin', bundlePath], mirror, manifest.refs.map((ref) => `+${ref.name}:${ref.name}`).join('\n') + '\n')
  await snapshotGit(['symbolic-ref', 'HEAD', manifest.headRef], mirror)
  await snapshotGit(['fsck', '--full', '--strict'], mirror)
  await snapshotGit(['clone', '--no-local', '--', mirror, args.destination])
  // Do not leave origin pointing to the temporary mirror that will be deleted.
  await snapshotGit(['remote', 'remove', 'origin'], args.destination)
  for (const ref of manifest.refs.filter((ref) => ref.name.startsWith('refs/heads/') && ref.name !== manifest.headRef)) {
    await snapshotGit(['update-ref', ref.name, ref.oid], args.destination)
  }
  await snapshotGit(['fsck', '--full', '--strict'], args.destination)
  return manifest
}
