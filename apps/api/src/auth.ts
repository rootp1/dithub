import { createHash, randomBytes } from 'node:crypto'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe'
import { verifyMessage, getAddress } from 'viem'
import { config } from './config.ts'
import { sql, hex } from './db.ts'
import { signSession, verifySession, SESSION_TTL_SECONDS } from './session-token.ts'

export interface AuthUser { id: number; login: string; wallet: string | null; isAdmin: boolean }

const sha = (value: string) => createHash('sha256').update(value).digest()
/** ISO-8601 UTC with ms, offset by `ms` from now (same shape as the SQLite strftime default). */
const at = (ms = 0) => new Date(Date.now() + ms).toISOString()
export const COOKIE = 'dheet_session'

export async function issueNonce(): Promise<string> {
  const nonce = randomBytes(16).toString('hex')
  await sql`INSERT INTO siwe_nonces (nonce, expires_at) VALUES (${nonce}, ${at(10 * 60_000)})`
  return nonce
}

function setSession(c: Context, uid: number, ver: number): void {
  setCookie(c, COOKIE, signSession({ uid, ver }), {
    httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_TTL_SECONDS,
  })
}

export async function verifySiwe(c: Context, message: string, signature: `0x${string}`): Promise<AuthUser> {
  const fields = parseSiweMessage(message)
  if (!fields.address || !fields.nonce) throw new Error('Malformed SIWE message')
  const host = new URL(config.publicUrl).host
  const valid = validateSiweMessage({ message: fields, domain: host })
  if (!valid) throw new Error('SIWE message failed validation (domain, expiry or time)')
  const t = at()
  const consumed = await sql`UPDATE siwe_nonces SET used_at = ${t}
    WHERE nonce = ${fields.nonce} AND used_at IS NULL AND expires_at > ${t} RETURNING nonce`
  if (consumed.length === 0) throw new Error('Nonce is unknown, expired or already used')
  const ok = await verifyMessage({ address: fields.address, message, signature })
  if (!ok) throw new Error('Signature does not match the address')

  const address = getAddress(fields.address)
  const raw = hex(address)
  let rows = await sql`SELECT u.id, u.login, u.is_site_admin, u.token_version FROM wallets w JOIN users u ON u.id = w.user_id
    WHERE w.address = ${raw} AND u.suspended_at IS NULL`
  if (rows.length === 0) {
    const base = `u-${address.slice(2, 10).toLowerCase()}`
    const created = await sql.begin(async (tx) => {
      // Never attach a new wallet to an existing account that happens to hold the default login: pick a free login instead.
      let user
      for (let i = 0; !user; i++) {
        const login = i === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`
        ;[user] = await tx`INSERT INTO users (login) VALUES (${login}) ON CONFLICT (login) DO NOTHING
          RETURNING id, login, is_site_admin, token_version`
        if (i > 5 && !user) throw new Error('Could not allocate a username')
      }
      await tx`INSERT INTO wallets (user_id, address, is_primary, verified_at) VALUES (${user.id}, ${raw}, 1, ${at()})`
      return user
    })
    rows = [created]
  }
  const user = rows[0]
  setSession(c, Number(user.id), Number(user.token_version ?? 0))
  return { id: Number(user.id), login: user.login, wallet: address, isAdmin: Boolean(user.is_site_admin) }
}

/** Clears this browser's cookie. The token itself stays valid until expiry unless logoutEverywhere is used. */
export async function logout(c: Context): Promise<void> {
  deleteCookie(c, COOKIE, { path: '/' })
}

/** Revokes every session token of the caller (bumps users.token_version) and clears the cookie. PATs are unaffected. */
export async function logoutEverywhere(c: Context): Promise<boolean> {
  const user = await authenticate(c)
  deleteCookie(c, COOKIE, { path: '/' })
  if (!user) return false
  await sql`UPDATE users SET token_version = token_version + 1, updated_at = ${at()} WHERE id = ${user.id}`
  return true
}

type UserRow = { id: number | bigint | string; login: string; is_site_admin: number | boolean; address?: Uint8Array | null }

function userBy(row: UserRow | undefined): AuthUser | null {
  if (!row) return null
  return {
    id: Number(row.id), login: row.login, isAdmin: Boolean(row.is_site_admin),
    wallet: row.address ? getAddress(`0x${Buffer.from(row.address).toString('hex')}`) : null,
  }
}

/** Resolve the caller from a session cookie, `Authorization: Bearer <pat>` or Basic (password = PAT). */
export async function authenticate(c: Context): Promise<AuthUser | null> {
  const cookie = getCookie(c, COOKIE)
  if (cookie) {
    const p = verifySession(cookie)
    if (p) {
      const [row] = await sql`SELECT u.id, u.login, u.is_site_admin, u.token_version,
          (SELECT address FROM wallets WHERE user_id = u.id AND is_primary = 1 LIMIT 1) AS address
        FROM users u WHERE u.id = ${p.uid} AND u.suspended_at IS NULL`
      if (row && Number(row.token_version) === p.ver) return userBy(row)
    }
  }
  const header = c.req.header('authorization')
  let pat: string | null = null
  if (header?.startsWith('Bearer ')) pat = header.slice(7).trim()
  else if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString()
    pat = decoded.slice(decoded.indexOf(':') + 1)
  }
  if (pat) {
    const t = at()
    const [row] = await sql`SELECT t.id AS token_id, u.id, u.login, u.is_site_admin,
        (SELECT address FROM wallets WHERE user_id = u.id AND is_primary = 1 LIMIT 1) AS address
      FROM access_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${sha(pat)} AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ${t}) AND u.suspended_at IS NULL`
    if (!row) return null
    await sql`UPDATE access_tokens SET last_used_at = ${t} WHERE id = ${row.token_id}`
    return userBy(row)
  }
  return null
}

export async function createToken(userId: number, name: string): Promise<string> {
  const token = `dht_${randomBytes(24).toString('base64url')}`
  await sql`INSERT INTO access_tokens (user_id, name, token_hash, scopes)
    VALUES (${userId}, ${name}, ${sha(token)}, ${JSON.stringify(['repo'])})`
  return token
}
