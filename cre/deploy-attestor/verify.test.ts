import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { commitMatches, computeBundleHash, judge, sha256Hex, type Observation } from './verify'

const dist = resolve(import.meta.dir, '../../apps/web/dist')
const real = existsSync(resolve(dist, 'build.json'))

describe('hashing', () => {
  test('sha256Hex matches node crypto', () => {
    const b = new TextEncoder().encode('dithub')
    expect(sha256Hex(b)).toBe('0x' + createHash('sha256').update(b).digest('hex'))
  })
  test('bundleHash sorts keys and uses compact JSON', () => {
    const a = computeBundleHash({ 'b.js': '0x2', 'a.js': '0x1' })
    const expected = '0x' + createHash('sha256').update('{"a.js":"0x1","b.js":"0x2"}').digest('hex')
    expect(a).toBe(expected)
  })
})

describe.skipIf(!real)('against real apps/web/dist build.json', () => {
  const bj = JSON.parse(readFileSync(resolve(dist, 'build.json'), 'utf-8'))
  const computed: Record<string, string> = {}
  for (const n of readdirSync(dist).filter((f) => f !== 'build.json')) computed[n] = sha256Hex(new Uint8Array(readFileSync(resolve(dist, n))))
  const obs: Observation = { commit: bj.commit, claimedBundleHash: bj.bundleHash, listed: Object.keys(bj.files).sort(), computed, claimed: bj.files }

  test('recomputed bundleHash equals build.json bundleHash', () => {
    expect(computeBundleHash(computed)).toBe(bj.bundleHash)
  })
  test('judge ok when registry matches', () => {
    const v = judge(obs, { commit: '0x' + '00'.repeat(32), bundleHash: bj.bundleHash })
    expect(v.ok).toBe(true)
    expect(v.filesMatchBuildJson && v.buildJsonSelfConsistent).toBe(true)
  })
  test('judge not ok when registry bundleHash differs', () => {
    const v = judge(obs, { commit: '0x' + '00'.repeat(32), bundleHash: '0x' + '11'.repeat(32) })
    expect(v.ok).toBe(false)
  })
  test('judge not ok when served bytes are tampered', () => {
    const t = { ...obs, computed: { ...computed, 'app.js': sha256Hex(new Uint8Array([1])) } }
    const v = judge(t, { commit: '0x00', bundleHash: bj.bundleHash })
    expect(v.ok).toBe(false)
    expect(v.filesMatchBuildJson).toBe(false)
  })
})

describe('commitMatches', () => {
  const sha = 'a'.repeat(40)
  test('20-byte sha left or right aligned', () => {
    expect(commitMatches(sha, '0x' + sha.padEnd(64, '0'))).toBe(true)
    expect(commitMatches(sha.toUpperCase(), '0x' + sha.padStart(64, '0'))).toBe(true)
  })
  test('utf8 label', () => {
    expect(commitMatches('dev', '0x' + Buffer.from('dev').toString('hex').padEnd(64, '0'))).toBe(true)
  })
  test('different', () => expect(commitMatches(sha, '0x' + '00'.repeat(32))).toBe(false))
})

test('fetch error yields ok=false', () => {
  const v = judge({ commit: '', claimedBundleHash: '', listed: [], computed: {}, claimed: {}, error: 'HTTP 404' }, { commit: '0x00', bundleHash: '0x' + '11'.repeat(32) })
  expect(v.ok).toBe(false)
})
