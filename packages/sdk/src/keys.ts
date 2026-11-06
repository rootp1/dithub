// Private-repo key management: X25519 device keys bound to a wallet, repo keys sealed per device (grants),
// their Arkiv entities, and epoch rotation. See docs/swarm-arkiv-design.md ("Private repos").
import { randomBytes } from 'node:crypto'
import { ExpirationTime, defineSchema } from '@arkiv-network/sdk'
import { addr, bytes, key, u64 } from '@arkiv-network/sdk/schema'
import { and, asc, eq } from '@arkiv-network/sdk/query'
import { x25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js'
import { getAddress, isAddress, verifyMessage, type Hex as ViemHex } from 'viem'
import { sendAndConfirm, type createArkivConnection } from './arkiv.ts'
import { bytesToHex, hexToBytes, sha256 } from './hash.ts'
import { generateRepositoryKey } from './private.ts'
import type { Hex } from './types.ts'

type Connection = ReturnType<typeof createArkivConnection>
const flags = { readonly: true, permissionlessExtension: true }
const enc = new TextEncoder()

export const SEALED_KEY_VERSION = 1
/** version(1) | ephemeral public key(32) | nonce(24) | ciphertext(32) + tag(16) */
export const SEALED_KEY_LENGTH = 1 + 32 + 24 + 32 + 16
const SEAL_INFO = 'dheet-grant-v1:x25519-hkdf-sha256-xchacha20poly1305'

export interface DeviceKey { privateKey: Hex; publicKey: Hex }

function bytes32(value: Uint8Array | string, what: string): Uint8Array {
  const out = typeof value === 'string' ? hexToBytes(value) : value
  if (out.byteLength !== 32) throw new Error(`${what} must be 32 bytes`)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

export function devicePublicKey(privateKey: Uint8Array | string): Hex {
  return bytesToHex(x25519.getPublicKey(bytes32(privateKey, 'Device private key')))
}

/** A fresh X25519 key pair for this device. The private key never leaves the device. */
export function generateDeviceKey(): DeviceKey {
  const privateKey = new Uint8Array(randomBytes(32))
  return { privateKey: bytesToHex(privateKey), publicKey: devicePublicKey(privateKey) }
}

/** The exact text a wallet signs (personal_sign) to bind a device public key to itself. */
export function deviceKeyStatement(wallet: string, publicKeyHex: string): string {
  if (!isAddress(wallet, { strict: false })) throw new Error('Invalid wallet address')
  const publicKey = bytesToHex(bytes32(publicKeyHex, 'Device public key'))
  return [
    'Dithub device key',
    '',
    'I authorize this X25519 device key to receive the encryption keys of private Dithub repositories I can access.',
    '',
    `Wallet: ${getAddress(wallet)}`,
    `Device key: ${publicKey}`,
    'Schema: dheet-devicekey-v1',
  ].join('\n')
}

export async function verifyDeviceKey(args: { wallet: string; publicKey: string; signature: string }): Promise<boolean> {
  try {
    const message = deviceKeyStatement(args.wallet, args.publicKey)
    return await verifyMessage({ address: getAddress(args.wallet), message, signature: args.signature as ViemHex })
  } catch {
    return false
  }
}

/** Associated context that binds a grant to one repo and epoch, so a sealed key cannot be replayed as another repo's grant. */
export function grantContext(repo: string, epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid key epoch')
  return `${repo.toLowerCase()}:${epoch}`
}

function deriveSealKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, context: string): Uint8Array {
  if (shared.every((b) => b === 0)) throw new Error('Invalid X25519 public key')
  return hkdf(sha256Hash, shared, concat(ephemeralPublic, recipientPublic), enc.encode(`${SEAL_INFO}:${context}`), 32)
}

/**
 * Seal a 32-byte repo key to one device public key (ephemeral X25519 + HKDF-SHA256 + XChaCha20-Poly1305).
 * `context` (see grantContext) must be passed again to openRepoKey.
 */
export function sealRepoKey(repoKey: Uint8Array, recipientPublicKey: Uint8Array | string, context = ''): Uint8Array {
  const plain = bytes32(repoKey, 'Repository key')
  const recipient = bytes32(recipientPublicKey, 'Recipient public key')
  const ephemeral = new Uint8Array(randomBytes(32))
  const ephemeralPublic = x25519.getPublicKey(ephemeral)
  const k = deriveSealKey(x25519.getSharedSecret(ephemeral, recipient), ephemeralPublic, recipient, context)
  ephemeral.fill(0)
  const nonce = new Uint8Array(randomBytes(24))
  const header = concat(new Uint8Array([SEALED_KEY_VERSION]), ephemeralPublic)
  const ciphertext = xchacha20poly1305(k, nonce, header).encrypt(plain)
  return concat(header, nonce, ciphertext)
}

/** Open a sealed repo key with the device private key. Throws on a wrong key, wrong context or any tampering. */
export function openRepoKey(sealed: Uint8Array | string, devicePrivateKey: Uint8Array | string, context = ''): Uint8Array {
  const data = typeof sealed === 'string' ? hexToBytes(sealed) : sealed
  if (data.byteLength !== SEALED_KEY_LENGTH || data[0] !== SEALED_KEY_VERSION) throw new Error('Malformed sealed repository key')
  const priv = bytes32(devicePrivateKey, 'Device private key')
  const header = data.subarray(0, 33)
  const ephemeralPublic = data.subarray(1, 33)
  const nonce = data.subarray(33, 57)
  const k = deriveSealKey(x25519.getSharedSecret(priv, ephemeralPublic), ephemeralPublic, x25519.getPublicKey(priv), context)
  return xchacha20poly1305(k, nonce, header).decrypt(data.subarray(57))
}

/** Opaque Arkiv id of a private repo: sha256('dithub-private:' + repoId + ':' + serverSecret). Names never leave the server. */
export function privateRepoArkivId(repoId: string, serverSecret: string): Hex {
  if (!serverSecret) throw new Error('A server secret is required for private repo ids')
  return sha256(`dithub-private:${repoId}:${serverSecret}`)
}

// ---- Arkiv entities ----

export const ArkivDeviceKeySchema = defineSchema('dheet-devicekey-v1', {
  v: u64().indexed(),
  wallet: addr().indexed(),
  publicKey: key().indexed(),
  ctime: u64().indexed(),
  signature: bytes(),
})

export const ArkivGrantSchema = defineSchema('dheet-grant-v1', {
  v: u64().indexed(),
  repo: key().indexed(),
  epoch: u64().indexed(),
  recipient: key().indexed(),
  ctime: u64().indexed(),
  sealed: bytes(),
})

function arkivBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return hexToBytes(value)
  if (value && typeof value === 'object' && 'value' in value) return arkivBytes((value as { value: unknown }).value)
  throw new Error('Unexpected Arkiv bytes value')
}
const nowSec = () => u64(BigInt(Math.floor(Date.now() / 1000)))
const asKey = (v: string) => key(v.toLowerCase() as ViemHex)

