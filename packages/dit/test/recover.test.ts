import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { UsageError, DitError } from '../src/errors.ts'
import { attrString, parseRecoverArgs, recover, scrub, type Sdk } from '../src/cmd/recover.ts'
import { completion, TREE } from '../src/cmd/completion.ts'
import { helpTopics } from '../src/help.ts'

const H = '0x' + 'ab'.repeat(32)

describe('dit recover: arguments, scrubbing, flow (fake SDK)', () => {
  test('argument validation', () => {
    expect(() => parseRecoverArgs([], { ARKIV_ACCESS_KEY: 'k' })).toThrow(UsageError)
    expect(() => parseRecoverArgs(['nonsense'], { ARKIV_ACCESS_KEY: 'k' })).toThrow(UsageError)
    expect(() => parseRecoverArgs(['a/b', '--manifest-hash', '0x12'], { ARKIV_ACCESS_KEY: 'k' })).toThrow(/manifest-hash/)
    try { parseRecoverArgs(['a/b'], {}); throw new Error('no throw') } catch (e) { expect((e as UsageError).hint).toContain('hub.arkiv.network/access-keys') }
    const a = parseRecoverArgs(['a/b', 'out', '--manifest-hash', H.toUpperCase().replace('0X', '0x'), '--json'], { ARKIV_ACCESS_KEY: 'envkey' })
    expect(a).toMatchObject({ target: 'a/b', dir: 'out', manifestHash: H, accessKey: 'envkey', json: true })
    expect(parseRecoverArgs(['a/b', '--access-key', 'flagkey'], { ARKIV_ACCESS_KEY: 'envkey' }).accessKey).toBe('flagkey')
  })
  test('access key never survives in error text', () => {
    const key = 'sekret-access-key-1234567890abcdef'
    expect(scrub(`HTTP request failed. URL: https://rpc.arkiv.example/${key} body`, key)).not.toContain(key)
    expect(scrub('URL: https://rpc.arkiv.example/AbCdEfGhIjKlMnOpQrStUvWx', '')).toContain('***')
  })
  test('attribute normalisation', () => {
    expect(attrString({ value: 'x' })).toBe('x'); expect(attrString(new Uint8Array([1, 255]))).toBe('0x01ff'); expect(attrString(undefined)).toBe('')
  })

  const fake = (log: string[], over: Partial<Sdk> = {}): Sdk => ({
    connect: () => ({}),
    resolveName: async (_c, n) => { log.push(`name:${n}`); return H },
    newestPushManifest: async () => { log.push('newest'); return '0x' + 'cd'.repeat(32) },
    materialise: async ({ dest, manifestHash }) => {
      log.push(`materialise:${manifestHash.slice(0, 6)}`)
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
      spawnSync('git', ['init', '-q', '-b', 'main', dest], { env }); writeFileSync(join(dest, 'f'), 'x')
      spawnSync('git', ['-C', dest, 'add', '-A'], { env }); spawnSync('git', ['-C', dest, 'commit', '-qm', 'c'], { env })
      return { chunks: 3, objects: 5, name: 'n', sequence: 1 }
    },
    ...over,
  })
  test('resolves the name through Arkiv, picks the newest push, verifies with fsck', async () => {
    const log: string[] = [], dest = join(mkdtempSync(join(tmpdir(), 'dit-rec-')), 'out')
    const r = await recover({ target: 'a/b', dir: dest, accessKey: 'k', arkivOnly: true, json: true }, fake(log))
    expect(log).toEqual(['name:a/b', 'newest', 'materialise:0xcdcd'])
    expect(r).toMatchObject({ repoId: H, chunksVerified: 3, fsck: 'ok', manifestFrom: expect.stringContaining('newest trusted') })
    expect(String(r.commit)).toMatch(/^[0-9a-f]{40}$/)
    rmSync(dest, { recursive: true, force: true })
  })
  test('an explicit manifest hash skips the activity query', async () => {
    const log: string[] = [], dest = join(mkdtempSync(join(tmpdir(), 'dit-rec-')), 'out')
    await recover({ target: H, dir: dest, accessKey: 'k', arkivOnly: true, json: true, manifestHash: '0x' + '12'.repeat(32) }, fake(log))
    expect(log).toEqual(['materialise:0x1212'])
    rmSync(dest, { recursive: true, force: true })
  })
  test('failures clean up the destination, hide the key and explain access keys', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'dit-rec-')), 'out')
    const sdk = fake([], { materialise: async () => { throw new Error('HTTP request failed. Status: 401 URL: https://x/topsecretkey12345') } })
    try { await recover({ target: H, dir: dest, accessKey: 'topsecretkey12345', arkivOnly: true, json: true }, sdk); throw new Error('no throw') } catch (e) {
      expect(e).toBeInstanceOf(DitError); expect((e as DitError).message).not.toContain('topsecretkey12345'); expect((e as DitError).hint).toContain('access-keys')
    }
    expect(existsSync(dest)).toBe(false)
    await expect(recover({ target: 'a/b', dir: dest, accessKey: 'k', arkivOnly: true, json: true }, fake([], { resolveName: async () => null }))).rejects.toThrow(/no Arkiv name entity/)
    await expect(recover({ target: H, dir: dest, accessKey: 'k', arkivOnly: true, json: true }, fake([], { newestPushManifest: async () => null }))).rejects.toThrow(/no push with a code manifest/)
  })
  test('refuses an existing destination', async () => {
    await expect(recover({ target: H, dir: tmpdir(), accessKey: 'k', arkivOnly: true, json: true }, fake([]))).rejects.toThrow(/already exists/)
  })
})

describe('new commands are registered', () => {
  test('help topics and completion cover them', () => {
    for (const t of ['label', 'token', 'name', 'deployments', 'recover', 'verify']) expect(helpTopics).toContain(t)
    for (const [k, v] of Object.entries({ label: 'create', token: 'create', name: 'resolve', deployments: 'latest', repo: 'ledger', session: 'calls', issue: 'events', pr: 'comment', auth: 'username', verify: 'rebuild' })) expect(TREE[k]).toContain(v)
    expect(typeof completion).toBe('function')
  })
})

// ---- real production Arkiv (skipped without a key or network) ----
const key = process.env.ARKIV_ACCESS_KEY ?? ''
const net = key ? await fetch('https://dithub.app/api/health', { signal: AbortSignal.timeout(6000) }).then((r) => r.ok, () => false) : false
describe('dit recover against production Arkiv', () => {
  (net ? test : test.skip)('rootp1/smoke-mw4iu8wl is rebuilt from Arkiv alone and passes git fsck', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'dit-rec-')), 'out')
    const r = await recover({ target: 'rootp1/smoke-mw4iu8wl', dir: dest, accessKey: key, arkivOnly: true, json: true })
    expect(r.fsck).toBe('ok'); expect(r.manifestHash).toBe('0x9e83fe6bddd370eb5492bbf6494d441c79f80d8a74bc6702360fc666d9196be5')
    expect(r.commit).toBe('d2d078e5e1dd7179175abeb2c994372260fb2d49')
    expect(existsSync(join(dest, 'hello.txt'))).toBe(true)
    rmSync(dest, { recursive: true, force: true })
  }, 120_000)
})
