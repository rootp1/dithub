import {
  ExpirationTime,
  createPublicClient,
  createWalletClient,
  defineSchema,
} from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { addr, bytes, key, str, u64 } from '@arkiv-network/sdk/schema'
import { and, asc, eq } from '@arkiv-network/sdk/query'
import { http, type Address, type Hex as ViemHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { canonicalJson } from './canonical.ts'
import { chunkBytes } from './chunks.ts'
import { hexToBytes, sha256 } from './hash.ts'
import { LocalNetworkStore } from './local-store.ts'
import { restoreChunksFromBundle } from './repository.ts'
import {
  createSwarmClient,
  fetchPackFromSwarm,
  isSwarmReference,
  swarmConfigFromEnv,
  type SwarmClient,
  type SwarmPackRefs,
} from './swarm.ts'
import type { Hex, RepositoryManifest } from './types.ts'

/**
 * Arkiv's RPC can return a stale nonce when transactions go out back to back; the SDK surfaces that as a generic
 * "Execution error without revert data". A nonce-too-low failure means the transaction was NOT sent, so retrying is safe.
 */
export async function withNonceRetry<T>(operation: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const e = error as { message?: string; shortMessage?: string; details?: string; cause?: { message?: string } }
      const text = `${e.message ?? ''} ${e.shortMessage ?? ''} ${e.details ?? ''} ${e.cause?.message ?? ''}`
      if (attempt >= attempts || !/nonce|underpriced/i.test(text)) throw error
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
    }
  }
}

/**
 * Send one Arkiv write and wait until it is mined before returning. The SDK returns as soon as the transaction is broadcast, so the next
 * write would reuse the same nonce while the first is still pending ("replacement transaction underpriced"). Serialising on the receipt
 * removes the race instead of retrying around it.
 */
export async function sendAndConfirm<R extends { txHash: ViemHex }>(
  connection: { publicClient: { waitForTransactionReceipt: (args: { hash: ViemHex; timeout?: number }) => Promise<unknown> } },
  operation: () => Promise<R>,
): Promise<R> {
  const result = await withNonceRetry(operation)
  await connection.publicClient.waitForTransactionReceipt({ hash: result.txHash, timeout: 90_000 })
  return result
}

export const ArkivChunkSchema = defineSchema('dheet-chunk-v1', {
  v: u64().indexed(),
  kind: str().indexed(),
  repo: key().indexed(),
  seq: u64().indexed(),
  author: addr().indexed(),
  ctime: u64().indexed(),
  payloadHash: key().indexed(),
  oid: key().indexed(),
  gitOid: key().indexed(),
  gitAlg: str().indexed(),
  objectKind: str().indexed(),
  chunkNo: u64().indexed(),
  chunkCount: u64().indexed(),
  rawSize: u64(),
  chunkSize: u64(),
  chunkHash: key().indexed(),
  content: bytes(),
})

export const ArkivManifestSchema = defineSchema('dheet-manifest-v1', {
  v: u64().indexed(),
  kind: str().indexed(),
  repo: key().indexed(),
  seq: u64().indexed(),
  author: addr().indexed(),
  ctime: u64().indexed(),
  payloadHash: key().indexed(),
  oid: key().indexed(),
  packHash: key().indexed(),
  objectRoot: key().indexed(),
  objectCount: u64().indexed(),
  chunkCount: u64().indexed(),
  codec: str().indexed(),
  coldId: str().optional(),
  content: bytes(),
})

export interface ArkivUploadResult {
  manifestEntityKey: ViemHex
  transactionHashes: ViemHex[]
  chunkEntities: number
  /** chunk hashes written by this call (skipped ones are not listed) */
  uploadedChunkHashes: Hex[]
  expiresAt: bigint
}

export interface ArkivConnectionOptions {
  privateKey: ViemHex
  accessKey?: string
}

export function createArkivConnection(options: ArkivConnectionOptions) {
  const chain = rabdi({ accessKey: options.accessKey ?? '' })
  const transport = http()
  const account = privateKeyToAccount(options.privateKey)
  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport, account }),
  }
}

function asArkivKey(value: Hex): ViemHex {
  return value as ViemHex
}