export async function publishDeviceKey(connection: Connection, input: { wallet: string; publicKey: Hex; signature: Hex }) {
  if (!(await verifyDeviceKey(input))) throw new Error('Device key signature does not match the wallet')
  const result = await sendAndConfirm(connection, () => connection.walletClient.createEntity(
    ArkivDeviceKeySchema,
    {
      v: u64(1n),
      wallet: addr(getAddress(input.wallet)),
      publicKey: asKey(input.publicKey),
      ctime: nowSec(),
      signature: hexToBytes(input.signature),
    },
    { expiration: ExpirationTime.max(), flags },
  ))
  return { entityKey: result.entityKey, txHash: result.txHash, expiresAt: result.expiresAt }
}

/** Device keys registered by a wallet; entries whose signature does not verify are dropped. */
export async function listDeviceKeys(connection: Connection, wallet: string, limit = 100) {
  const result = await connection.publicClient
    .select({ $key: true, wallet: true, publicKey: true, signature: true, ctime: true })
    .from(ArkivDeviceKeySchema, { onMismatch: 'throw' })
    .where(eq('wallet', addr(getAddress(wallet))))
    .orderBy(asc('ctime'))
    .limit(limit)
    .fetch()
  const out: Array<{ entityKey: string; wallet: string; publicKey: Hex; signature: Hex; ctime: number }> = []
  for (const e of result.entities as unknown as Array<Record<string, unknown>>) {
    const row = {
      entityKey: String(e.$key),
      wallet: getAddress(String(e.wallet)),
      publicKey: String(e.publicKey).toLowerCase() as Hex,
      signature: bytesToHex(arkivBytes(e.signature)),
      ctime: Number(e.ctime),
    }
    if (await verifyDeviceKey(row)) out.push(row)
  }
  return out
}

