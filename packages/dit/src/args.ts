import { parseArgs } from 'node:util'
import { UsageError } from './errors.ts'

export type OptSpec = Record<string, { type: 'boolean' | 'string'; short?: string; multiple?: boolean }>

export interface Parsed {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>
  positionals: string[]
}

/** Options every command accepts. */
export const GLOBAL_OPTS: OptSpec = {
  host: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  repo: { type: 'string', short: 'R' },
}

export function parse(argv: string[], spec: OptSpec = {}, opts: { allowPositionals?: boolean } = {}): Parsed {
  try {
    const r = parseArgs({ args: argv, options: { ...GLOBAL_OPTS, ...spec }, allowPositionals: opts.allowPositionals ?? true, strict: true })
    return { values: r.values as Parsed['values'], positionals: r.positionals }
  } catch (err) {
    throw new UsageError((err as Error).message.replace(/^Unknown option/, 'unknown option'), 'Run with --help for usage.')
  }
}

export const str = (v: Parsed['values'][string]): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v.find((x) => typeof x === 'string') as string | undefined) : undefined)
export const list = (v: Parsed['values'][string]): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [])
export const flag = (v: Parsed['values'][string]): boolean => v === true

/** Split "a,b" or repeated flags into a clean list. */
export const csv = (v: Parsed['values'][string]): string[] => list(v).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)

export function needArg(p: Parsed, i: number, name: string): string {
  const v = p.positionals[i]
  if (!v) throw new UsageError(`missing <${name}>`, 'Run with --help for usage.')
  return v
}

export function intArg(v: string, name: string): number {
  if (!/^#?\d+$/.test(v)) throw new UsageError(`<${name}> must be a number, got "${v}"`)
  return Number(v.replace('#', ''))
}
