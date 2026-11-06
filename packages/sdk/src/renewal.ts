import { ExpirationTime } from '@arkiv-network/sdk'
import type { Hex as ViemHex } from 'viem'
import type { createArkivConnection } from './arkiv.ts'

export interface RenewalResult {
  entityKey: ViemHex
  transactionHash: ViemHex
  expiresAt: bigint
}

export async function renewArkivEntities(args: {
  entityKeys: ViemHex[]
  connection: ReturnType<typeof createArkivConnection>
}): Promise<RenewalResult[]> {
  const unique = [...new Set(args.entityKeys.map((key) => key.toLowerCase() as ViemHex))]
  const results: RenewalResult[] = []
  for (const entityKey of unique) {
    const renewed = await args.connection.walletClient.extendEntity({
      entityKey,
      expiration: ExpirationTime.max(),
    })
    results.push({ entityKey, transactionHash: renewed.txHash, expiresAt: renewed.expiresAt })
  }
  return results
}
