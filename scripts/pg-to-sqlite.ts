// One-off copy of the old Postgres database (DATABASE_URL) into the new SQLite file (DATABASE_PATH).
// Stop api and worker first. Safe to re-run: rows are written with INSERT OR REPLACE on their primary key.
//   DATABASE_URL=postgres://... DATABASE_PATH=/data/db/dithub.sqlite bun scripts/pg-to-sqlite.ts
// Conversions: bytea -> BLOB, json/jsonb -> JSON text, arrays -> JSON array text (bytea[] elements as hex),
// boolean -> 0/1, timestamptz/date -> ISO-8601 UTC, uuid/inet/citext/enums -> text.
// Skipped: `sessions` (sessions are signed tokens now), `ens_seats`, and any table or column the SQLite schema dropped.
import { SQL } from 'bun'
import { defaultDatabasePath, migrate, openDb } from '../packages/db/src/index.ts'

export type PgColumn = { name: string; dataType: string; udtName: string }
export interface PgSource {
  tables(): Promise<string[]>
  columns(table: string): Promise<PgColumn[]>
  rows(table: string, columns: string[], pageSize: number): AsyncIterable<Record<string, unknown>[]>
}
export type TableReport = { table: string; source: number; target: number; note?: string }
export type CopyReport = { tables: TableReport[]; skipped: string[]; newTables: string[]; droppedColumns: string[]; fkViolations: number }

export const SKIP_TABLES = new Set(['sessions', 'ens_seats', 'schema_migrations'])
const q = (id: string) => `"${id.replace(/"/g, '""')}"`

// Postgres text-format bytea ('\x0a0b') or a driver Buffer/Uint8Array -> Buffer.
function bytes(v: unknown): Buffer {
  if (typeof v === 'string') return v.startsWith('\\x') ? Buffer.from(v.slice(2), 'hex') : Buffer.from(v, 'utf8')
  return Buffer.from(v as Uint8Array)
}
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString()

function element(v: unknown, udtName: string): unknown {
  if (v === null || v === undefined) return null
  if (udtName === '_bytea' || v instanceof Uint8Array) return bytes(v).toString('hex')
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return Number(v)
  return v
}

export function convertValue(v: unknown, col: PgColumn): unknown {
  if (v === null || v === undefined) return null
  const t = col.dataType.toLowerCase()
  if (t === 'array') {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? parsePgArray(v) : [v]
    return JSON.stringify(arr.map((e) => element(e, col.udtName)))
  }
  if (t === 'json' || t === 'jsonb') return typeof v === 'string' && col.udtName === 'json' ? v : JSON.stringify(v)
  if (t === 'boolean') return v === true || v === 't' || v === 'true' || v === 1 ? 1 : 0
  if (t === 'bytea') return bytes(v)
  if (t.startsWith('timestamp') || t === 'date') return iso(v)
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return Buffer.from(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'bigint') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return typeof v === 'number' ? v : String(v)
}

// Minimal parser for a one-dimensional Postgres array literal, used only if the driver hands back text.
export function parsePgArray(text: string): (string | null)[] {
  const s = text.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return [s]
  const out: (string | null)[] = []
  let cur = '', quoted = false, inQuote = false, i = 1
  const push = () => { out.push(!quoted && cur === 'NULL' ? null : cur); cur = ''; quoted = false }
  for (; i < s.length - 1; i++) {
    const c = s[i]!
    if (inQuote) {
      if (c === '\\') cur += s[++i]
      else if (c === '"') inQuote = false
      else cur += c
    } else if (c === '"') { inQuote = true; quoted = true }
    else if (c === ',') push()
    else cur += c
  }
  if (s.length > 2) push()
  return out
}

export function pgSource(pg: SQL): PgSource {
  return {
    async tables() {
      const rows = await pg`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      return rows.map((r: { table_name: string }) => r.table_name)
    },
    async columns(table) {
      const rows = await pg`SELECT column_name, data_type, udt_name, is_generated FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`
      return rows.filter((r: { is_generated: string }) => r.is_generated !== 'ALWAYS')
        .map((r: { column_name: string; data_type: string; udt_name: string }) => ({ name: r.column_name, dataType: r.data_type, udtName: r.udt_name }))
    },
    async *rows(table, columns, pageSize) {
      // ctid order is stable while nothing writes (api and worker are stopped during the cutover).
      for (let offset = 0; ; offset += pageSize) {
        const page = await pg.unsafe(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)} ORDER BY ctid LIMIT ${pageSize} OFFSET ${offset}`)
        if (page.length) yield page as Record<string, unknown>[]
        if (page.length < pageSize) return
      }
    },
  }
}

