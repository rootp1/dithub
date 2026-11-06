import { getAddress, recoverTypedDataAddress, type Hex as ViemHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { canonicalJson } from './canonical.ts'
import { sha256 } from './hash.ts'
import type { CollaborationKind, CollaborationRecord, Hex } from './types.ts'

const collaborationTypes = {
  CollaborationRecord: [
    { name: 'repoId', type: 'bytes32' },
    { name: 'recordId', type: 'bytes32' },
    { name: 'kind', type: 'string' },
    { name: 'bodyHash', type: 'bytes32' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const

function message(record: Pick<CollaborationRecord, 'repoId' | 'id' | 'kind' | 'bodyHash' | 'createdAt' | 'nonce'>) {
  return {
    repoId: record.repoId as ViemHex,
    recordId: record.id as ViemHex,
    kind: record.kind,
    bodyHash: record.bodyHash as ViemHex,
    createdAt: BigInt(record.createdAt),
    nonce: BigInt(record.nonce),
  }
}

export async function createCollaborationRecord<T>(args: {
  repoId: Hex
  kind: CollaborationKind
  sequence: number
  nonce: number
  body: T
  privateKey: ViemHex
  chainId?: number
  createdAt?: number
}): Promise<CollaborationRecord<T>> {
  const account = privateKeyToAccount(args.privateKey)
  const createdAt = args.createdAt ?? Math.floor(Date.now() / 1000)
  const bodyHash = sha256(canonicalJson(args.body))
  const id = sha256(canonicalJson({
    repoId: args.repoId,
    kind: args.kind,
    sequence: args.sequence,
    author: account.address.toLowerCase(),
    createdAt,
    nonce: args.nonce,
    bodyHash,
  }))
  const unsigned = {
    version: 1 as const,
    repoId: args.repoId,
    id,
    kind: args.kind,
    sequence: args.sequence,
    author: account.address.toLowerCase() as Hex,
    createdAt,
    nonce: args.nonce,
    bodyHash,
    body: args.body,
  }
  const signature = await account.signTypedData({
    domain: { name: 'DheetCollaboration', version: '1', chainId: args.chainId ?? 1 },
    types: collaborationTypes,
    primaryType: 'CollaborationRecord',
    message: message(unsigned),
  })
  return { ...unsigned, signature: signature as Hex }
}

export async function verifyCollaborationRecord(record: CollaborationRecord, chainId = 1): Promise<boolean> {
  if (sha256(canonicalJson(record.body)) !== record.bodyHash) return false
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'DheetCollaboration', version: '1', chainId },
    types: collaborationTypes,
    primaryType: 'CollaborationRecord',
    message: message(record),
    signature: record.signature as ViemHex,
  })
  return getAddress(recovered) === getAddress(record.author)
}
