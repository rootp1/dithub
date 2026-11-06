import { createHash, randomBytes } from 'node:crypto'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { createSiweMessage as _unused, parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import { verifyMessage, getAddress } from 'viem'
import { config } from './config.ts'
import { sql, hex } from './db.ts'

void _unused
export interface AuthUser { id: number; login: string; wallet: string | null; isAdmin: boolean }

const sha = (value: string) => createHash('sha256').update(value).digest()
const COOKIE = 'dheet_session'

export async function issueNonce(): Promise<string> {
  const nonce = randomBytes(16).toString('hex')
  await sql`INSERT INTO siwe_nonces (nonce, expires_at) VALUES (${nonce}, now() + interval '10 minutes')`
  return nonce
}

export async function verifySiwe(c: Context, message: string, signature: `0x${string}`): Promise<AuthUser> {
  const fields = parseSiweMessage(message)
  if (!fields.address || !fields.nonce) throw new Error('Malformed SIWE message')
  const host = new URL(config.publicUrl).host
  const valid = validateSiweMessage({ message: fields, domain: host })
  if (!valid) throw new Error('SIWE message failed validation (domain, expiry or time)')
  const consumed = await sql`UPDATE siwe_nonces SET used_at = now()
    WHERE nonce = ${fields.nonce} AND used_at IS NULL AND expires_at > now() RETURNING nonce`
  if (consumed.length === 0) throw new Error('Nonce is unknown, expired or already used')
  const ok = await verifyMessage({ address: fields.address, message, signature })
  if (!ok) throw new Error('Signature does not match the address')

  const address = getAddress(fields.address)
  const raw = hex(address)
  let rows = await sql`SELECT u.id, u.login, u.is_site_admin FROM wallets w JOIN users u ON u.id = w.user_id
    WHERE w.address = ${raw} AND u.suspended_at IS NULL`
  if (rows.length === 0) {
    const login = `u-${address.slice(2, 10).toLowerCase()}`
    const created = await sql.begin(async (tx) => {
      const [user] = await tx`INSERT INTO users (login) VALUES (${login})
        ON CONFLICT (login) DO UPDATE SET login = users.login RETURNING id, login, is_site_admin`
      await tx`INSERT INTO wallets (user_id, address, is_primary, verified_at) VALUES (${user.id}, ${raw}, true, now())
        ON CONFLICT (address) DO NOTHING`
      return user
    })
    rows = [created]
  }
  const user = rows[0]
  const token = randomBytes(32).toString('base64url')
  await sql`INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at)
    VALUES (${crypto.randomUUID()}, ${user.id}, ${sha(token)}, ${c.req.header('user-agent') ?? null}, ${null}, now() + interval '14 days')`
  setCookie(c, COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure, path: '/', maxAge: 14 * 24 * 3600,
  })
  return { id: Number(user.id), login: user.login, wallet: address, isAdmin: user.is_site_admin }
}

export async function logout(c: Context): Promise<void> {
  const token = getCookie(c, COOKIE)
  if (token) await sql`UPDATE sessions SET revoked_at = now() WHERE token_hash = ${sha(token)}`
  deleteCookie(c, COOKIE, { path: '/' })
}

async function userBy(rows: Array<{ id: number | string; login: string; is_site_admin: boolean; address?: Buffer | null }>): Promise<AuthUser | null> {
  const row = rows[0]
  if (!row) return null
  return {
    id: Number(row.id), login: row.login, isAdmin: row.is_site_admin,
    wallet: row.address ? getAddress(`0x${Buffer.from(row.address).toString('hex')}`) : null,
  }
}

/** Resolve the caller from a session cookie, `Authorization: Bearer <pat>` or Basic (password = PAT). */
export async function authenticate(c: Context): Promise<AuthUser | null> {
  const cookie = getCookie(c, COOKIE)
  if (cookie) {
    const rows = await sql`SELECT u.id, u.login, u.is_site_admin, w.address FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN wallets w ON w.user_id = u.id AND w.is_primary
      WHERE s.token_hash = ${sha(cookie)} AND s.revoked_at IS NULL AND s.expires_at > now() AND u.suspended_at IS NULL`
    const user = await userBy(rows)
    if (user) return user
  }
  const header = c.req.header('authorization')
  let pat: string | null = null
  if (header?.startsWith('Bearer ')) pat = header.slice(7).trim()
  else if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString()
    pat = decoded.slice(decoded.indexOf(':') + 1)
  }
  if (pat) {
    const rows = await sql`UPDATE access_tokens t SET last_used_at = now() FROM users u
      WHERE u.id = t.user_id AND t.token_hash = ${sha(pat)} AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.suspended_at IS NULL
      RETURNING u.id, u.login, u.is_site_admin,
        (SELECT address FROM wallets WHERE user_id = u.id AND is_primary LIMIT 1) AS address`
    return userBy(rows)
  }
  return null
}

export async function createToken(userId: number, name: string): Promise<string> {
  const token = `dht_${randomBytes(24).toString('base64url')}`
  await sql`INSERT INTO access_tokens (user_id, name, token_hash, scopes)
    VALUES (${userId}, ${name}, ${sha(token)}, ${['repo']})`
  return token
}
