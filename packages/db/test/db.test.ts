import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SQL } from 'bun'
import { bool, hex, json, migrate, newId, now, openDb, parseJson, toHex } from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'dithub-db-'))
const quiet = { log: () => {} }
let sql: SQL

beforeAll(async () => {
  sql = openDb(join(dir, 'nested/test.sqlite'))
  await migrate(sql, quiet)
})
afterAll(async () => {
  await sql.close()
  rmSync(dir, { recursive: true, force: true })
})

const user = async (login: string) => Number((await sql`INSERT INTO users (login) VALUES (${login}) RETURNING id`)[0].id)
const repo = async (owner: number, name: string, dheet = newId().replace(/-/g, '').padEnd(64, '0')) =>
  Number((await sql`INSERT INTO repos (dheet_repo_id, owner_kind, owner_id, name) VALUES (${hex(dheet)}, 'user', ${owner}, ${name}) RETURNING id`)[0].id)

describe('schema', () => {
  test('applies on a fresh file with WAL, foreign keys and busy timeout', async () => {
    const tables = (await sql`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r: { name: string }) => r.name)
    for (const t of ['users', 'repos', 'pushes', 'commit_anchors', 'outbox', 'deployments', 'task_sessions', 'cli_device_codes',
      'siwe_nonces', 'access_tokens', 'device_keys', 'repo_keys', 'swarm_uploads', 'schema_migrations', 'rbac_events', 'repo_counters'])
      expect(tables).toContain(t)
    expect(tables).not.toContain('sessions')
    expect(tables).not.toContain('ens_seats')
    expect((await sql`PRAGMA journal_mode`)[0].journal_mode).toBe('wal')
    expect((await sql`PRAGMA foreign_keys`)[0].foreign_keys).toBe(1)
    expect((await sql`PRAGMA busy_timeout`)[0].timeout).toBe(5000)
    expect((await sql`PRAGMA foreign_key_check`).length).toBe(0)
  })

  test('migrate twice is a no-op', async () => {
    const before = await sql`SELECT name, applied_at FROM schema_migrations ORDER BY name`
    await migrate(sql, quiet)
    expect(await sql`SELECT name, applied_at FROM schema_migrations ORDER BY name`).toEqual(before)
    expect(before.map((r: { name: string }) => r.name)).toContain('schema.sql')
  })

  test('applies pending migrations-sqlite files once, in order, and rolls back failures', async () => {
    const mdir = join(dir, 'mig')
    mkdirSync(mdir)
    writeFileSync(join(mdir, '0002_b.sql'), 'ALTER TABLE extra ADD COLUMN b TEXT;')
    writeFileSync(join(mdir, '0001_a.sql'), 'CREATE TABLE extra (a INTEGER); INSERT INTO extra (a) VALUES (1);')
    const db = openDb(join(dir, 'mig.sqlite'))
    const seen: string[] = []
    await migrate(db, { dir: mdir, log: (m) => seen.push(m) })
    await migrate(db, { dir: mdir, log: (m) => seen.push(m) })
    expect(seen).toEqual(['applying schema.sql', 'applying 0001_a.sql', 'applying 0002_b.sql'])
    expect(await db`SELECT a, b FROM extra`).toEqual([{ a: 1, b: null }] as never)
    writeFileSync(join(mdir, '0003_bad.sql'), 'CREATE TABLE half (x INTEGER); INSERT INTO nope VALUES (1);')
    await expect(migrate(db, { dir: mdir, log: () => {} })).rejects.toThrow()
    expect(await db`SELECT name FROM sqlite_master WHERE name = 'half'`).toHaveLength(0)
    expect(await db`SELECT 1 FROM schema_migrations WHERE name = '0003_bad.sql'`).toHaveLength(0)
    await db.close()
  })

  test('deployments are keyed by (chain_id, id)', async () => {
    const row = (chain: number) => sql`INSERT INTO deployments (chain_id, id, "commit", bundle_hash, url) VALUES (${chain}, 1, ${hex('ab')}, ${hex('cd')}, 'https://x')`
    await row(8453)
    await row(11155111)
    await expect(row(8453)).rejects.toThrow()
  })

  test('commit_anchors accepts done_private and rejects unknown statuses', async () => {
    const u = await user('anchor-user')
    const r = await repo(u, 'anchored')
    const [p] = await sql`INSERT INTO pushes (repo_id, ref_name) VALUES (${r}, 'refs/heads/main') RETURNING id`
    await sql`INSERT INTO commits (repo_id, oid, tree_oid, authored_at, committed_at, message, subject) VALUES (${r}, ${hex('01')}, ${hex('02')}, ${now()}, ${now()}, 'm', 'm')`
    await sql`INSERT INTO commit_anchors (repo_id, commit_oid, push_id, ref_name, status) VALUES (${r}, ${hex('01')}, ${p.id}, 'refs/heads/main', 'done_private')`
    await expect(sql`INSERT INTO commit_anchors (repo_id, commit_oid, push_id, ref_name, status) VALUES (${r}, ${hex('01')}, ${p.id}, 'refs/heads/x', 'bogus')`).rejects.toThrow()
  })
})

describe('round trips', () => {
  test('blob in and out via hex/toHex', async () => {
    const u = await user('blob-user')
    const addr = '0x' + 'ab'.repeat(20)
    await sql`INSERT INTO wallets (user_id, address, verified_at) VALUES (${u}, ${hex(addr)}, ${now()})`
    const [w] = await sql`SELECT address, lower(hex(address)) AS h FROM wallets WHERE address = ${hex(addr)}`
    expect(toHex(w.address)).toBe(addr)
    expect(w.h).toBe('ab'.repeat(20))
    await expect(sql`INSERT INTO wallets (user_id, address, verified_at) VALUES (${u}, ${hex('abcd')}, ${now()})`).rejects.toThrow()
  })

  test('json and bool', async () => {
    const u = await user('json-user')
    const [o] = await sql`INSERT INTO outbox (aggregate_type, aggregate_id, kind, payload) VALUES ('repo', ${u}, 'push', ${json({ ref: 'main', n: 2 })}) RETURNING *`
    expect(parseJson<{ ref: string; n: number }>(o.payload)).toEqual({ ref: 'main', n: 2 })
    const [x] = await sql`SELECT json_extract(payload, '$.ref') AS ref FROM outbox WHERE id = ${o.id}`
    expect(x.ref).toBe('main')
    expect(o.status).toBe('pending')
    expect(o.next_attempt_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    const [r] = await sql`SELECT is_site_admin, token_version FROM users WHERE id = ${u}`
    expect(bool(r.is_site_admin)).toBe(false)
    expect(r.token_version).toBe(0)
    await sql`UPDATE users SET is_site_admin = ${1}, token_version = token_version + 1 WHERE id = ${u}`
    const [r2] = await sql`SELECT is_site_admin, token_version FROM users WHERE id = ${u}`
    expect(bool(r2.is_site_admin)).toBe(true)
    expect(Number(r2.token_version)).toBe(1)
  })

  test('RETURNING, uuid defaults and partial unique index', async () => {
    const u = await user('task-user')
    const r = await repo(u, 'tasks')
    const [i] = await sql`INSERT INTO issues (repo_id, number, title) VALUES (${r}, 1, 't') RETURNING id, state`
    expect(i.state).toBe('open')
    const ins = () => sql`INSERT INTO task_sessions (repo_id, issue_id, user_id, created_by, role, ref, expires_at) VALUES (${r}, ${i.id}, ${u}, ${u}, 'contractor', 'main', ${now(600_000)}) RETURNING id`
    const [s] = await ins()
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await expect(ins()).rejects.toThrow()
    await sql`UPDATE task_sessions SET status = 'ended' WHERE id = ${s.id}`
    await ins()
  })

  test('foreign keys are enforced and cascade', async () => {
    await expect(sql`INSERT INTO device_keys (user_id, public_key, signature) VALUES (999999, ${hex('aa')}, ${hex('bb')})`).rejects.toThrow()
    const u = await user('fk-user')
    const r = await repo(u, 'fk')
    await sql`INSERT INTO device_keys (user_id, public_key, signature) VALUES (${u}, ${hex('aa')}, ${hex('bb')})`
    await expect(sql`INSERT INTO device_keys (user_id, public_key, signature) VALUES (${u}, ${hex('aa')}, ${hex('cc')})`).rejects.toThrow()
    await sql`INSERT INTO repo_keys (repo_id, epoch, sealed) VALUES (${r}, 0, ${hex('ff')})`
    await expect(sql`INSERT INTO repo_keys (repo_id, epoch, sealed) VALUES (${r}, 0, ${hex('ee')})`).rejects.toThrow()
    const [up] = await sql`INSERT INTO swarm_uploads (repo_id, kind, reference, bytes, encrypted) VALUES (${r}, 'pack', ${'a'.repeat(64)}, 10, 1) RETURNING *`
    expect(bool(up.encrypted)).toBe(true)
    await sql`DELETE FROM repos WHERE id = ${r}`
    expect(await sql`SELECT * FROM repo_keys WHERE repo_id = ${r}`).toHaveLength(0)
    expect(await sql`SELECT * FROM swarm_uploads WHERE repo_id = ${r}`).toHaveLength(0)
    await sql`DELETE FROM users WHERE id = ${u}`
    expect(await sql`SELECT * FROM device_keys WHERE user_id = ${u}`).toHaveLength(0)
  })

  test('case-insensitive logins, transactions roll back', async () => {
    await user('CaseUser')
    await expect(user('caseuser')).rejects.toThrow()
    expect(await sql`SELECT login FROM users WHERE login = 'CASEUSER'`).toHaveLength(1)
    await sql.begin(async (tx) => {
      await tx`INSERT INTO siwe_nonces (nonce, expires_at) VALUES ('n1', ${now(60_000)})`
    })
    await expect(sql.begin(async (tx) => {
      await tx`INSERT INTO siwe_nonces (nonce, expires_at) VALUES ('n2', ${now()})`
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect((await sql`SELECT nonce FROM siwe_nonces ORDER BY nonce`).map((r: { nonce: string }) => r.nonce)).toEqual(['n1'])
  })
})

describe('helpers', () => {
  test('values', () => {
    expect(hex('0xABcd')).toEqual(Buffer.from([0xab, 0xcd]))
    expect(toHex(new Uint8Array([1, 2]))).toBe('0x0102')
    expect(toHex(null)).toBeNull()
    expect(now()).toMatch(/Z$/)
    expect(json(undefined)).toBe('null')
    expect(parseJson<number[]>('[1]')).toEqual([1])
    expect(parseJson(null)).toBeNull()
    expect(parseJson<{ a: number }>({ a: 1 })).toEqual({ a: 1 })
    expect([bool(1), bool(0), bool(1n), bool('t'), bool(null), bool(true)]).toEqual([true, false, true, true, false, true])
    expect(newId()).not.toBe(newId())
  })
})