export async function uploadManifestToArkiv(args: {
  manifest: RepositoryManifest
  localStore: LocalNetworkStore
  connection: ReturnType<typeof createArkivConnection>
  coldId?: string
  /** lowercase 0x chunk hashes that already exist on Arkiv for this repo; they are not uploaded again */
  skipChunks?: ReadonlySet<string>
  /** Swarm references from `publishPackToSwarm`; recorded in the manifest entity content so recovery reads Swarm first */
  swarm?: SwarmPackRefs
  /** false: write only the manifest entity (bytes live on Swarm). Default true: also mirror object/bundle chunks to Arkiv */
  uploadChunks?: boolean
}): Promise<ArkivUploadResult> {
  const { manifest, localStore, connection } = args
  const transactionHashes: ViemHex[] = []
  let expiresAt = 0n
  let chunkEntities = 0
  const uploadedChunkHashes: Hex[] = []
  const now = BigInt(Math.floor(Date.now() / 1000))
  const flags = { readonly: true, permissionlessExtension: true }
  const expiration = ExpirationTime.max()

  const createChunk = async (values: {
    oid: Hex
    gitOid: Hex
    gitAlg: string
    objectKind: string
    chunkNo: number
    chunkCount: number
    rawSize: number
    chunkHash: Hex
    content: Uint8Array
  }) => {
    if (args.skipChunks?.has(values.chunkHash.toLowerCase())) return
    if (args.uploadChunks === false && values.objectKind !== 'manifest') return
    const result = await sendAndConfirm(connection, () => connection.walletClient.createEntity(
      ArkivChunkSchema,
      {
        v: u64(1n),
        kind: 'blob-chunk',
        repo: key(asArkivKey(manifest.repoId)),
        seq: u64(BigInt(manifest.sequence)),
        author: addr(connection.account.address),
        ctime: u64(now),
        payloadHash: key(asArkivKey(sha256(values.content))),
        oid: key(asArkivKey(values.oid)),
        gitOid: key(asArkivKey(values.gitOid)),
        gitAlg: values.gitAlg,
        objectKind: values.objectKind,
        chunkNo: u64(BigInt(values.chunkNo)),
        chunkCount: u64(BigInt(values.chunkCount)),
        rawSize: u64(BigInt(values.rawSize)),
        chunkSize: u64(BigInt(values.content.byteLength)),
        chunkHash: key(asArkivKey(values.chunkHash)),
        content: values.content,
      },
      { expiration, flags },
    ))
    transactionHashes.push(result.txHash)
    expiresAt = result.expiresAt
    chunkEntities += 1
    uploadedChunkHashes.push(values.chunkHash)
  }

  for (const object of manifest.objects) {
    for (const descriptor of object.chunks) {
      await createChunk({
        oid: object.dithubOid,
        gitOid: object.gitOid,
        gitAlg: object.gitAlgorithm,
        objectKind: object.type,
        chunkNo: descriptor.index,
        chunkCount: object.chunks.length,
        rawSize: object.rawSize,
        chunkHash: descriptor.hash,
        content: localStore.getChunk(descriptor.hash),
      })
    }
  }

  for (const descriptor of manifest.bundleChunks) {
    await createChunk({
      oid: manifest.bundleHash,
      gitOid: manifest.bundleHash,
      gitAlg: 'none',
      objectKind: 'bundle',
      chunkNo: descriptor.index,
      chunkCount: manifest.bundleChunks.length,
      rawSize: manifest.bundleChunks.reduce((total, chunk) => total + chunk.size, 0),
      chunkHash: descriptor.hash,
      content: localStore.getChunk(descriptor.hash),
    })
  }

  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
  const manifestHash = sha256(manifestBytes)
  const manifestParts = chunkBytes(manifestBytes)
  const inlineContent = arkivManifestContent(manifest, args.swarm)
  const manifestInline = inlineContent.byteLength > 0 && !isPointerContent(inlineContent)
  if (!manifestInline) {
    for (const [index, descriptor] of manifestParts.descriptors.entries()) {
      const content = manifestParts.chunks[index]
      if (!content) throw new Error(`Missing manifest chunk ${index}`)
      await createChunk({
        oid: manifestHash,
        gitOid: manifestHash,
        gitAlg: 'none',
        objectKind: 'manifest',
        chunkNo: descriptor.index,
        chunkCount: manifestParts.chunks.length,
        rawSize: manifestBytes.byteLength,
        chunkHash: descriptor.hash,
        content,
      })
    }
  }

  const manifestResult = await sendAndConfirm(connection, () => connection.walletClient.createEntity(
    ArkivManifestSchema,
    {
      v: u64(1n),
      kind: 'pack-manifest',
      repo: key(asArkivKey(manifest.repoId)),
      seq: u64(BigInt(manifest.sequence)),
      author: addr(connection.account.address),
      ctime: u64(now),
      payloadHash: key(asArkivKey(manifestHash)),
      oid: key(asArkivKey(manifestHash)),
      packHash: key(asArkivKey(manifest.bundleHash)),
      objectRoot: key(asArkivKey(manifest.objectRoot)),
      objectCount: u64(BigInt(manifest.objects.length)),
      chunkCount: u64(BigInt(manifestInline ? 0 : manifestParts.chunks.length)),
      codec: 'canonical-json',
      ...(args.coldId ? { coldId: args.coldId } : {}),
      content: inlineContent,
    },
    { expiration, flags },
  ))
  transactionHashes.push(manifestResult.txHash)

  return {
    manifestEntityKey: manifestResult.entityKey,
    transactionHashes,
    chunkEntities,
    uploadedChunkHashes,
    expiresAt: manifestResult.expiresAt,
  }
}

