import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse, csv, intArg } from '../src/args.ts'
import { UsageError, DitError, describeApiError } from '../src/errors.ts'
import { parseRepoRef } from '../src/git.ts'
import { splitCloneArgs } from '../src/cmd/clone.ts'
import { credentialResponse, parseCredentialInput } from '../src/cmd/credential.ts'
import { extractTar, checkMemberPath, parseTar } from '../src/tar.ts'
import { table, stripAnsi, countdown, ago, trunc } from '../src/ui.ts'
import { configDir, deleteCredential, findToken, normalizeHost, saveCredential, primaryHost } from '../src/config.ts'
import { SEPOLIA } from '../src/constants.ts'
import { bundleHashOf, decodeLatestAttestation, decodeLatestRelease } from '../src/cmd/verify.ts'
import { completion } from '../src/cmd/completion.ts'
import { main } from '../src/cli.ts'
import { editText } from '../src/editor.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'dit-unit-'))

describe('argument parsing', () => {
  test('known and global options', () => {
    const p = parse(['view', '3', '--json', '-R', 'a/b', '--comments'], { comments: { type: 'boolean' } })
    expect(p.positionals).toEqual(['view', '3'])
    expect(p.values.json).toBe(true)
    expect(p.values.repo).toBe('a/b')
  })
  test('unknown option is a usage error (exit 2)', () => {
    try { parse(['--nope']); throw new Error('no throw') } catch (e) { expect(e).toBeInstanceOf(UsageError); expect((e as UsageError).code).toBe(2) }
  })
  test('csv / intArg', () => {
    expect(csv(['a,b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(intArg('#12', 'n')).toBe(12)
    expect(() => intArg('x', 'n')).toThrow(UsageError)
  })
  test('clone args: values of flags are not mistaken for target/dir', () => {
    expect(splitCloneArgs(['alice/web', '--depth', '1', '-b', 'dev', 'out', '--quiet'])).toEqual({ target: 'alice/web', dir: 'out', passthrough: ['--depth', '1', '-b', 'dev', '--quiet'] })
    expect(splitCloneArgs(['--branch=x', 'a/b']).target).toBe('a/b')
  })
})

describe('repo inference from remote URLs', () => {
  const cases: Array<[string, unknown]> = [
    ['alice/web', { origin: null, owner: 'alice', repo: 'web' }],
    ['alice/web.git', { origin: null, owner: 'alice', repo: 'web' }],
    ['alice/web@https://h.example.com', { origin: 'https://h.example.com', owner: 'alice', repo: 'web' }],
    ['alice/web@localhost:3300', { origin: 'http://localhost:3300', owner: 'alice', repo: 'web' }],
    ['https://h.example.com/git/alice/web', { origin: 'https://h.example.com', owner: 'alice', repo: 'web' }],
    ['https://h.example.com/git/alice/web.git', { origin: 'https://h.example.com', owner: 'alice', repo: 'web' }],
    ['http://localhost:3300/git/alice/web.git/', { origin: 'http://localhost:3300', owner: 'alice', repo: 'web' }],
    ['https://user:secret@h.example.com/git/alice/web.git', { origin: 'https://h.example.com', owner: 'alice', repo: 'web' }],
    ['https://h.example.com/alice/web', { origin: 'https://h.example.com', owner: 'alice', repo: 'web' }],
    ['git@h.example.com:alice/web.git', { origin: null, owner: 'alice', repo: 'web' }],
    ['git@h.example.com:git/alice/web', { origin: null, owner: 'alice', repo: 'web' }],
    ['ssh://git@h.example.com/alice/web.git', { origin: null, owner: 'alice', repo: 'web' }],
  ]
  for (const [input, want] of cases) test(input, () => expect(parseRepoRef(input)).toEqual(want as never))
  test('rejects nonsense', () => {
    for (const bad of ['', 'justaname', 'a/b/c', 'https://h.example.com/', 'https://h.example.com/git/only', 'ftp://h/a/b', '../x/y']) expect(parseRepoRef(bad)).toBeNull()
  })
  test('userinfo never survives in the parsed result', () => {
    expect(JSON.stringify(parseRepoRef('https://u:pw@h.example.com/git/a/b'))).not.toContain('pw')
  })
})

describe('git credential helper protocol', () => {
  const lookup = (o: string) => (o === 'https://h.example.com' ? 'dht_secret' : null)
  test('parses key=value lines', () => {
    expect(parseCredentialInput('protocol=https\nhost=h.example.com\n\n')).toEqual({ protocol: 'https', host: 'h.example.com' })
  })
  test('answers for the configured host', () => {
    expect(credentialResponse({ protocol: 'https', host: 'h.example.com' }, lookup)).toBe('username=dit\npassword=dht_secret\n')
  })
  test('stays silent for other hosts, schemes and ports', () => {
    expect(credentialResponse({ protocol: 'https', host: 'github.com' }, lookup)).toBeNull()
    expect(credentialResponse({ protocol: 'http', host: 'h.example.com' }, lookup)).toBeNull()
    expect(credentialResponse({ protocol: 'https', host: 'h.example.com:8443' }, lookup)).toBeNull()
    expect(credentialResponse({ protocol: 'ssh', host: 'h.example.com' }, lookup)).toBeNull()
    expect(credentialResponse({ host: 'h.example.com' }, lookup)).toBeNull()
  })
  test('refuses non-git paths when git sends one', () => {
    expect(credentialResponse({ protocol: 'https', host: 'h.example.com', path: 'api/me' }, lookup)).toBeNull()
    expect(credentialResponse({ protocol: 'https', host: 'h.example.com', path: 'git/a/b' }, lookup)).not.toBeNull()
  })
})

// ---- tar helpers ----
function header(name: string, type: string, size = 0, link = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write(link, 157); h.write('ustar\0', 257); h.write('00', 263)
  let sum = 0; for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}
function tar(entries: Array<{ name: string; type?: string; data?: string; link?: string }>): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '')
    parts.push(header(e.name, e.type ?? '0', data.length, e.link ?? ''))
    if (data.length) { parts.push(data); parts.push(Buffer.alloc((512 - (data.length % 512)) % 512)) }
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

describe('tar extraction safety', () => {
  let dir: string
  beforeAll(() => { dir = tmp() })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const fresh = () => join(tmp(), 'out')

  test('extracts normal files and directories', () => {
    const out = fresh()
    extractTar(tar([{ name: 'src/', type: '5' }, { name: 'src/a.ts', data: 'hello' }, { name: 'README.md', data: 'x' }]), out)
    expect(readFileSync(join(out, 'src/a.ts'), 'utf8')).toBe('hello')
  })
  test('rejects ../ traversal', () => {
    const out = fresh()
    expect(() => extractTar(tar([{ name: '../evil.txt', data: 'x' }]), out)).toThrow(DitError)
    expect(() => extractTar(tar([{ name: 'a/../../evil.txt', data: 'x' }]), out)).toThrow(DitError)
    expect(existsSync(join(out, '..', 'evil.txt'))).toBe(false)
  })
  test('rejects absolute paths', () => {
    expect(() => extractTar(tar([{ name: '/etc/passwd', data: 'x' }]), fresh())).toThrow(/absolute/)
  })
  test('rejects .git entries, backslashes and empty segments', () => {
    for (const n of ['.git/config', 'a/.GIT/hooks/x', 'a\\b', 'a//b']) expect(() => checkMemberPath(n)).toThrow(DitError)
  })
  test('rejects symlinks that escape (relative and absolute)', () => {
    expect(() => extractTar(tar([{ name: 'l', type: '2', link: '../../etc' }]), fresh())).toThrow(/escapes/)
    expect(() => extractTar(tar([{ name: 'l', type: '2', link: '/etc' }]), fresh())).toThrow(/absolute/)
    expect(() => extractTar(tar([{ name: 'a/l', type: '2', link: '../../x' }]), fresh())).toThrow(DitError)
  })
  test('allows a symlink that stays inside, but not writing through it', () => {
    const out = fresh()
    extractTar(tar([{ name: 'real/', type: '5' }, { name: 'real/f', data: 'x' }, { name: 'ln', type: '2', link: 'real' }]), out)
    expect(readFileSync(join(out, 'ln/f'), 'utf8')).toBe('x')
    expect(() => extractTar(tar([{ name: 'ln', type: '2', link: '.' }, { name: 'ln/x', data: 'y' }]), fresh())).toThrow(/symlink/)
  })
  test('rejects hardlinks, devices and duplicates', () => {
    expect(() => extractTar(tar([{ name: 'h', type: '1', link: 'x' }]), fresh())).toThrow(/unsupported/)
    expect(() => extractTar(tar([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]), fresh())).toThrow(/twice/)
  })
  test('nothing is written when any entry is bad', () => {
    const out = fresh()
    expect(() => extractTar(tar([{ name: 'ok.txt', data: 'x' }, { name: '../bad', data: 'y' }]), out)).toThrow()
    expect(existsSync(out)).toBe(false)
  })
  test('corrupt headers are rejected', () => {
    const b = tar([{ name: 'a', data: 'x' }]); b[0] = 0x41
    expect(() => parseTar(b)).toThrow(/checksum/)
  })
  test('real `git archive` output (long paths use pax headers)', () => {
    const repo = tmp(), env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const run = (...a: string[]) => spawnSync('git', a, { cwd: repo, env })
    run('init', '-q', '-b', 'main')
    const longDir = 'd'.repeat(60) + '/' + 'e'.repeat(60)
    mkdirSync(join(repo, longDir), { recursive: true })
    writeFileSync(join(repo, longDir, 'file.txt'), 'long')
    writeFileSync(join(repo, 'a.sh'), '#!/bin/sh\n', { mode: 0o755 })
    symlinkSync('a.sh', join(repo, 'link'))
    run('add', '-A'); run('commit', '-qm', 'x')
    const tarball = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo, maxBuffer: 1e8 }).stdout
    const out = fresh()
    extractTar(tarball, out)
    expect(readFileSync(join(out, longDir, 'file.txt'), 'utf8')).toBe('long')
    expect(statSync(join(out, 'a.sh')).mode & 0o111).toBeTruthy()
    expect(readdirSync(out).sort()).toEqual(['a.sh', 'd'.repeat(60), 'link'])
  })
})

