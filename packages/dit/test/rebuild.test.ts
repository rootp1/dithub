import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { UsageError, DitError } from '../src/errors.ts'
import { SEL, l1 } from '../src/constants.ts'
process.env.DIT_NETWORK = 'sepolia'   // the integration tests below replay real Sepolia release 2 (DeployRegistry redeployed 2026-11-07)
import { bundleHashOf, sha256 } from '../src/cmd/verify.ts'
import { chooseSandbox, decodeCommit, decodeGetRelease, diffFiles, emptyBuildEnv, parseRebuildArgs, pinnedBunVersion, rebuild, rehashDist, type RebuildOpts } from '../src/cmd/rebuild.ts'

describe('rebuild: pure parts', () => {
  test('decodeCommit takes the right-aligned 20-byte sha', () => {
    const sha = '76b7afaa2b846a5a1d597ec24e22bb1646730a09'
    expect(decodeCommit('0x' + '0'.repeat(24) + sha)).toBe(sha)
    expect(() => decodeCommit('0x' + 'f'.repeat(64))).toThrow(DitError)
    expect(() => decodeCommit('0x12')).toThrow(DitError)
  })
  test('selectors and getRelease decoding', () => {
    expect(SEL.selGetRelease).toBe('0x79af2b9a'); expect(SEL.selReleaseCount).toBe('0xb8d08db2')
    const w = (n: number) => n.toString(16).padStart(64, '0')
    const url = Buffer.from('https://x.y').toString('hex').padEnd(64, '0')
    const r = decodeGetRelease(4, '0x' + '0'.repeat(24) + 'ab'.repeat(20) + 'bb'.repeat(32) + w(160) + w(1700000000) + w(0x99) + w(11) + url)
    expect(r.id).toBe(4); expect(r.url).toBe('https://x.y'); expect(r.bundleHash).toBe('0x' + 'bb'.repeat(32)); expect(r.publishedAt).toBe(1700000000)
  })
  test('bundleHash recomputation from a dist directory (build.json excluded, keys sorted)', () => {
    const d = mkdtempSync(join(tmpdir(), 'dit-rb-'))
    writeFileSync(join(d, 'b.js'), 'bb'); writeFileSync(join(d, 'a.html'), 'aa'); writeFileSync(join(d, 'build.json'), '{"bundleHash":"0xbad"}')
    const r = rehashDist(d)
    expect(Object.keys(r.files)).toEqual(['a.html', 'b.js'])
    expect(r.bundleHash).toBe(bundleHashOf({ 'a.html': sha256('aa'), 'b.js': sha256('bb') }))
    mkdirSync(join(d, 'sub'))
    expect(() => rehashDist(d)).toThrow(/non-file/)
    rmSync(d, { recursive: true, force: true })
  })
  test('mismatch reporting names the differing files', () => {
    const a = { 'app.js': '0x1', 'index.html': '0x2', 'x.css': '0x3' }, b = { 'app.js': '0x9', 'index.html': '0x2', 'y.css': '0x4' }
    expect(diffFiles(a, b)).toEqual([{ name: 'app.js', rebuilt: '0x1', other: '0x9' }, { name: 'x.css', rebuilt: '0x3', other: null }, { name: 'y.css', rebuilt: null, other: '0x4' }])
    expect(diffFiles(a, { ...a })).toEqual([])
  })
  test('argument validation', () => {
    expect(() => parseRebuildArgs(['--release', '1', '--commit', 'a'.repeat(40)])).toThrow(UsageError)
    expect(() => parseRebuildArgs(['--release', '0'])).toThrow(UsageError)
    expect(() => parseRebuildArgs(['--commit', 'abc'])).toThrow(UsageError)
    expect(() => parseRebuildArgs(['--sandbox', 'vm'])).toThrow(UsageError)
    expect(() => parseRebuildArgs(['--sandbox', 'none'])).toThrow(/unsafe-local-build/)
    expect(() => parseRebuildArgs(['--sandbox', 'docker', '--unsafe-local-build'])).toThrow(UsageError)
    const o = parseRebuildArgs(['--release', '3', '--sandbox', 'none', '--unsafe-local-build', '--json'], {})
    expect(o).toMatchObject({ release: 3, sandbox: 'none', unsafeLocalBuild: true, json: true, source: 'https://github.com/rootp1/dithub-base.git' })
    expect(parseRebuildArgs([], { DIT_SOURCE_REPO: '/x' }).source).toBe('/x')
    expect(parseRebuildArgs(['--source', '/y'], { DIT_SOURCE_REPO: '/x' }).source).toBe('/y')
  })
  test('refuses without docker unless both flags are given', () => {
    expect(() => chooseSandbox({ sandbox: 'auto', unsafeLocalBuild: false, dockerAvailable: false })).toThrow(/refusing/)
    expect(() => chooseSandbox({ sandbox: 'auto', unsafeLocalBuild: true, dockerAvailable: false })).toThrow(/refusing/)
    expect(() => chooseSandbox({ sandbox: 'none', unsafeLocalBuild: false, dockerAvailable: true })).toThrow(UsageError)
    expect(() => chooseSandbox({ sandbox: 'docker', unsafeLocalBuild: false, dockerAvailable: false })).toThrow(DitError)
    expect(chooseSandbox({ sandbox: 'auto', unsafeLocalBuild: false, dockerAvailable: true })).toBe('docker')
    expect(chooseSandbox({ sandbox: 'none', unsafeLocalBuild: true, dockerAvailable: true })).toBe('none')
  })
  test('empty build environment carries no inherited secrets', () => {
    process.env.DHEET_SEAT_KEY = 'secret'
    const env = emptyBuildEnv('a'.repeat(40), '/tmp/h', '/usr/bin')
    expect(Object.keys(env).sort()).toEqual(['GIT_COMMIT', 'HOME', 'PATH'])
    expect(JSON.stringify(env)).not.toContain('secret')
    delete process.env.DHEET_SEAT_KEY
  })
  test('pinned bun version is read from ci.yml', () => {
    expect(pinnedBunVersion('  with:\n    bun-version: 1.4.4\n')).toBe('1.4.4')
    expect(pinnedBunVersion('nothing')).toBeNull()
  })
})

