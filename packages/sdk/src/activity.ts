import { ExpirationTime, defineSchema } from '@arkiv-network/sdk'
import { addr, key, str, u64, bytes } from '@arkiv-network/sdk/schema'
import { and, asc, eq } from '@arkiv-network/sdk/query'
import type { Hex as ViemHex } from 'viem'
import type { createArkivConnection } from './arkiv.ts'
import type { Hex } from './types.ts'

export const ZERO_KEY = `0x${'00'.repeat(32)}` as Hex

/** One entity per user-visible event: push, commit, pr, review, issue, comment, release. */
export const ArkivActivitySchema = defineSchema('dheet-activity-v1', {
  v: u64().indexed(),
  kind: str().indexed(),
  repo: key().indexed(),
  seq: u64().indexed(),
  actor: addr().indexed(),
  ctime: u64().indexed(),
  ref: str().indexed(),
  commitOid: key().indexed(),
  title: str().indexed(),
  l1ChainId: u64().indexed(),
  l1Tx: key().indexed(),
  manifestHash: key().indexed(),
  content: bytes(),
})

/** repo name -> repoId. First valid claim wins; clients verify the claimant against the platform ledger. */
export const ArkivNameSchema = defineSchema('dheet-name-v1', {
  v: u64().indexed(),
  name: str().indexed(),
  repo: key().indexed(),
  owner: addr().indexed(),
  ctime: u64().indexed(),
})

type Connection = ReturnType<typeof createArkivConnection>
const flags = { readonly: true, permissionlessExtension: true }

export interface ActivityInput {
  kind: string
  repoId: Hex
  seq: number
  actor: ViemHex
  ref?: string
  commitOid?: Hex
  title?: string
  l1ChainId?: number
  l1Tx?: Hex
  manifestHash?: Hex
  body?: unknown
}

function clampUtf8(value: string, max = 120): string {
  const encoder = new TextEncoder()
  let out = value.replace(/[\r\n]+/g, ' ')
  while (encoder.encode(out).byteLength > max) out = out.slice(0, -1)
  return out
}

export function padOid(oid: string): Hex {
  const clean = oid.replace(/^0x/, '').toLowerCase()
  return `0x${clean.padStart(64, '0')}` as Hex
}

export async function recordActivity(connection: Connection, input: ActivityInput) {
  const content = new TextEncoder().encode(JSON.stringify(input.body ?? {}))
  if (content.byteLength > 100 * 1024) throw new Error('Activity body too large')
  const result = await connection.walletClient.createEntity(
    ArkivActivitySchema,
    {
      v: u64(1n),
      kind: input.kind,
      repo: key(input.repoId as ViemHex),
      seq: u64(BigInt(input.seq)),
      actor: addr(input.actor),
      ctime: u64(BigInt(Math.floor(Date.now() / 1000))),
      ref: clampUtf8(input.ref ?? ''),
      commitOid: key((input.commitOid ?? ZERO_KEY) as ViemHex),
      title: clampUtf8(input.title ?? ''),
      l1ChainId: u64(BigInt(input.l1ChainId ?? 0)),
      l1Tx: key((input.l1Tx ?? ZERO_KEY) as ViemHex),
      manifestHash: key((input.manifestHash ?? ZERO_KEY) as ViemHex),
      content,
    },
    { expiration: ExpirationTime.max(), flags },
  )
  return { entityKey: result.entityKey, txHash: result.txHash, expiresAt: result.expiresAt }
}

export async function claimName(connection: Connection, name: string, repoId: Hex) {
  const result = await connection.walletClient.createEntity(
    ArkivNameSchema,
    {
      v: u64(1n),
      name: clampUtf8(name, 100),
      repo: key(repoId as ViemHex),
      owner: addr(connection.account.address),
      ctime: u64(BigInt(Math.floor(Date.now() / 1000))),
    },
    { expiration: ExpirationTime.max(), flags },
  )
  return { entityKey: result.entityKey, txHash: result.txHash, expiresAt: result.expiresAt }
}

export async function listActivity(connection: Connection, repoId: Hex, limit = 100) {
  const result = await connection.publicClient
    .select({ $key: true, kind: true, seq: true, actor: true, ref: true, commitOid: true, title: true, l1Tx: true, ctime: true })
    .from(ArkivActivitySchema, { onMismatch: 'throw' })
    .where(eq('repo', key(repoId as ViemHex)))
    .orderBy(asc('seq'))
    .limit(limit)
    .fetch()
  return result.entities
}

export async function resolveNameOnArkiv(connection: Connection, name: string) {
  const result = await connection.publicClient
    .select({ $key: true, name: true, repo: true, owner: true, ctime: true })
    .from(ArkivNameSchema, { onMismatch: 'throw' })
    .where(and(eq('name', name)))
    .orderBy(asc('ctime'))
    .limit(100)
    .fetch()
  return result.entities
}
