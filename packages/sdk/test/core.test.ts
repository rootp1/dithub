import { describe, expect, test } from 'bun:test'
import { canonicalJson } from '../src/canonical.ts'
import { chunkBytes, joinChunks } from '../src/chunks.ts'
import { dithubOid, gitOid, sha256, toBytes32GitOid } from '../src/hash.ts'
import { merkleRoot } from '../src/merkle.ts'
import { decryptPrivateChunk, encryptPrivateChunk } from '../src/private.ts'
import { createCollaborationRecord, verifyCollaborationRecord } from '../src/collaboration.ts'

describe('protocol primitives', () => {
  test('canonical JSON is independent of object insertion order', () => {
    expect(canonicalJson({ zebra: 1, alpha: { two: 2, one: 1 } })).toBe(
      canonicalJson({ alpha: { one: 1, two: 2 }, zebra: 1 }),
    )
  })

  test('Git and Dithub OIDs use canonical Git framing', () => {
    const payload = new TextEncoder().encode('hello\n')
    expect(gitOid('blob', payload, 'sha1')).toBe('0xce013625030ba8dba906f756967f9e9ca394464a')
    expect(dithubOid('blob', payload)).toBe(gitOid('blob', payload, 'sha256'))
    expect(toBytes32GitOid('ce013625030ba8dba906f756967f9e9ca394464a')).toBe(
      '0x000000000000000000000000ce013625030ba8dba906f756967f9e9ca394464a',
    )
  })

  test('chunks verify and reassemble', () => {
    const source = new Uint8Array(300_000).map((_, index) => index % 251)
    const chunked = chunkBytes(source)
    expect(chunked.chunks.length).toBe(3)
    expect(joinChunks(chunked.chunks, chunked.descriptors)).toEqual(source)
    const secondChunk = chunked.chunks[1]
    if (!secondChunk) throw new Error('Expected a second chunk')
    secondChunk[0] = (secondChunk[0] ?? 0) ^ 1
    expect(() => joinChunks(chunked.chunks, chunked.descriptors)).toThrow('hash mismatch')
  })

  test('Merkle root is stable regardless of input order', () => {
    const leaves = [dithubOid('blob', new Uint8Array([1])), dithubOid('blob', new Uint8Array([2]))]
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves].reverse()))
  })

  test('private chunks are authenticated with repository and key epoch context', () => {
    const key = new Uint8Array(32).fill(7)
    const repoId = sha256('private-repo')
    const plaintext = new TextEncoder().encode('private source bytes')
    const envelope = encryptPrivateChunk({ plaintext, key, repoId, keyEpoch: 3, nonce: new Uint8Array(24).fill(9) })
    expect(decryptPrivateChunk(envelope, key)).toEqual(plaintext)
    expect(() => decryptPrivateChunk({ ...envelope, keyEpoch: 4 }, key)).toThrow()
    const corrupted = { ...envelope, ciphertext: envelope.ciphertext.slice() }
    corrupted.ciphertext[0] = (corrupted.ciphertext[0] ?? 0) ^ 1
    expect(() => decryptPrivateChunk(corrupted, key)).toThrow('Ciphertext hash mismatch')
  })

  test('collaboration records use verifiable EIP-712 signatures', async () => {
    const record = await createCollaborationRecord({
      repoId: sha256('collaboration-repo'),
      kind: 'issue',
      sequence: 1,
      nonce: 0,
      body: { title: 'First issue', state: 'open' },
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      createdAt: 1_700_000_000,
    })
    expect(await verifyCollaborationRecord(record)).toBe(true)
    expect(await verifyCollaborationRecord({ ...record, body: { title: 'tampered' } })).toBe(false)
  })
})
