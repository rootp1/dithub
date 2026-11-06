import { describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import {
  SEALED_KEY_LENGTH, deviceKeyStatement, devicePublicKey, generateDeviceKey, grantContext, openRepoKey, planRotation,
  privateRepoArkivId, sealRepoKey, verifyDeviceKey,
} from '../src/keys.ts'
import { decryptPrivateChunk, encryptPrivateChunk, generateRepositoryKey } from '../src/private.ts'
import { sha256 } from '../src/hash.ts'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)

describe('device keys', () => {
  test('generated key pair is consistent', () => {
    const k = generateDeviceKey()
    expect(k.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    expect(devicePublicKey(k.privateKey)).toBe(k.publicKey)
    expect(generateDeviceKey().publicKey).not.toBe(k.publicKey)
  })

  test('statement names wallet and key', () => {
    const k = generateDeviceKey()
    const s = deviceKeyStatement(account.address.toLowerCase(), k.publicKey)
    expect(s).toContain(`Wallet: ${account.address}`)
    expect(s).toContain(`Device key: ${k.publicKey}`)
    expect(() => deviceKeyStatement('nope', k.publicKey)).toThrow()
    expect(() => deviceKeyStatement(account.address, '0x1234')).toThrow()
  })

  test('statement verifies with the signing wallet only', async () => {
    const k = generateDeviceKey()
    const signature = await account.signMessage({ message: deviceKeyStatement(account.address, k.publicKey) })
    expect(await verifyDeviceKey({ wallet: account.address, publicKey: k.publicKey, signature })).toBe(true)
    expect(await verifyDeviceKey({ wallet: other.address, publicKey: k.publicKey, signature })).toBe(false)
    expect(await verifyDeviceKey({ wallet: account.address, publicKey: generateDeviceKey().publicKey, signature })).toBe(false)
    expect(await verifyDeviceKey({ wallet: account.address, publicKey: k.publicKey, signature: '0xdead' })).toBe(false)
  })
})

describe('sealed repo keys', () => {
  test('round trip', () => {
    const device = generateDeviceKey()
    const repoKey = generateRepositoryKey()
    const sealed = sealRepoKey(repoKey, device.publicKey)
    expect(sealed.byteLength).toBe(SEALED_KEY_LENGTH)
    expect(openRepoKey(sealed, device.privateKey)).toEqual(repoKey)
    // a fresh ephemeral key every time
    expect(sealRepoKey(repoKey, device.publicKey)).not.toEqual(sealed)
  })

  test('wrong device key fails', () => {
    const sealed = sealRepoKey(generateRepositoryKey(), generateDeviceKey().publicKey)
    expect(() => openRepoKey(sealed, generateDeviceKey().privateKey)).toThrow()
  })

  test('tampering anywhere fails', () => {
    const device = generateDeviceKey()
    const sealed = sealRepoKey(generateRepositoryKey(), device.publicKey)
    for (const i of [1, 20, 40, 60, SEALED_KEY_LENGTH - 1]) {
      const bad = sealed.slice()
      bad[i]! ^= 1
      expect(() => openRepoKey(bad, device.privateKey)).toThrow()
    }
    expect(() => openRepoKey(sealed.slice(0, -1), device.privateKey)).toThrow()
    const v = sealed.slice(); v[0] = 2
    expect(() => openRepoKey(v, device.privateKey)).toThrow('Malformed')
  })

  test('context binds repo and epoch', () => {
    const device = generateDeviceKey()
    const repoKey = generateRepositoryKey()
    const sealed = sealRepoKey(repoKey, device.publicKey, grantContext('0xAB', 3))
    expect(openRepoKey(sealed, device.privateKey, grantContext('0xab', 3))).toEqual(repoKey)
    expect(() => openRepoKey(sealed, device.privateKey, grantContext('0xab', 4))).toThrow()
    expect(() => openRepoKey(sealed, device.privateKey)).toThrow()
  })

  test('rejects the all-zero public key', () => {
    expect(() => sealRepoKey(generateRepositoryKey(), new Uint8Array(32))).toThrow()
  })
})

describe('private repo ids and rotation', () => {
  test('opaque id depends on repo and secret', () => {
    const id = privateRepoArkivId('repo-1', 's3cret')
    expect(id).toBe(sha256('dithub-private:repo-1:s3cret'))
    expect(privateRepoArkivId('repo-2', 's3cret')).not.toBe(id)
    expect(privateRepoArkivId('repo-1', 'other')).not.toBe(id)
    expect(() => privateRepoArkivId('repo-1', '')).toThrow()
  })

  test('rotation grants remaining members and the server, never the removed member', () => {
    const server = generateDeviceKey(), alice = generateDeviceKey(), bob = generateDeviceKey(), carol = generateDeviceKey()
    const repo = privateRepoArkivId('repo-1', 'secret')
    const first = planRotation({ members: [{ publicKey: alice.publicKey }, { publicKey: bob.publicKey }, { publicKey: carol.publicKey }], serverPublicKey: server.publicKey, epoch: 0, repo })
    expect(first.grants).toHaveLength(4)

    // bob removed: he is not passed; carol is excluded explicitly even though still listed
    const next = planRotation({
      members: [{ publicKey: alice.publicKey, userId: 'u-alice' }, { publicKey: alice.publicKey }, { publicKey: carol.publicKey }],
      serverPublicKey: server.publicKey, epoch: 1, repo, exclude: [carol.publicKey.toUpperCase().replace('0X', '0x') as `0x${string}`],
    })
    expect(next.epoch).toBe(1)
    expect(next.repoKey).not.toEqual(first.repoKey)
    expect(next.grants.map((g) => g.recipient).sort()).toEqual([server.publicKey, alice.publicKey].sort())
    expect(next.grants[0]!.server).toBe(true)
    expect(next.grants.find((g) => g.recipient === alice.publicKey)?.userId).toBe('u-alice')
    for (const g of next.grants) {
      expect(g.repo).toBe(repo)
      expect(g.epoch).toBe(1)
    }
    const ctx = grantContext(repo, 1)
    expect(openRepoKey(next.serverSealed, server.privateKey, ctx)).toEqual(next.repoKey)
    const aliceGrant = next.grants.find((g) => g.recipient === alice.publicKey)!
    expect(openRepoKey(aliceGrant.sealed, alice.privateKey, ctx)).toEqual(next.repoKey)
    for (const g of next.grants) {
      expect(() => openRepoKey(g.sealed, bob.privateKey, ctx)).toThrow()
      expect(() => openRepoKey(g.sealed, carol.privateKey, ctx)).toThrow()
    }
  })

  test('rotation rejects bad input', () => {
    const server = generateDeviceKey()
    expect(() => planRotation({ members: [], serverPublicKey: server.publicKey, epoch: -1 })).toThrow()
    expect(() => planRotation({ members: [{ publicKey: '0x12' }], serverPublicKey: server.publicKey, epoch: 0 })).toThrow()
  })
})

describe('private chunk envelope', () => {
  test('carries no plaintext hash and still detects tampering', () => {
    const key = generateRepositoryKey()
    const env = encryptPrivateChunk({ plaintext: new TextEncoder().encode('secret'), key, repoId: '0xab', keyEpoch: 0 })
    expect('plaintextHash' in env).toBe(false)
    expect(new TextDecoder().decode(decryptPrivateChunk(env, key))).toBe('secret')
    const bad = { ...env, keyEpoch: 1 }
    expect(() => decryptPrivateChunk(bad, key)).toThrow()
  })
})