/** NOT NULL columns the SQLite schema has but an older Postgres may lack: value to fill in. Every pre-migration release was on Sepolia. */
const FILL: Record<string, Record<string, unknown>> = { deployments: { chain_id: 11155111 } }

export async function copyDatabase(src: PgSource, lite: SQL, opts: { pageSize?: number; log?: (msg: string) => void } = {}): Promise<CopyReport> {
  const pageSize = opts.pageSize ?? 2000
  const log = opts.log ?? (() => {})
  const liteTables = (await lite`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r: { name: string }) => r.name).filter((t: string) => !SKIP_TABLES.has(t))
  const pgTables = await src.tables()
  const report: CopyReport = {
    tables: [],
    skipped: pgTables.filter((t) => SKIP_TABLES.has(t) || !liteTables.includes(t)),
    newTables: liteTables.filter((t: string) => !pgTables.includes(t)),
    droppedColumns: [],
    fkViolations: 0,
  }
  // Rows arrive in arbitrary order across tables; check foreign keys once at the end instead.
  await lite.unsafe('PRAGMA foreign_keys=OFF')
  try {
    for (const table of liteTables) {
      if (!pgTables.includes(table)) continue
      const liteCols = new Set((await lite.unsafe(`PRAGMA table_info(${q(table)})`)).map((r: { name: string }) => r.name))
      const pgCols = await src.columns(table)
      const cols = pgCols.filter((c) => liteCols.has(c.name))
      for (const c of pgCols) if (!liteCols.has(c.name)) report.droppedColumns.push(`${table}.${c.name}`)
      const fill = Object.entries(FILL[table] ?? {}).filter(([name]) => liteCols.has(name) && !pgCols.some((c) => c.name === name))
      const names = [...cols.map((c) => c.name), ...fill.map(([name]) => name)]
      const insert = `INSERT OR REPLACE INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      let source = 0
      for await (const page of src.rows(table, cols.map((c) => c.name), pageSize)) {
        await lite.begin(async (tx) => {
          for (const row of page) await tx.unsafe(insert, [...cols.map((c) => convertValue(row[c.name], c)), ...fill.map(([, v]) => v)])
        })
        source += page.length
      }
      const [{ n }] = await lite.unsafe(`SELECT count(*) AS n FROM ${q(table)}`)
      report.tables.push({ table, source, target: Number(n) })
      log(`${table.padEnd(24)} postgres=${String(source).padStart(7)}  sqlite=${String(n).padStart(7)}`)
    }
    report.fkViolations = (await lite.unsafe('PRAGMA foreign_key_check')).length
  } finally {
    await lite.unsafe('PRAGMA foreign_keys=ON')
  }
  return report
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL (the old Postgres) is required'); process.exit(2) }
  const path = process.env.DATABASE_PATH || defaultDatabasePath
  const pg = new SQL(url)
  const lite = openDb(path)
  try {
    await migrate(lite)
    console.log(`copying ${new URL(url).pathname.slice(1) || 'postgres'} -> ${path}`)
    const r = await copyDatabase(pgSource(pg), lite, { log: console.log })
    if (r.skipped.length) console.log(`skipped tables: ${r.skipped.join(', ')}`)
    if (r.droppedColumns.length) console.log(`dropped columns: ${r.droppedColumns.join(', ')}`)
    if (r.newTables.length) console.log(`new (empty) tables: ${r.newTables.join(', ')}`)
    const short = r.tables.filter((t) => t.target < t.source)
    if (short.length) console.error(`FEWER ROWS IN SQLITE: ${short.map((t) => t.table).join(', ')}`)
    if (r.fkViolations) console.error(`${r.fkViolations} foreign key violation(s); inspect with PRAGMA foreign_key_check`)
    console.log(`${r.tables.reduce((n, t) => n + t.source, 0)} rows copied from ${r.tables.length} tables`)
    process.exitCode = short.length || r.fkViolations ? 1 : 0
  } finally {
    await pg.close().catch(() => {})
    await lite.close()
  }
}
