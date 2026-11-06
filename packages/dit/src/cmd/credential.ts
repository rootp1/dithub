// `dit credential get|store|erase`: a git credential helper that answers only for hosts we hold a token for.
import { findToken, normalizeHost, primaryHost, storedHosts } from '../config.ts'
import { UsageError } from '../errors.ts'

export function parseCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, '')
  }
  return out
}

/** Pure decision: what to print for a `get` request. Returns null to stay silent (not our host). */
export function credentialResponse(input: Record<string, string>, lookup: (origin: string) => string | null): string | null {
  const proto = input.protocol, host = input.host
  if (!proto || !host || (proto !== 'https' && proto !== 'http')) return null
  let origin: string
  try { origin = normalizeHost(`${proto}://${host}`) } catch { return null }
  const token = lookup(origin)
  if (!token) return null
  if (input.path && !/^git\//.test(input.path)) return null     // only the smart-HTTP endpoint, not arbitrary paths
  return `username=dit\npassword=${token}\n`
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const ch of process.stdin) chunks.push(ch as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function credential(argv: string[]): Promise<number> {
  const op = argv[0]
  if (op !== 'get' && op !== 'store' && op !== 'erase') throw new UsageError('usage: dit credential get|store|erase (called by git)')
  const input = parseCredentialInput(await readStdin())
  if (op !== 'get') return 0         // we never take tokens from git; `dit login` is the only writer
  const known = new Set([primaryHost(), ...storedHosts()])
  const res = credentialResponse(input, (origin) => (known.has(origin) ? findToken(origin)?.token ?? null : null))
  if (res) process.stdout.write(res)
  return 0
}