// ---- integration against Sepolia (skipped when the RPC is unreachable) ----
const repoRoot = resolve(import.meta.dir, '../../..')
const reach = await fetch(l1().rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(8000) }).then((r) => r.ok, () => false)
const hasCommit = Bun.spawnSync(['git', 'cat-file', '-e', '76b7afaa2b846a5a1d597ec24e22bb1646730a09^{commit}'], { cwd: repoRoot }).exitCode === 0
const it = reach && hasCommit ? test : test.skip
// No explicit site: release 2 may be superseded, so the live site may legitimately serve a newer release (reported as WARN, not FAIL).
const base: RebuildOpts = { release: 2, source: repoRoot, sandbox: 'none', unsafeLocalBuild: true, json: false }

describe('rebuild: release 2 against Sepolia', () => {
  it('MATCH: source == on-chain release == live site', async () => {
    const r = await rebuild(base)
    expect(r.rows.filter((x) => x.status === 'FAIL')).toEqual([])
    expect(r.data.match).toBe(true)
    expect(r.rows.find((x) => x.check === 'source == on-chain release')?.detail).toBe('MATCH')
  }, 180_000)
  it('MISMATCH: a deliberately modified file is detected and named', async () => {
    // The "live site" is stubbed with the genuine release-2 build, so only the tampered app.js differs and must be named.
    let genuine: ReturnType<typeof rehashDist> | undefined
    const r = await rebuild({ ...base, site: 'https://stub.invalid' }, {
      rehash: (dir) => {
        genuine = rehashDist(dir)
        const copy = mkdtempSync(join(tmpdir(), 'dit-tamper-'))
        for (const f of readdirSync(dir)) copyFileSync(join(dir, f), join(copy, f))
        writeFileSync(join(copy, 'app.js'), 'console.log("tampered")')
        try { return rehashDist(copy) } finally { rmSync(copy, { recursive: true, force: true }) }
      },
      fetchLive: async () => genuine!,
    })
    expect(r.ok).toBe(false)
    expect(r.rows.find((x) => x.check === 'source == on-chain release')?.status).toBe('FAIL')
    expect(r.rows.some((x) => x.check.trim() === 'file app.js' && x.status === 'FAIL')).toBe(true)
  }, 180_000)
  it('unknown release and unknown commit fail clearly', async () => {
    await expect(rebuild({ ...base, release: 99999 })).rejects.toThrow(/does not exist/)
    await expect(rebuild({ ...base, release: undefined as never, commit: 'f'.repeat(40) })).rejects.toThrow(/no on-chain release/)
  }, 120_000)
})