describe('formatting', () => {
  test('table aligns columns and ignores colour codes', () => {
    const t = stripAnsi(table(['A', 'LONGER'], [['x', 'y'], ['\x1b[31mred\x1b[0m', 'z']]))
    expect(t.split('\n')).toEqual(['A    LONGER', 'x    y', 'red  z'])
  })
  test('countdown / ago / trunc', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(countdown('2026-01-01T01:30:10Z', now)).toBe('1h 30m left')
    expect(countdown('2025-12-31T00:00:00Z', now)).toBe('expired')
    expect(ago('2025-12-31T22:00:00Z', now)).toBe('2h ago')
    expect(trunc('abcdef', 4)).toBe('abc…')
  })
  test('JSON output is plain JSON', () => {
    expect(JSON.parse(JSON.stringify([{ a: 1 }], null, 2))).toEqual([{ a: 1 }])
  })
  test('no colour when stdout is not a TTY', async () => {
    const { c } = await import('../src/ui.ts')
    expect(c.red('x')).toBe('x')
  })
})

describe('error mapping', () => {
  test('401 suggests dit login', () => expect(describeApiError(401, 'sign in first').hint).toMatch(/dit login/))
  test('403 / 404 / 409 / 422 carry the server reason', () => {
    expect(describeApiError(403, 'only maintainers can create sessions').message).toContain('only maintainers can create sessions')
    expect(describeApiError(404, 'not found').message).toContain('not found')
    expect(describeApiError(409, 'cannot merge', { blockers: ['needs 1 approval'] }).message).toContain('needs 1 approval')
    expect(describeApiError(422, 'patch touches files outside the session scope', { paths: ['src/secret.ts'] }).message).toContain('src/secret.ts')
    expect(describeApiError(503, 'x').hint).toBeTruthy()
  })
})

