// Swarm (Bee) storage for git packs. See docs/swarm-arkiv-design.md.
// Plain fetch against the Bee HTTP API: POST /bytes, GET /bytes/{ref}, GET /health.
import { canonicalJson } from './canonical.ts'
import { sha256 } from './hash.ts'
import { decryptPrivateChunk, encryptPrivateChunk } from './private.ts'
import type { Hex, PrivateChunkEnvelope } from './types.ts'

export interface SwarmConfig {
  beeUrl: string
  /** required for uploads only; downloads work without a postage batch */
  postageBatchId?: string
}

export interface SwarmClientOptions extends SwarmConfig {
  fetch?: typeof fetch
  /** per-request timeout for uploads (default 120s) */
  uploadTimeoutMs?: number
  /** per-request timeout for downloads and health (default 60s) */
  downloadTimeoutMs?: number
}

export interface SwarmClient {
  uploadBytes(data: Uint8Array, options?: { encrypt?: boolean; pin?: boolean }): Promise<{ reference: string }>
  downloadBytes(reference: string): Promise<Uint8Array>
  health(): Promise<boolean>
}

const REFERENCE = /^[0-9a-f]{64}(?:[0-9a-f]{64})?$/
const BATCH = /^(?:0x)?[0-9a-f]{64}$/i

export function isSwarmReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE.test(value)
}

function normaliseReference(reference: string): string {
  const value = reference.trim().toLowerCase().replace(/^0x/, '')
  if (!REFERENCE.test(value)) throw new Error(`Invalid Swarm reference: ${reference}`)
  return value
}

/** null when BEE_URL is unset: Swarm is disabled and callers log and skip. */
export function swarmConfigFromEnv(env: Record<string, string | undefined> = process.env): SwarmConfig | null {
  const beeUrl = env.BEE_URL?.trim()
  if (!beeUrl) return null
  const postageBatchId = env.BEE_POSTAGE_BATCH_ID?.trim()
  return { beeUrl, ...(postageBatchId ? { postageBatchId } : {}) }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out'
    return error.message
  }
  return String(error)
}

async function bodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return ''
  }
}

export function createSwarmClient(options: SwarmClientOptions): SwarmClient {
  const doFetch = options.fetch ?? fetch
  const base = options.beeUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error(`Invalid Bee URL: ${options.beeUrl}`)
  const uploadTimeout = options.uploadTimeoutMs ?? 120_000
  const downloadTimeout = options.downloadTimeoutMs ?? 60_000

  return {
    async uploadBytes(data, uploadOptions = {}) {
      const batch = options.postageBatchId
      if (!batch) throw new Error('Swarm upload needs a postage batch (set BEE_POSTAGE_BATCH_ID)')
      if (!BATCH.test(batch)) throw new Error('Swarm postage batch id must be 32-byte hex')
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'swarm-postage-batch-id': batch.replace(/^0x/i, '').toLowerCase(),
      }
      if (uploadOptions.encrypt) headers['swarm-encrypt'] = 'true'
      if (uploadOptions.pin) headers['swarm-pin'] = 'true'
      let response: Response
      try {
        response = await doFetch(`${base}/bytes`, {
          method: 'POST',
          headers,
          body: data as Uint8Array<ArrayBuffer>,
          signal: AbortSignal.timeout(uploadTimeout),
        })
      } catch (error) {
        throw new Error(`Swarm upload to ${base} failed: ${describe(error)}`)
      }
      if (!response.ok) throw new Error(`Swarm upload failed: HTTP ${response.status} ${await bodyText(response)}`.trim())
      const body = (await response.json().catch(() => null)) as { reference?: unknown } | null
      const reference = typeof body?.reference === 'string' ? body.reference.toLowerCase() : ''
      if (!REFERENCE.test(reference)) throw new Error('Swarm upload returned no valid reference')
      return { reference }
    },

    async downloadBytes(reference) {
      const ref = normaliseReference(reference)
      let lastError = ''
      // one retry, for network errors, timeouts and 5xx only
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await doFetch(`${base}/bytes/${ref}`, { signal: AbortSignal.timeout(downloadTimeout) })
          if (response.ok) return new Uint8Array(await response.arrayBuffer())
          lastError = `HTTP ${response.status} ${await bodyText(response)}`.trim()
          if (response.status < 500) break
        } catch (error) {
          lastError = describe(error)
        }
      }
      throw new Error(`Swarm download of ${ref} failed: ${lastError}`)
    },

    async health() {
      try {
        const response = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(downloadTimeout) })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

// Private envelopes on Swarm: MAGIC, uint32 BE header length, canonical JSON header (every envelope field but ciphertext), ciphertext.
const ENVELOPE_MAGIC = new TextEncoder().encode('DHENV1\n')

export function serializeEnvelope(envelope: PrivateChunkEnvelope): Uint8Array {
  const { ciphertext, ...header } = envelope
  const headerBytes = new TextEncoder().encode(canonicalJson(header))
  const out = new Uint8Array(ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength + ciphertext.byteLength)
  out.set(ENVELOPE_MAGIC, 0)
  new DataView(out.buffer).setUint32(ENVELOPE_MAGIC.byteLength, headerBytes.byteLength)
  out.set(headerBytes, ENVELOPE_MAGIC.byteLength + 4)
  out.set(ciphertext, ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength)
  return out
}

