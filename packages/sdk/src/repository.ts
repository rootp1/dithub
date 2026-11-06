import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalJson } from './canonical.ts'
import { chunkBytes, joinChunks } from './chunks.ts'
import {
  assertGitRepository,
  bundleHash,
  createBundle,
  currentHeadRef,
  exportReachableObjects,
  gitObjectFormat,
  listRefs,
  runGitFsck,
} from './git.ts'
import { gitOid, sha256 } from './hash.ts'
import { merkleRoot } from './merkle.ts'
import { LocalNetworkStore } from './local-store.ts'
import { isolatedGitEnvironment } from './process.ts'
import type {
  Hex,
  PublishResult,
  RepositoryManifest,
  VerificationResult,
} from './types.ts'

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, {
    ...(cwd ? { cwd } : {}),
    env: command === 'git' ? isolatedGitEnvironment() : process.env,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`)
}

export function deriveRepoId(name: string, entropy: string): Hex {
  return sha256(`dheet:repo:v1:${name}:${entropy}`)
}

export function initialiseRepository(
  repoPath: string,
  name: string,
  store: LocalNetworkStore,
): { repoId: Hex; name: string } {
  assertGitRepository(repoPath)
  try {
    const existing = store.getRepo(name)
    return { repoId: existing.repoId, name: existing.name }
  } catch {
    const absolute = resolve(repoPath)
    const repoId = deriveRepoId(name, `${absolute}:${Date.now()}:${crypto.randomUUID()}`)
    store.createRepo(name, repoId)
    return { repoId, name }
  }
}

export function publishRepository(
  repoPath: string,
  nameOrId: string,
  store: LocalNetworkStore,
): PublishResult {
  assertGitRepository(repoPath)
  const current = store.getRepo(nameOrId)
  const refs = listRefs(repoPath)
  if (refs.length === 0) throw new Error('Cannot publish a repository with no refs')

  const bundle = createBundle(repoPath)
  const bundleParts = chunkBytes(bundle)
  let uploadedChunks = 0
  let reusedChunks = 0
  for (const [index, bytes] of bundleParts.chunks.entries()) {
    const stored = store.putChunk(bytes)
    if (stored.hash !== bundleParts.descriptors[index]?.hash) throw new Error('Bundle chunk hash mismatch')
    stored.reused ? (reusedChunks += 1) : (uploadedChunks += 1)
  }

  const exported = exportReachableObjects(repoPath)
  for (const object of exported) {
    for (const [index, bytes] of object.chunks.entries()) {
      const stored = store.putChunk(bytes)
      if (stored.hash !== object.descriptor.chunks[index]?.hash) throw new Error('Object chunk hash mismatch')
      stored.reused ? (reusedChunks += 1) : (uploadedChunks += 1)
    }
  }

  const sequence = current.sequence + 1
  const objects = exported.map(({ descriptor }) => descriptor).sort((left, right) =>
    left.dithubOid.localeCompare(right.dithubOid),
  )
  const manifest: RepositoryManifest = {
    protocol: 'dithub',
    version: 1,
    repoId: current.repoId,
    name: current.name,
    sequence,
    createdAt: Math.floor(Date.now() / 1000),
    gitObjectFormat: gitObjectFormat(repoPath),
    previousManifest: current.manifestHash,
    bundleHash: bundleHash(bundle),
    bundleChunks: bundleParts.descriptors,
    objects,
    refs,
    headRef: currentHeadRef(repoPath),
    objectRoot: merkleRoot(objects.map((object) => sha256(canonicalJson(object)))),
  }
  const manifestHash = store.putManifest(manifest)
  const repo = store.compareAndSwapRepo(
    current.repoId,
    current.sequence,
    current.manifestHash,
    manifestHash,
    Object.fromEntries(refs.map((ref) => [ref.name, ref.oid])),
  )
  return { repo, manifest, manifestHash, uploadedChunks, reusedChunks }
}

export function reconstructBundle(store: LocalNetworkStore, manifest: RepositoryManifest): Uint8Array {
  const chunks = manifest.bundleChunks.map((descriptor) => store.getChunk(descriptor.hash))
  const bundle = joinChunks(chunks, manifest.bundleChunks)
  if (bundleHash(bundle) !== manifest.bundleHash) throw new Error('Bundle hash mismatch')
  return bundle
}

/**
 * Fill a local store from a pack (git bundle) fetched from Swarm: the bundle chunks, then every object chunk the manifest lists,
 * re-derived by unbundling. Each chunk is checked against the manifest descriptors. Returns the chunk hashes still missing.
 */
export function restoreChunksFromBundle(
  store: LocalNetworkStore,
  manifest: RepositoryManifest,
  bundle: Uint8Array,
): { restored: number; missing: Hex[] } {
  if (bundleHash(bundle) !== manifest.bundleHash) throw new Error('Swarm pack does not match the manifest bundle hash')
  const parts = chunkBytes(bundle)
  if (parts.descriptors.length !== manifest.bundleChunks.length
    || parts.descriptors.some((descriptor, index) => descriptor.hash !== manifest.bundleChunks[index]?.hash)) {
    throw new Error('Swarm pack chunks do not match the manifest')
  }
  const restoredHashes = new Set<string>()
  for (const chunk of parts.chunks) restoredHashes.add(store.putChunk(chunk).hash)

  const wanted = new Map(manifest.objects.map((object) => [object.dithubOid, object]))
  if (wanted.size > 0) {
    const directory = mkdtempSync(join(tmpdir(), 'dithub-swarm-'))
    const bundlePath = join(directory, 'pack.bundle')
    const barePath = join(directory, 'repository.git')
    try {
      writeFileSync(bundlePath, bundle)
      run('git', ['clone', '--mirror', '--quiet', bundlePath, barePath])
      for (const exported of exportReachableObjects(barePath)) {
        const expected = wanted.get(exported.descriptor.dithubOid)
        if (!expected) continue
        if (expected.chunks.length !== exported.chunks.length) throw new Error(`${expected.gitOidHex}: chunk layout mismatch`)
        for (const [index, bytes] of exported.chunks.entries()) {
          const stored = store.putChunk(bytes)
          if (stored.hash !== expected.chunks[index]?.hash) throw new Error(`${expected.gitOidHex}: object chunk mismatch`)
          restoredHashes.add(stored.hash)
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const all = new Set<Hex>([
    ...manifest.bundleChunks.map((chunk) => chunk.hash),
    ...manifest.objects.flatMap((object) => object.chunks.map((chunk) => chunk.hash)),
  ])
  return { restored: restoredHashes.size, missing: [...all].filter((hash) => !restoredHashes.has(hash)) }
}

export function cloneRepository(
  nameOrId: string,
  destination: string,
  store: LocalNetworkStore,
): RepositoryManifest {
  const repo = store.getRepo(nameOrId)
  if (!repo.manifestHash) throw new Error(`Repository has not been published: ${repo.name}`)
  const manifest = store.getManifest(repo.manifestHash)
  const bundle = reconstructBundle(store, manifest)
  const directory = mkdtempSync(join(tmpdir(), 'dheet-clone-'))
  const bundlePath = join(directory, 'repository.bundle')
  try {
    writeFileSync(bundlePath, bundle)
    run('git', ['clone', bundlePath, resolve(destination)])
    run('git', ['-C', resolve(destination), 'symbolic-ref', 'HEAD', manifest.headRef])
    run('git', ['-C', resolve(destination), 'reset', '--hard', manifest.refs.find((ref) => ref.name === manifest.headRef)?.oid ?? manifest.headRef])
    runGitFsck(resolve(destination))
    return manifest
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function materialiseBareRepository(
  nameOrId: string,
  destination: string,
  store: LocalNetworkStore,
): RepositoryManifest {
  const repo = store.getRepo(nameOrId)
  if (!repo.manifestHash) throw new Error(`Repository has not been published: ${repo.name}`)
  const manifest = store.getManifest(repo.manifestHash)
  const bundle = reconstructBundle(store, manifest)
  const bundlePath = join(tmpdir(), `dithub-${repo.repoId.slice(2)}-${process.pid}.bundle`)
  try {
    writeFileSync(bundlePath, bundle)
    run('git', ['clone', '--bare', bundlePath, resolve(destination)])
    run('git', ['-C', resolve(destination), 'symbolic-ref', 'HEAD', manifest.headRef])
    runGitFsck(resolve(destination))
    return manifest
  } finally {
    rmSync(bundlePath, { force: true })
  }
}

export function verifyRepository(nameOrId: string, store: LocalNetworkStore): VerificationResult {
  const errors: string[] = []
  const repo = store.getRepo(nameOrId)
  if (!repo.manifestHash) {
    return { valid: false, manifestHash: sha256(''), objectCount: 0, chunkCount: 0, errors: ['No manifest'] }
  }
  const manifest = store.getManifest(repo.manifestHash)
  let chunkCount = manifest.bundleChunks.length
  try {
    reconstructBundle(store, manifest)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  for (const object of manifest.objects) {
    chunkCount += object.chunks.length
    try {
      const chunks = object.chunks.map((descriptor) => store.getChunk(descriptor.hash))
      const payload = joinChunks(chunks, object.chunks)
      if (payload.byteLength !== object.rawSize) throw new Error(`${object.gitOidHex}: raw size mismatch`)
      const oid = gitOid(object.type, payload, object.gitAlgorithm).slice(2)
      if (oid !== object.gitOidHex) throw new Error(`${object.gitOidHex}: Git OID mismatch`)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  const expectedRoot = merkleRoot(manifest.objects.map((object) => sha256(canonicalJson(object))))
  if (expectedRoot !== manifest.objectRoot) errors.push('Object Merkle root mismatch')
  return {
    valid: errors.length === 0,
    manifestHash: repo.manifestHash,
    objectCount: manifest.objects.length,
    chunkCount,
    errors,
  }
}

export function repositoryRemoteUrl(name: string, networkPath: string): string {
  const encoded = Buffer.from(resolve(networkPath)).toString('base64url')
  return `dithub::${name}@${encoded}`
}

export function parseRepositoryRemoteUrl(url: string): { name: string; networkPath: string } {
  const match = /^(?:(?:dithub|dheet)::)?([^@]+)@([A-Za-z0-9_-]+)$/.exec(url)   // dheet:: is the pre-rename scheme
  if (!match?.[1] || !match[2]) throw new Error(`Invalid Dithub remote URL: ${url}`)
  return { name: match[1], networkPath: Buffer.from(match[2], 'base64url').toString('utf8') }
}