describe('credentials storage', () => {
  const dir = join(tmp(), 'cfg')
  const saved = { ...process.env }
  beforeAll(() => { process.env.DIT_CONFIG_DIR = dir; delete process.env.DIT_TOKEN; delete process.env.DIT_HOST })
  afterAll(() => { process.env = saved })
  test('config dir precedence', () => {
    expect(configDir({ DIT_CONFIG_DIR: '/a', XDG_CONFIG_HOME: '/b', HOME: '/h' })).toBe('/a')
    expect(configDir({ XDG_CONFIG_HOME: '/b', HOME: '/h' })).toBe('/b/dit')
    expect(configDir({ HOME: '/h' })).toBe('/h/.config/dit')
  })
  test('file is 0600 and directory 0700; per-host lookup; delete', () => {
    saveCredential('http://localhost:3300/', { token: 'dht_x', login: 'alice' })
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(findToken('http://localhost:3300')?.token).toBe('dht_x')
    expect(findToken('https://other.example.com')).toBeNull()
    expect(deleteCredential('http://localhost:3300')).toBe(true)
    expect(findToken('http://localhost:3300')).toBeNull()
  })
  test('DIT_TOKEN applies to the primary host only', () => {
    process.env.DIT_HOST = 'https://ci.example.com'; process.env.DIT_TOKEN = 'dht_env'
    expect(findToken('https://ci.example.com')?.source).toBe('env')
    expect(findToken('https://elsewhere.example.com')).toBeNull()
    delete process.env.DIT_TOKEN; delete process.env.DIT_HOST
  })
  test('host precedence and normalisation', () => {
    rmSync(join(dir, 'config.json'), { force: true })
    expect(primaryHost()).toBe('https://dithub.app')
    process.env.DIT_HOST = 'localhost:3300'
    expect(primaryHost()).toBe('http://localhost:3300')
    expect(primaryHost('example.com/')).toBe('https://example.com')
    delete process.env.DIT_HOST
    expect(() => normalizeHost('ftp://x')).toThrow(UsageError)
  })
})

