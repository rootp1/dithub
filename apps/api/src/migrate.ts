import { SQL } from 'bun'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.MIGRATIONS_DIR ?? join(import.meta.dir, '../../../packages/db/migrations')
const sql = new SQL(process.env.DATABASE_URL ?? '')
await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const [legacy] = await sql`SELECT to_regclass('public.users') AS t`
const [count] = await sql`SELECT count(*)::int AS n FROM schema_migrations`
if (legacy?.t && count?.n === 0 && files[0]) await sql`INSERT INTO schema_migrations (name) VALUES (${files[0]})`   // DB created before tracking
for (const file of files) {
  const [done] = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`
  if (done) continue
  console.log(`applying ${file}`)
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(dir, file), 'utf8'))
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`
  })
}
console.log('migrations up to date')
await sql.close()
