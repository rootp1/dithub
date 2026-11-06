import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDb } from '../packages/db/src/index.ts'
import { convertValue, copyDatabase, parsePgArray, type PgColumn, type PgSource } from './pg-to-sqlite.ts'

const dir = mkdtempSync(join(tmpdir(), 'pg-to-sqlite-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const col = (name: string, dataType: string, udtName = dataType): PgColumn => ({ name, dataType, udtName })
const b = (h: string) => Buffer.from(h, 'hex')
const ts = new Date('2025-03-04T05:06:07.089Z')

// Shaped like what Bun's Postgres driver returns for the old schema.
const fixture: Record<string, { cols: PgColumn[]; rows: Record<string, unknown>[] }> = {
  users: {
    cols: [col('id', 'bigint', 'int8'), col('login', 'USER-DEFINED', 'citext'), col('is_site_admin', 'boolean', 'bool'), col('created_at', 'timestamp with time zone', 'timestamptz')],
    rows: [{ id: '1', login: 'Alice', is_site_admin: true, created_at: ts }, { id: '7', login: 'bob', is_site_admin: false, created_at: ts }],
  },
  wallets: {
    cols: [col('id', 'bigint', 'int8'), col('user_id', 'bigint', 'int8'), col('address', 'bytea'), col('is_primary', 'boolean', 'bool'), col('verified_at', 'timestamp with time zone', 'timestamptz')],
    rows: [{ id: '1', user_id: '1', address: b('11'.repeat(20)), is_primary: true, verified_at: ts }],
  },
  repos: {
    cols: [col('id', 'bigint', 'int8'), col('dheet_repo_id', 'bytea'), col('owner_kind', 'USER-DEFINED', 'owner_kind'), col('owner_id', 'bigint', 'int8'), col('name', 'USER-DEFINED', 'citext'), col('topics', 'ARRAY', '_text'), col('is_archived', 'boolean', 'bool')],
    rows: [{ id: '3', dheet_repo_id: b('ab'.repeat(32)), owner_kind: 'user', owner_id: '1', name: 'web', topics: ['git', 'arkiv'], is_archived: false }],
  },
  commits: {
    cols: [col('repo_id', 'bigint', 'int8'), col('oid', 'bytea'), col('tree_oid', 'bytea'), col('parent_oids', 'ARRAY', '_bytea'), col('authored_at', 'timestamp with time zone', 'timestamptz'),
      col('committed_at', 'timestamp with time zone', 'timestamptz'), col('message', 'text'), col('subject', 'text')],
    rows: [{ repo_id: '3', oid: b('01'.repeat(20)), tree_oid: b('02'.repeat(20)), parent_oids: [b('03'.repeat(20)), b('04'.repeat(20))], authored_at: ts, committed_at: ts, message: 'm', subject: 's' }],
  },
  audit_log: {
    cols: [col('id', 'bigint', 'int8'), col('action', 'text'), col('ip', 'inet'), col('metadata', 'jsonb')],
    rows: [{ id: '5', action: 'repo.create', ip: '10.0.0.1', metadata: { session: 'x', n: 2 } }],
  },
  deployments: {
    cols: [col('chain_id', 'bigint', 'int8'), col('id', 'bigint', 'int8'), col('commit', 'bytea'), col('bundle_hash', 'bytea'), col('url', 'text'), col('attested', 'boolean', 'bool')],
    rows: [{ chain_id: '11155111', id: '1', commit: b('aa'.repeat(20)), bundle_hash: b('bb'.repeat(32)), url: 'https://dithub.app', attested: true }],
  },
  orgs: {
    cols: [col('id', 'bigint', 'int8'), col('login', 'USER-DEFINED', 'citext'), col('ens_name', 'text'), col('created_by', 'bigint', 'int8')],
    rows: [{ id: '2', login: 'acme', ens_name: 'acme.eth', created_by: '1' }],
  },
  sessions: { cols: [col('id', 'bytea'), col('user_id', 'bigint', 'int8')], rows: [{ id: b('ff'), user_id: '1' }] },
  ens_seats: { cols: [col('id', 'bigint', 'int8')], rows: [{ id: '1' }] },
}

const source: PgSource = {
  async tables() { return Object.keys(fixture).sort() },
  async columns(t) { return fixture[t]!.cols },
  async *rows(t, cols, pageSize) {
    const rows = fixture[t]!.rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])))
    for (let i = 0; i < rows.length; i += pageSize) yield rows.slice(i, i + pageSize)
  },
}

