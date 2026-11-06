// Stateless browser/API sessions: `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`, payload `{uid, ver, exp}`.
// Revocation is per user: bumping `users.token_version` invalidates every token signed with the old `ver`.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from './config.ts'

export interface SessionPayload { uid: number; ver: number; exp: number }

export const SESSION_TTL_SECONDS = 14 * 24 * 3600
const PREFIX = 'v1'

let devSecret: Buffer | null = null

/** SESSION_SECRET from config (>= 32 bytes). Outside production a random per-process secret is used with a warning. */
export function sessionSecret(): Buffer {
  const configured = (config as { sessionSecret?: string }).sessionSecret ?? process.env.SESSION_SECRET ?? ''
  if (configured) {
    if (Buffer.byteLength(configured) < 32) throw new Error('SESSION_SECRET must be at least 32 bytes')
    return Buffer.from(configured)
  }
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET (>= 32 bytes) is required in production')
  if (!devSecret) {
    devSecret = randomBytes(32)
    console.warn('SESSION_SECRET is not set: using a random per-process secret; sessions end when the process restarts')
  }
  return devSecret
}

const mac = (data: string, secret: Buffer) => createHmac('sha256', secret).update(data).digest()

export function signSession(
  input: { uid: number; ver: number; exp?: number },
  secret: Buffer | string = sessionSecret(),
): string {
  const payload: SessionPayload = {
    uid: input.uid, ver: input.ver,
    exp: input.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  return `${body}.${mac(body, Buffer.from(secret)).toString('base64url')}`
}

/**
 * Returns the payload when the signature is valid and the token has not expired; `version`, when given,
 * must equal the payload's `ver` (the caller passes the user's current token_version).
 */
export function verifySession(
  token: string,
  opts: { secret?: Buffer | string; version?: number; now?: number } = {},
): SessionPayload | null {
  if (typeof token !== 'string' || token.length > 1024) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) return null
  const secret = opts.secret === undefined ? sessionSecret() : Buffer.from(opts.secret)
  const expected = mac(`${parts[0]}.${parts[1]}`, secret)
  const given = Buffer.from(parts[2]!, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let p: SessionPayload
  try { p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) } catch { return null }
  if (!p || !Number.isSafeInteger(p.uid) || !Number.isSafeInteger(p.ver) || !Number.isSafeInteger(p.exp)) return null
  if (p.exp <= (opts.now ?? Math.floor(Date.now() / 1000))) return null
  if (opts.version !== undefined && p.ver !== opts.version) return null
  return { uid: p.uid, ver: p.ver, exp: p.exp }
}
