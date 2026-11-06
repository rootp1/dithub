import { SQL } from 'bun'
import { config } from './config.ts'

export const sql = new SQL(config.databaseUrl || 'postgres://invalid')

export const hex = (value: string): Buffer => Buffer.from(value.replace(/^0x/, ''), 'hex')
export const toHex = (value: Uint8Array | Buffer | null | undefined): string | null =>
  value ? `0x${Buffer.from(value).toString('hex')}` : null
