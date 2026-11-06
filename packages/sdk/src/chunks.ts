import { blake3Hash } from './hash.ts'
import type { ChunkDescriptor } from './types.ts'

export const DEFAULT_CHUNK_SIZE = 120 * 1024

export interface ChunkedBytes {
  descriptors: ChunkDescriptor[]
  chunks: Uint8Array[]
}

export function chunkBytes(bytes: Uint8Array, chunkSize = DEFAULT_CHUNK_SIZE): ChunkedBytes {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 128 * 1024) {
    throw new Error(`Invalid chunk size: ${chunkSize}`)
  }
  const chunks: Uint8Array[] = []
  const descriptors: ChunkDescriptor[] = []
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkSize, index += 1) {
    const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength))
    chunks.push(chunk)
    descriptors.push({ index, size: chunk.byteLength, hash: blake3Hash(chunk) })
  }
  if (bytes.byteLength === 0) {
    const chunk = new Uint8Array()
    chunks.push(chunk)
    descriptors.push({ index: 0, size: 0, hash: blake3Hash(chunk) })
  }
  return { chunks, descriptors }
}

export function joinChunks(chunks: Uint8Array[], descriptors: ChunkDescriptor[]): Uint8Array {
  if (chunks.length !== descriptors.length) throw new Error('Chunk count mismatch')
  const ordered = [...descriptors].sort((left, right) => left.index - right.index)
  const buffers = ordered.map((descriptor) => {
    const chunk = chunks[descriptor.index]
    if (!chunk) throw new Error(`Missing chunk ${descriptor.index}`)
    if (chunk.byteLength !== descriptor.size) throw new Error(`Chunk ${descriptor.index} size mismatch`)
    if (blake3Hash(chunk) !== descriptor.hash) throw new Error(`Chunk ${descriptor.index} hash mismatch`)
    return Buffer.from(chunk)
  })
  return new Uint8Array(Buffer.concat(buffers))
}
