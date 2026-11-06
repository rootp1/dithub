import { SQL } from 'bun'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const pkgDir = join(import.meta.dir, '..')
const repoRoot = join(pkgDir, '../..')
export const schemaPath = join(pkgDir, 'schema.sql')
export const migrationsDir = join(pkgDir, 'migrations-sqlite')
export const defaultDatabasePath = join(repoRoot, '.data/dithub.sqlite')

// One SQLite file shared by api and worker. Pragmas are per connection; the sqlite adapter runs queries
// in order on one connection, so starting them here makes them apply before any later query.
export function openDb(path: string = process.env.DATABASE_PATH || defaultDatabasePath): SQL {
  const memory = path === ':memory:' || path.startsWith('file::memory:')
  if (!memory) mkdirSync(dirname(path), { recursive: true })
  const sql = new SQL({ adapter: 'sqlite', filename: path })
  const pragmas = memory
    ? 'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000'
    : 'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL'
  sql.unsafe(pragmas).execute().catch((e: unknown) => console.error('sqlite pragmas failed', e))
  return sql
}

const BASELINE = 'schema.sql'

// Applies schema.sql on an empty database, then every pending migrations-sqlite/*.sql, each in its own
// transaction, recording applied names in schema_migrations. Safe to run any number of times.
export async function migrate(sql: SQL, opts: { schema?: string; dir?: string; log?: (msg: string) => void } = {}): Promise<void> {
  const schema = opts.schema ?? schemaPath
  const dir = opts.dir ?? migrationsDir
  const log = opts.log ?? ((msg: string) => console.log(msg))
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name))
  if (!applied.has(BASELINE)) {
    const [existing] = await sql`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'users'`
    await sql.begin(async (tx) => {
      if (!existing) {
        log(`applying ${BASELINE}`)
        await tx.unsafe(readFileSync(schema, 'utf8'))
      }
      await tx`INSERT INTO schema_migrations (name) VALUES (${BASELINE})`
    })
  }
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : []
  for (const file of files) {
    if (applied.has(file)) continue
    log(`applying ${file}`)
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, file), 'utf8'))
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`
    })
  }
}

export const hex = (value: string): Buffer => Buffer.from(value.replace(/^0x/i, ''), 'hex')

export const toHex = (value: Uint8Array | Buffer | ArrayBuffer | null | undefined): string | null =>
  value ? `0x${Buffer.from(value as Uint8Array).toString('hex')}` : null

// ISO-8601 UTC with milliseconds, same shape as the schema's strftime('%Y-%m-%dT%H:%M:%fZ','now') defaults.
export const now = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString()

export const json = (value: unknown): string => JSON.stringify(value ?? null)

export function parseJson<T = unknown>(value: unknown): T {
  if (value === null || value === undefined) return null as T
  if (typeof value === 'string') return JSON.parse(value) as T
  if (value instanceof Uint8Array) return JSON.parse(Buffer.from(value).toString('utf8')) as T
  return value as T
}

export function bool(value: unknown): boolean {
  if (typeof value === 'string') return value === '1' || value === 't' || value === 'true'
  if (typeof value === 'bigint') return value !== 0n
  return Boolean(value)
}

export const newId = (): string => crypto.randomUUID()