describe('verify helpers and constants', () => {
  test('contract constants match deployments/sepolia.json', () => {
    const d = JSON.parse(readFileSync(new URL('../../../deployments/sepolia.json', import.meta.url), 'utf8'))
    expect(SEPOLIA.registry).toBe(d.contracts.DeployRegistry.address)
    expect(SEPOLIA.attestations).toBe(d.contracts.DeployAttestations.address)
    expect(SEPOLIA.chainId).toBe(d.chainId)
  })
  test('bundleHashOf sorts keys (matches apps/web/build.ts)', () => {
    expect(bundleHashOf({ b: '0x2', a: '0x1' })).toBe(bundleHashOf({ a: '0x1', b: '0x2' }))
    expect(bundleHashOf({ a: '0x1' })).toMatch(/^0x[0-9a-f]{64}$/)
  })
  test('ABI decoding', () => {
    const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0')
    const url = Buffer.from('https://x.y').toString('hex').padEnd(64, '0')
    const data = '0x' + w(3) + 'aa'.repeat(32) + 'bb'.repeat(32) + w(192) + w(1700000000) + w(0x1234) + w(11) + url
    const r = decodeLatestRelease(data)
    expect(r.id).toBe(3); expect(r.url).toBe('https://x.y'); expect(r.bundleHash).toBe('0x' + 'bb'.repeat(32)); expect(r.publisher.endsWith('1234')).toBe(true)
    expect(decodeLatestAttestation('0x' + w(3) + w(1) + w(99))).toEqual({ releaseId: 3, ok: true, observedAt: 99 })
    expect(() => decodeLatestRelease('0x12')).toThrow()
  })
})

describe('router', () => {
  test('completion scripts mention commands', () => {
    const w = process.stdout.write.bind(process.stdout); let buf = ''
    process.stdout.write = ((s: string) => { buf += s; return true }) as never
    try { completion(['bash']); completion(['zsh']) } finally { process.stdout.write = w }
    expect(buf).toContain('complete -F _dit dit'); expect(buf).toContain('#compdef dit'); expect(buf).toContain('session')
    expect(() => completion(['fish'])).toThrow(UsageError)
  })
  test('help for every command exits 0', async () => {
    const { helpTopics } = await import('../src/help.ts')
    const w = console.log; console.log = () => {}
    try { for (const t of helpTopics) expect(await main([t, '--help'])).toBe(0) } finally { console.log = w }
  })
  test('editor refuses without a TTY', () => { expect(() => editText('x')).toThrow(/terminal/) })
})