export function isSerializedEnvelope(bytes: Uint8Array): boolean {
  if (bytes.byteLength < ENVELOPE_MAGIC.byteLength + 4) return false
  return ENVELOPE_MAGIC.every((byte, index) => bytes[index] === byte)
}

export function deserializeEnvelope(bytes: Uint8Array): PrivateChunkEnvelope {
  if (!isSerializedEnvelope(bytes)) throw new Error('Not a Dithub encrypted envelope')
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(ENVELOPE_MAGIC.byteLength)
  const start = ENVELOPE_MAGIC.byteLength + 4
  if (start + length > bytes.byteLength) throw new Error('Truncated encrypted envelope')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length))) as Record<string, unknown>
  if (header.version !== 1 || header.algorithm !== 'xchacha20-poly1305') throw new Error('Unsupported encrypted envelope')
  return { ...header, ciphertext: bytes.slice(start + length) } as unknown as PrivateChunkEnvelope
}

export interface SwarmPackDocument<M = unknown> {
  format: 'dithub-swarm-pack'
  version: 1
  repoId: Hex
  packRef: string
  /** sha256 of the plaintext pack bytes */
  packHash: Hex
  packSize: number
  manifest: M
}

export interface SwarmPackRefs {
  packRef: string
  manifestRef: string
}

/**
 * Upload a pack and a small document that points at it. With `encryptWith`, both are XChaCha20-Poly1305 envelopes
 * (the document holds the manifest, refs and repo name, so it is sealed too). Returns the two Swarm references.
 */
export async function publishPackToSwarm<M>(client: SwarmClient, args: {
  repoId: Hex
  packBytes: Uint8Array
  manifest: M
  encryptWith?: { key: Uint8Array; keyEpoch: number }
  pin?: boolean
}): Promise<SwarmPackRefs> {
  const seal = (plaintext: Uint8Array) => args.encryptWith
    ? serializeEnvelope(encryptPrivateChunk({ plaintext, key: args.encryptWith.key, repoId: args.repoId, keyEpoch: args.encryptWith.keyEpoch }))
    : plaintext
  const pin = args.pin ?? false
  const { reference: packRef } = await client.uploadBytes(seal(args.packBytes), { pin })
  const document: SwarmPackDocument<M> = {
    format: 'dithub-swarm-pack',
    version: 1,
    repoId: args.repoId,
    packRef,
    packHash: sha256(args.packBytes),
    packSize: args.packBytes.byteLength,
    manifest: args.manifest,
  }
  const { reference: manifestRef } = await client.uploadBytes(seal(new TextEncoder().encode(canonicalJson(document))), { pin })
  return { packRef, manifestRef }
}

export interface FetchedSwarmPack<M = unknown> {
  repoId: Hex
  packRef: string
  manifestRef: string
  packBytes: Uint8Array
  manifest: M
  encrypted: boolean
  keyEpoch?: number
}

/** Download and verify a pack published with `publishPackToSwarm`. Encrypted packs need `key`; a wrong key throws. */
export async function fetchPackFromSwarm<M = unknown>(
  client: SwarmClient,
  manifestRef: string,
  key?: Uint8Array,
): Promise<FetchedSwarmPack<M>> {
  const open = (bytes: Uint8Array, what: string): { plaintext: Uint8Array; envelope?: PrivateChunkEnvelope } => {
    if (!isSerializedEnvelope(bytes)) return { plaintext: bytes }
    if (!key) throw new Error(`Swarm ${what} is encrypted; a repository key is required`)
    const envelope = deserializeEnvelope(bytes)
    try {
      return { plaintext: decryptPrivateChunk(envelope, key), envelope }
    } catch (error) {
      throw new Error(`Cannot decrypt Swarm ${what} (wrong key or epoch?): ${describe(error)}`)
    }
  }
  const outer = open(await client.downloadBytes(manifestRef), 'manifest')
  let document: SwarmPackDocument<M>
  try {
    document = JSON.parse(new TextDecoder().decode(outer.plaintext)) as SwarmPackDocument<M>
  } catch {
    throw new Error(`Swarm reference ${manifestRef} is not a Dithub pack manifest`)
  }
  if (document?.format !== 'dithub-swarm-pack' || document.version !== 1) throw new Error('Unsupported Swarm pack manifest')
  if (!isSwarmReference(document.packRef)) throw new Error('Swarm pack manifest has an invalid pack reference')
  if (outer.envelope && outer.envelope.repoId.toLowerCase() !== document.repoId.toLowerCase()) throw new Error('Swarm manifest repoId mismatch')
  const pack = open(await client.downloadBytes(document.packRef), 'pack')
  if (Boolean(pack.envelope) !== Boolean(outer.envelope)) throw new Error('Swarm pack and manifest encryption disagree')
  if (outer.envelope && pack.envelope && (
    pack.envelope.repoId.toLowerCase() !== outer.envelope.repoId.toLowerCase() || pack.envelope.keyEpoch !== outer.envelope.keyEpoch
  )) throw new Error('Swarm pack envelope does not match its manifest')
  if (pack.plaintext.byteLength !== document.packSize || sha256(pack.plaintext) !== document.packHash) {
    throw new Error('Swarm pack failed verification (hash mismatch)')
  }
  return {
    repoId: document.repoId,
    packRef: document.packRef,
    manifestRef: normaliseReference(manifestRef),
    packBytes: pack.plaintext,
    manifest: document.manifest,
    encrypted: Boolean(outer.envelope),
    ...(outer.envelope ? { keyEpoch: outer.envelope.keyEpoch } : {}),
  }
}
