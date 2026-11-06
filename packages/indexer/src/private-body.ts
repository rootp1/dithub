// Encrypted bodies for private-repo activity on Arkiv. The entity carries only the opaque repo id, a kind and the L1 tx;
// names, refs, subjects and Swarm references live in `enc`, an XChaCha20-Poly1305 envelope under the repo key of `epoch`.
import { decryptPrivateChunk, deserializeEnvelope, encryptPrivateChunk, serializeEnvelope, type Hex } from '../../sdk/src/index.ts'

export const PRIVATE_BODY_FORMAT = 'dithub-private-body-v1'

export interface PrivateBody { format: typeof PRIVATE_BODY_FORMAT; epoch: number; enc: string }

export function sealPrivateBody(value: unknown, key: Uint8Array, arkivRepoId: Hex, epoch: number): PrivateBody {
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const envelope = encryptPrivateChunk({ plaintext, key, repoId: arkivRepoId, keyEpoch: epoch })
  return { format: PRIVATE_BODY_FORMAT, epoch, enc: Buffer.from(serializeEnvelope(envelope)).toString('base64') }
}

export function isPrivateBody(value: unknown): value is PrivateBody {
  const v = value as PrivateBody | null
  return !!v && typeof v === 'object' && v.format === PRIVATE_BODY_FORMAT && typeof v.enc === 'string' && Number.isSafeInteger(v.epoch)
}

/** Throws on a wrong key, a body sealed for another repo id, or any tampering. */
export function openPrivateBody<T = unknown>(body: PrivateBody, key: Uint8Array, arkivRepoId: Hex): T {
  const envelope = deserializeEnvelope(new Uint8Array(Buffer.from(body.enc, 'base64')))
  if (envelope.repoId.toLowerCase() !== arkivRepoId.toLowerCase() || envelope.keyEpoch !== body.epoch) throw new Error('Private body does not belong to this repo/epoch')
  return JSON.parse(new TextDecoder().decode(decryptPrivateChunk(envelope, key))) as T
}