export interface Grant { repo: Hex; epoch: number; recipient: Hex; sealed: Uint8Array }

export async function publishGrant(connection: Connection, grant: Grant) {
  if (grant.sealed.byteLength !== SEALED_KEY_LENGTH) throw new Error('Malformed sealed repository key')
  const result = await sendAndConfirm(connection, () => connection.walletClient.createEntity(
    ArkivGrantSchema,
    {
      v: u64(1n),
      repo: asKey(grant.repo),
      epoch: u64(BigInt(grant.epoch)),
      recipient: asKey(grant.recipient),
      ctime: nowSec(),
      sealed: grant.sealed,
    },
    { expiration: ExpirationTime.max(), flags },
  ))
  return { entityKey: result.entityKey, txHash: result.txHash, expiresAt: result.expiresAt }
}

/** Grants for an opaque repo id, optionally narrowed to one epoch and/or one recipient device key. */
export async function listGrants(connection: Connection, filter: { repo: Hex; epoch?: number; recipient?: Hex; limit?: number }) {
  const clauses = [
    eq('repo', asKey(filter.repo)),
    ...(filter.epoch !== undefined ? [eq('epoch', u64(BigInt(filter.epoch)))] : []),
    ...(filter.recipient ? [eq('recipient', asKey(filter.recipient))] : []),
  ]
  const result = await connection.publicClient
    .select({ $key: true, repo: true, epoch: true, recipient: true, sealed: true, ctime: true })
    .from(ArkivGrantSchema, { onMismatch: 'throw' })
    .where(and(...clauses))
    .orderBy(asc('ctime'))
    .limit(filter.limit ?? 200)
    .fetch()
  return (result.entities as unknown as Array<Record<string, unknown>>).map((e) => ({
    entityKey: String(e.$key),
    repo: String(e.repo).toLowerCase() as Hex,
    epoch: Number(e.epoch),
    recipient: String(e.recipient).toLowerCase() as Hex,
    sealed: arkivBytes(e.sealed),
    ctime: Number(e.ctime),
  }))
}

// ---- rotation ----

export interface RotationMember { publicKey: Hex; userId?: string }
export interface PlannedGrant extends Grant { server: boolean; userId?: string }

/**
 * Plan a key epoch: a fresh repo key and one grant per distinct device key of the remaining members, plus the server.
 * `epoch` is the NEW epoch (previous + 1 on rotation, 0 for a new repo). Pass only the members who keep access;
 * `exclude` additionally drops device keys (e.g. a removed member's) even if they are still listed.
 * When `repo` (the opaque Arkiv repo id) is given, every grant is bound to repo+epoch via grantContext().
 * `serverSealed` is the server's copy, for SQLite repo_keys.
 */
export function planRotation(args: { members: RotationMember[]; serverPublicKey: Hex; epoch: number; repo?: Hex; exclude?: Hex[]; repoKey?: Uint8Array }) {
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) throw new Error('Invalid key epoch')
  const repoKey = bytes32(args.repoKey ?? generateRepositoryKey(), 'Repository key')
  const context = args.repo ? grantContext(args.repo, args.epoch) : ''
  const excluded = new Set((args.exclude ?? []).map((k) => k.toLowerCase()))
  const seen = new Set<string>()
  const grants: PlannedGrant[] = []
  const add = (publicKey: Hex, server: boolean, userId?: string) => {
    const pk = bytesToHex(bytes32(publicKey, server ? 'Server public key' : 'Member public key'))
    if (seen.has(pk) || (!server && excluded.has(pk))) return
    seen.add(pk)
    grants.push({ repo: (args.repo?.toLowerCase() ?? '0x') as Hex, epoch: args.epoch, recipient: pk, sealed: sealRepoKey(repoKey, pk, context), server, ...(userId ? { userId } : {}) })
  }
  add(args.serverPublicKey, true)
  for (const m of args.members) add(m.publicKey, false, m.userId)
  return { epoch: args.epoch, repoKey, context, serverSealed: grants[0]!.sealed, grants }
}
