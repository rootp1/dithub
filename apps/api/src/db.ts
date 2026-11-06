import { openDb } from '../../../packages/db/src/index.ts'
import { config } from './config.ts'

export const sql = openDb(config.databasePath)

export { hex, toHex, now, json, parseJson, bool, newId } from '../../../packages/db/src/index.ts'