export async function findManifestOnArkiv(args: {
  repoId: Hex
  manifestHash: Hex
  connection: ReturnType<typeof createArkivConnection>
}) {
  return args.connection.publicClient
    .select({ $key: true, seq: true, oid: true, content: true, chunkCount: true, $expiresAt: true })
    .from(ArkivManifestSchema, { onMismatch: 'throw' })
    .where(
      and(
        eq('repo', key(asArkivKey(args.repoId))),
        eq('oid', key(asArkivKey(args.manifestHash))),
      ),
    )
    .orderBy(asc('seq'))
    .limit(100)
    .fetch()
}

function arkivBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return hexToBytes(value as Hex)
  if (value && typeof value === 'object' && 'value' in value) return arkivBytes((value as { value: unknown }).value)
  throw new Error('Unexpected Arkiv bytes value')
}

/**
 * Rebuild a repository in a local store from its Arkiv manifest entity. Pack bytes come from Swarm when the manifest names Swarm
 * refs and Swarm is reachable, otherwise from Arkiv chunks. Every read is untrusted: the manifest is hash-checked against
 * `manifestHash`, the Swarm pack against the manifest, and every chunk is BLAKE3-verified by `LocalNetworkStore.putChunk`.
 */
export async function fetchRepositoryFromArkiv(args: {
  repoId: Hex
  manifestHash: Hex
  connection: ReturnType<typeof createArkivConnection>
  store: LocalNetworkStore
  /** Swarm client for the pack bytes; default from BEE_URL. null disables Swarm (Arkiv chunks only). */
  swarm?: SwarmClient | null
  /** repository key for encrypted Swarm packs */
  swarmKey?: Uint8Array
  log?: (message: string) => void
}): Promise<RepositoryManifest> {
  const { repoId, manifestHash, connection } = args
  const found = await findManifestOnArkiv({ repoId, manifestHash, connection })
  const entity = found.entities[0]
  if (!entity) throw new Error(`Manifest not found on Arkiv: ${manifestHash}`)
  const config = args.swarm === undefined ? swarmConfigFromEnv() : null
  const swarm = args.swarm === undefined ? (config ? createSwarmClient(config) : null) : args.swarm
  const result = await recoverRepositoryFromManifestContent({
    repoId,
    manifestHash,
    content: arkivBytes(entity.content),
    store: args.store,
    swarm,
    ...(args.swarmKey ? { swarmKey: args.swarmKey } : {}),
    ...(args.log ? { log: args.log } : {}),
    async fetchChunk(chunkHash) {
      const result = await connection.publicClient
        .select({ $key: true, content: true, chunkHash: true })
        .from(ArkivChunkSchema, { onMismatch: 'throw' })
        .where(and(eq('repo', key(asArkivKey(repoId))), eq('chunkHash', key(asArkivKey(chunkHash)))))
        .orderBy(asc('seq'))
        .limit(1)
        .fetch()
      const chunk = result.entities[0]
      if (!chunk) throw new Error(`Chunk not found on Arkiv: ${chunkHash}`)
      return arkivBytes(chunk.content)
    },
  })
  return result.manifest
}

/**
 * Content of a `dheet-manifest-v1` entity: the canonical manifest JSON, plus `swarmPackRef` / `swarmManifestRef` when the pack
 * lives on Swarm. A manifest too large to inline becomes a pointer (just the two refs) when Swarm refs exist, else empty.
 */
export function arkivManifestContent(manifest: RepositoryManifest, swarm?: SwarmPackRefs): Uint8Array {
  const refs = swarm ? { swarmManifestRef: swarm.manifestRef, swarmPackRef: swarm.packRef } : {}
  const full = new TextEncoder().encode(canonicalJson({ ...manifest, ...refs }))
  if (full.byteLength <= 120 * 1024) return full
  return swarm ? new TextEncoder().encode(canonicalJson(refs)) : new Uint8Array()
}

function isPointerContent(content: Uint8Array): boolean {
  return parseArkivManifestContent(content).manifest === null
}

