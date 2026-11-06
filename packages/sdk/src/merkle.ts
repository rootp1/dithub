import { hexToBytes, sha256 } from './hash.ts'
import type { Hex } from './types.ts'

export const EMPTY_ROOT = sha256(new Uint8Array())

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return EMPTY_ROOT
  let level = [...leaves].sort().map(hexToBytes)
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]
      const right = level[index + 1] ?? left
      if (!left || !right) throw new Error('Invalid Merkle level')
      next.push(hexToBytes(sha256(Buffer.concat([Buffer.from(left), Buffer.from(right)]))))
    }
    level = next
  }
  const root = level[0]
  if (!root) return EMPTY_ROOT
  return `0x${Buffer.from(root).toString('hex')}`
}
