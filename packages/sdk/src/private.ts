import { randomBytes } from 'node:crypto'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { bytesToHex, hexToBytes, sha256 } from './hash.ts'
import type { Hex, PrivateChunkEnvelope } from './types.ts'

function associatedData(repoId: Hex, keyEpoch: number): Uint8Array {
  return new TextEncoder().encode(`dheet-private-v1:${repoId.toLowerCase()}:${keyEpoch}`)
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== 32) throw new Error('Private repository keys must be 32 bytes')
}

export function generateRepositoryKey(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}

export function encryptPrivateChunk(args: {
  plaintext: Uint8Array
  key: Uint8Array
  repoId: Hex
  keyEpoch: number
  nonce?: Uint8Array
}): PrivateChunkEnvelope {
  assertKey(args.key)
  if (!Number.isSafeInteger(args.keyEpoch) || args.keyEpoch < 0) throw new Error('Invalid key epoch')
  const nonce = args.nonce ?? new Uint8Array(randomBytes(24))
  if (nonce.byteLength !== 24) throw new Error('XChaCha20 nonce must be 24 bytes')
  const ciphertext = xchacha20poly1305(args.key, nonce, associatedData(args.repoId, args.keyEpoch))
    .encrypt(args.plaintext)
  return {
    version: 1,
    algorithm: 'xchacha20-poly1305',
    repoId: args.repoId,
    keyEpoch: args.keyEpoch,
    nonce: bytesToHex(nonce),
    plaintextHash: sha256(args.plaintext),
    ciphertextHash: sha256(ciphertext),
    ciphertext,
  }
}

export function decryptPrivateChunk(envelope: PrivateChunkEnvelope, key: Uint8Array): Uint8Array {
  assertKey(key)
  if (sha256(envelope.ciphertext) !== envelope.ciphertextHash) throw new Error('Ciphertext hash mismatch')
  const plaintext = xchacha20poly1305(
    key,
    hexToBytes(envelope.nonce),
    associatedData(envelope.repoId, envelope.keyEpoch),
  ).decrypt(envelope.ciphertext)
  if (sha256(plaintext) !== envelope.plaintextHash) throw new Error('Plaintext hash mismatch')
  return plaintext
}
