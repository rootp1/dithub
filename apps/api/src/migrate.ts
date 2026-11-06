import { migrate, openDb } from '../../../packages/db/src/index.ts'
import { config } from './config.ts'

const sql = openDb(config.databasePath)
await migrate(sql, process.env.MIGRATIONS_DIR ? { dir: process.env.MIGRATIONS_DIR } : {})
console.log(`migrations up to date (${config.databasePath})`)
await sql.close()
