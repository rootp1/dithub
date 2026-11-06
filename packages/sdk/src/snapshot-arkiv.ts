import { defineSchema, ExpirationTime } from '@arkiv-network/sdk'
import { key, str, u64, addr } from '@arkiv-network/sdk/schema'
import { and, eq, desc } from '@arkiv-network/sdk/query'
import { sendAndConfirm, type createArkivConnection } from './arkiv.ts'
import type { SnapshotManifest, SnapshotPointer } from './snapshot.ts'
import type { Hex } from './types.ts'

export const DEFAULT_RECOVERY_WRITER = '0x7e290CA88091C8635cC78fE58bB1f6e1361b097c' as const
export const ArkivSnapshotSchema = defineSchema('dheet-snapshot-v2', {
  repo: key().indexed(), seq: u64().indexed(), manifestHash: key().indexed(),
  reference: str(), size: u64(), ctime: u64().indexed(),
})
type Connection = ReturnType<typeof createArkivConnection>
export function snapshotAttribute(value: unknown): string {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  if (value && typeof value === 'object' && 'value' in value) return snapshotAttribute((value as { value: unknown }).value)
  return String(value ?? '')
}

export function publishSnapshotPointer(connection: Connection, manifest: SnapshotManifest, pointer: SnapshotPointer) {
  return sendAndConfirm(connection, () => connection.walletClient.createEntity(ArkivSnapshotSchema, {
    repo: key(manifest.repoId as Hex), seq: u64(BigInt(manifest.sequence)), manifestHash: key(pointer.hash),
    reference: pointer.reference, size: u64(BigInt(pointer.size)), ctime: u64(BigInt(manifest.createdAt)),
  }, { expiration: ExpirationTime.max(), flags: { readonly: true, permissionlessExtension: true } }))
}

export async function findSnapshotPointer(args: { connection: Connection; repoId: Hex; writer: `0x${string}`; manifestHash?: Hex }) {
  const result = await args.connection.publicClient
    .select({ reference: true, size: true, manifestHash: true, ctime: true, $key: true, $expiresAt: true })
    .from(ArkivSnapshotSchema, { onMismatch: 'throw' })
    .where(and(eq('repo', key(args.repoId)), eq('$creator', addr(args.writer)), ...(args.manifestHash ? [eq('manifestHash', key(args.manifestHash))] : [])))
    .orderBy(desc('seq')).limit(1).fetch()
  const entity = result.entities[0]
  if (!entity) return null
  const size = Number(snapshotAttribute(entity.size))
  if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 ** 2) throw new Error('Invalid snapshot pointer size')
  return { reference: snapshotAttribute(entity.reference), hash: snapshotAttribute(entity.manifestHash) as Hex, size,
    createdAt: Number(snapshotAttribute(entity.ctime)), entityKey: snapshotAttribute(entity.$key) as Hex, expiresAt: BigInt(snapshotAttribute(entity.$expiresAt)) }
}
