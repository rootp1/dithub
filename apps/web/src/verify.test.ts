import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { bundleHashOf, decodeLatestAttestation, decodeLatestRelease, evaluate, sha256Hex, SEL_LATEST_ATTESTATION, SEL_LATEST_RELEASE } from './verify.ts'

const dist = resolve(import.meta.dir, '../dist')
const word = (n: bigint | string) => (typeof n === 'bigint' ? n.toString(16) : n.replace(/^0x/, '')).padStart(64, '0')

test('sha256 known vector', async () => { expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') })
test('selectors match cast', () => {
  try {
    expect(execSync("cast sig 'latestRelease()'").toString().trim()).toBe(SEL_LATEST_RELEASE)
    expect(execSync("cast sig 'latestAttestation()'").toString().trim()).toBe(SEL_LATEST_ATTESTATION)
  } catch (e) { if (String(e).includes('not found')) return; throw e }
})
test('bundleHash matches real dist/build.json', async () => {
  const b = JSON.parse(readFileSync(resolve(dist, 'build.json'), 'utf8'))
  const actual: Record<string, string> = {}
  for (const n of Object.keys(b.files)) actual[n] = '0x' + (await sha256Hex(new Uint8Array(readFileSync(resolve(dist, n)))))
  expect(actual).toEqual(b.files)
  expect(await bundleHashOf(actual)).toBe(b.bundleHash)
  expect(await bundleHashOf({ 'style.css': 'x', 'app.js': 'y' })).toBe(await bundleHashOf({ 'app.js': 'y', 'style.css': 'x' }))
})
test('decodeLatestRelease', () => {
  const url = 'https://example.invalid/smoke', u = Buffer.from(url).toString('hex')
  const data = '0x' + [word(1n), word('11'.repeat(32)), word('ab'.repeat(32)), word(0xc0n), word(1700000000n), word('00'.repeat(12) + 'e5f2164bd59ba9f19fc76f1aa1e55199a159a16b'), word(BigInt(url.length)), u.padEnd(64, '0')].join('')
  const r = decodeLatestRelease(data)
  expect(r).toEqual({ id: 1, commit: '0x' + '11'.repeat(32), bundleHash: '0x' + 'ab'.repeat(32), url, publishedAt: 1700000000, publisher: '0xe5f2164bd59ba9f19fc76f1aa1e55199a159a16b' })
  expect(() => decodeLatestRelease('0x1234')).toThrow()
  expect(() => decodeLatestRelease('0x' + word(1n))).toThrow()
})
test('decodeLatestAttestation + evaluate', () => {
  const a = decodeLatestAttestation('0x' + word(2n) + word(1n) + word(1700000000n))
  expect(a).toEqual({ releaseId: 2, ok: true, observedAt: 1700000000 })
  const chain = { id: 2, commit: '0x1', bundleHash: '0xaa', url: '', publishedAt: 0, publisher: '0x' }
  const c = evaluate({ build: { bundleHash: '0xaa', files: { 'a.js': '0x01' } }, actual: { 'a.js': '0x01' }, local: '0xaa', chain, api: { bundleHash: '0xaa' }, att: a })
  expect(c.every((x) => x.status === 'pass')).toBe(true)
  const bad = evaluate({ build: { bundleHash: '0xaa', files: { 'a.js': '0x01' } }, actual: { 'a.js': '0x02' }, local: '0xbb', chain, api: null, att: null })
  expect(bad.slice(0, 3).map((x) => x.status)).toEqual(['fail', 'fail', 'fail'])
})
