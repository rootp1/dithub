import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { deviceKeyStatement, verifyDeviceKey } from '../../sdk/src/keys.ts'
import { deviceKeyPath, loadDeviceKey, newStoredDeviceKey, normalizeSignature, saveDeviceKey, signUrl } from '../src/cmd/keys.ts'

let dir: string
const prev = process.env.DIT_CONFIG_DIR
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dit-keys-')); process.env.DIT_CONFIG_DIR = join(dir, 'cfg') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.DIT_CONFIG_DIR; else process.env.DIT_CONFIG_DIR = prev })

describe('dit keys', () => {
  test('stores the device key 0600 and reads it back', () => {
    expect(loadDeviceKey()).toBeNull()
    const k = newStoredDeviceKey()
    const file = saveDeviceKey(k)
    expect(file).toBe(deviceKeyPath())
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'cfg')).mode & 0o777).toBe(0o700)
    expect(loadDeviceKey()).toEqual(k)
  })

  test('rejects a corrupted or mismatched key file', () => {
    const k = newStoredDeviceKey()
    saveDeviceKey({ ...k, publicKey: newStoredDeviceKey().publicKey })
    expect(() => loadDeviceKey()).toThrow('not a valid dit device key')
    writeFileSync(deviceKeyPath(), '{')
    expect(() => loadDeviceKey()).toThrow('not valid JSON')
  })

  test('sign url and signature parsing', () => {
    expect(signUrl('https://dithub.app', '0xab')).toBe('https://dithub.app/settings/device-keys?publicKey=0xab')
    const sig = `0x${'Ab'.repeat(65)}`
    expect(normalizeSignature(` ${sig.slice(2)}\n`)).toBe(sig.toLowerCase() as `0x${string}`)
    expect(() => normalizeSignature('0x1234')).toThrow()
  })

  test('a wallet signature over the printed statement verifies', async () => {
    const account = privateKeyToAccount(`0x${'33'.repeat(32)}`)
    const k = newStoredDeviceKey()
    const signature = await account.signMessage({ message: deviceKeyStatement(account.address, k.publicKey) })
    expect(await verifyDeviceKey({ wallet: account.address, publicKey: k.publicKey, signature: normalizeSignature(signature) })).toBe(true)
  })
})
