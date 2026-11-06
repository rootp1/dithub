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
  const inlineContent = manifestBytes.byteLength <= 120 * 1024 ? manifestBytes : new Uint8Array()
  if (inlineContent.byteLength === 0) {
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
      chunkCount: u64(BigInt(inlineContent.byteLength === 0 ? manifestParts.chunks.length : 0)),
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

/**
 * Rebuild a repository in a local store using only Arkiv reads.
 * Arkiv reads are untrusted: the manifest is hash-checked against `manifestHash`
 * and every chunk is BLAKE3-verified by `LocalNetworkStore.putChunk`.
 */
function arkivBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return hexToBytes(value as Hex)
  if (value && typeof value === 'object' && 'value' in value) return arkivBytes((value as { value: unknown }).value)
  throw new Error('Unexpected Arkiv bytes value')
}

export async function fetchRepositoryFromArkiv(args: {
  repoId: Hex
  manifestHash: Hex
  connection: ReturnType<typeof createArkivConnection>
  store: LocalNetworkStore
}): Promise<RepositoryManifest> {
  const { repoId, manifestHash, connection, store } = args
  const found = await findManifestOnArkiv({ repoId, manifestHash, connection })
  const entity = found.entities[0]
  if (!entity) throw new Error(`Manifest not found on Arkiv: ${manifestHash}`)
  const content = arkivBytes(entity.content)
  if (content.byteLength === 0) throw new Error('Chunked manifests are not supported by this reader yet')
  const text = new TextDecoder().decode(content)
  if (sha256(text) !== manifestHash) throw new Error('Arkiv manifest hash mismatch')
  const manifest = JSON.parse(text) as RepositoryManifest
  if (manifest.repoId.toLowerCase() !== repoId.toLowerCase()) throw new Error('Manifest repoId mismatch')

  const wanted = new Map<Hex, true>()
  for (const descriptor of manifest.bundleChunks) wanted.set(descriptor.hash, true)
  for (const object of manifest.objects) for (const descriptor of object.chunks) wanted.set(descriptor.hash, true)

  for (const chunkHash of wanted.keys()) {
    const result = await connection.publicClient
      .select({ $key: true, content: true, chunkHash: true })
      .from(ArkivChunkSchema, { onMismatch: 'throw' })
      .where(and(eq('repo', key(asArkivKey(repoId))), eq('chunkHash', key(asArkivKey(chunkHash)))))
      .orderBy(asc('seq'))
      .limit(1)
      .fetch()
    const chunk = result.entities[0]
    if (!chunk) throw new Error(`Chunk not found on Arkiv: ${chunkHash}`)
    const stored = store.putChunk(arkivBytes(chunk.content))
    if (stored.hash !== chunkHash) throw new Error(`Arkiv chunk failed verification: ${chunkHash}`)
  }

  store.putManifest(manifest)
  const now = Math.floor(Date.now() / 1000)
  store.restoreRepo({
    repoId,
    name: manifest.name,
    sequence: manifest.sequence,
    manifestHash,
    refs: Object.fromEntries(manifest.refs.map((ref) => [ref.name, ref.oid])),
    createdAt: manifest.createdAt,
    updatedAt: now,
  })
  return manifest
}