describe('convertValue', () => {
  test('maps Postgres types to the SQLite dialect', () => {
    expect(convertValue(true, col('x', 'boolean'))).toBe(1)
    expect(convertValue(false, col('x', 'boolean'))).toBe(0)
    expect(convertValue(ts, col('x', 'timestamp with time zone'))).toBe('2025-03-04T05:06:07.089Z')
    expect(convertValue('2025-03-04 05:06:07.089+00', col('x', 'timestamp with time zone'))).toBe('2025-03-04T05:06:07.089Z')
    expect(convertValue({ a: [1] }, col('x', 'jsonb'))).toBe('{"a":[1]}')
    expect(convertValue('plain', col('x', 'jsonb'))).toBe('"plain"')
    expect(convertValue(['a', 'b'], col('x', 'ARRAY', '_text'))).toBe('["a","b"]')
    expect(convertValue([b('0a0b')], col('x', 'ARRAY', '_bytea'))).toBe('["0a0b"]')
    expect(convertValue('\\x0a0b', col('x', 'bytea'))).toEqual(b('0a0b'))
    expect(convertValue(new Uint8Array([1, 2]), col('x', 'bytea'))).toEqual(b('0102'))
    expect(convertValue(null, col('x', 'jsonb'))).toBeNull()
    expect(convertValue('10.0.0.1', col('x', 'inet'))).toBe('10.0.0.1')
  })
  test('parses text array literals', () => {
    expect(parsePgArray('{a,"b,c",NULL,"NULL"}')).toEqual(['a', 'b,c', null, 'NULL'])
    expect(parsePgArray('{}')).toEqual([])
    expect(convertValue('{x,y}', col('x', 'ARRAY', '_text'))).toBe('["x","y"]')
  })
})

describe('copyDatabase', () => {
  const path = join(dir, 'copy.sqlite')
  test('copies every table with conversions, skips sessions, and is idempotent', async () => {
    const lite = openDb(path)
    await migrate(lite, { log: () => {} })
    const first = await copyDatabase(source, lite, { pageSize: 1 })
    const second = await copyDatabase(source, lite)
    expect(second.tables).toEqual(first.tables)
    expect(first.skipped.sort()).toEqual(['ens_seats', 'sessions'])
    expect(first.droppedColumns).toContain('orgs.ens_name')
    expect(first.newTables).toContain('device_keys')
    expect(first.fkViolations).toBe(0)
    for (const t of first.tables) expect(t.target).toBe(t.source)

    const [u] = await lite`SELECT * FROM users WHERE login = 'alice'`
    expect(u.is_site_admin).toBe(1)
    expect(u.token_version).toBe(0)
    expect(u.created_at).toBe('2025-03-04T05:06:07.089Z')
    const [r] = await lite`SELECT topics, dheet_repo_id FROM repos WHERE id = 3`
    expect(JSON.parse(r.topics)).toEqual(['git', 'arkiv'])
    expect(Buffer.from(r.dheet_repo_id).toString('hex')).toBe('ab'.repeat(32))
    const [c] = await lite`SELECT parent_oids FROM commits`
    expect(JSON.parse(c.parent_oids)).toEqual(['03'.repeat(20), '04'.repeat(20)])
    const [a] = await lite`SELECT metadata, ip FROM audit_log`
    expect(JSON.parse(a.metadata)).toEqual({ session: 'x', n: 2 })
    const [d] = await lite`SELECT "commit", attested FROM deployments`
    expect(Buffer.from(d.commit).toString('hex')).toBe('aa'.repeat(20))
    expect(d.attested).toBe(1)
    // AUTOINCREMENT continues after the copied ids
    const [n] = await lite`INSERT INTO users (login) VALUES ('carol') RETURNING id`
    expect(Number(n.id)).toBe(8)
    const [pragma] = await lite`PRAGMA foreign_keys`
    expect(Number(pragma.foreign_keys)).toBe(1)
    await lite.close()
  })
})