/** Split entity content into the manifest (null for an empty or pointer-only content) and the Swarm refs (null when absent). */
export function parseArkivManifestContent(content: Uint8Array, manifestHash?: Hex): {
  manifest: RepositoryManifest | null
  swarm: SwarmPackRefs | null
} {
  if (content.byteLength === 0) return { manifest: null, swarm: null }
  const parsed = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>
  const { swarmPackRef, swarmManifestRef, ...rest } = parsed
  const swarm = isSwarmReference(swarmPackRef) && isSwarmReference(swarmManifestRef)
    ? { packRef: swarmPackRef, manifestRef: swarmManifestRef }
    : null
  if (rest.protocol === undefined) return { manifest: null, swarm }
  if (manifestHash && sha256(canonicalJson(rest)) !== manifestHash) throw new Error('Arkiv manifest hash mismatch')
  return { manifest: rest as unknown as RepositoryManifest, swarm }
}

/**
 * Rebuild a repository in `store` from the content of an Arkiv manifest entity. When the content names Swarm refs and a client is
 * given, the pack comes from Swarm (verified against the manifest); any chunk still missing is read with `fetchChunk` (Arkiv).
 */
export async function recoverRepositoryFromManifestContent(args: {
  repoId: Hex
  manifestHash: Hex
  content: Uint8Array
  store: LocalNetworkStore
  swarm?: SwarmClient | null
  swarmKey?: Uint8Array
  fetchChunk: (chunkHash: Hex) => Promise<Uint8Array>
  log?: (message: string) => void
}): Promise<{ manifest: RepositoryManifest; source: 'swarm' | 'arkiv' | 'swarm+arkiv'; swarmError?: string }> {
  const { repoId, manifestHash, store } = args
  const parsed = parseArkivManifestContent(args.content, manifestHash)
  let manifest = parsed.manifest
  let fromSwarm: Set<string> | null = null
  let swarmError: string | undefined
  if (parsed.swarm && args.swarm) {
    try {
      const fetched = await fetchPackFromSwarm<RepositoryManifest>(args.swarm, parsed.swarm.manifestRef, args.swarmKey)
      if (fetched.packRef !== parsed.swarm.packRef) throw new Error('Swarm pack reference does not match the Arkiv manifest')
      if (sha256(canonicalJson(fetched.manifest)) !== manifestHash) throw new Error('Swarm manifest hash mismatch')
      manifest ??= fetched.manifest
      const restored = restoreChunksFromBundle(store, manifest, fetched.packBytes)
      const missing = new Set<string>(restored.missing)
      fromSwarm = new Set(requiredChunks(manifest).filter((hash) => !missing.has(hash)))
    } catch (error) {
      swarmError = error instanceof Error ? error.message : String(error)
      args.log?.(`Swarm recovery failed, falling back to Arkiv chunks: ${swarmError}`)
    }
  } else if (parsed.swarm) {
    args.log?.('Manifest has Swarm refs but Swarm is not configured (BEE_URL); using Arkiv chunks')
  }
  if (!manifest) {
    throw new Error(swarmError
      ? `Manifest is only available from Swarm and Swarm failed: ${swarmError}`
      : 'Chunked manifests are not supported by this reader yet')
  }
  if (manifest.repoId.toLowerCase() !== repoId.toLowerCase()) throw new Error('Manifest repoId mismatch')

  let fromArkiv = 0
  for (const chunkHash of requiredChunks(manifest)) {
    if (fromSwarm?.has(chunkHash)) continue
    const stored = store.putChunk(await args.fetchChunk(chunkHash))
    if (stored.hash !== chunkHash) throw new Error(`Arkiv chunk failed verification: ${chunkHash}`)
    fromArkiv += 1
  }

  store.putManifest(manifest)
  store.restoreRepo({
    repoId,
    name: manifest.name,
    sequence: manifest.sequence,
    manifestHash,
    refs: Object.fromEntries(manifest.refs.map((ref) => [ref.name, ref.oid])),
    createdAt: manifest.createdAt,
    updatedAt: Math.floor(Date.now() / 1000),
  })
  const source = !fromSwarm ? 'arkiv' : fromArkiv > 0 ? 'swarm+arkiv' : 'swarm'
  return { manifest, source, ...(swarmError ? { swarmError } : {}) }
}

function requiredChunks(manifest: RepositoryManifest): Hex[] {
  return [...new Set<Hex>([
    ...manifest.bundleChunks.map((descriptor) => descriptor.hash),
    ...manifest.objects.flatMap((object) => object.chunks.map((descriptor) => descriptor.hash)),
  ])]
}
