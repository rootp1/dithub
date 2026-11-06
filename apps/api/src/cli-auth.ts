// Device-code login for the `dit` CLI (RFC 8628 style): no key or token is ever typed into the terminal.
//   POST   /api/cli/device           CLI asks for a device code + short user code
//   GET    /cli?code=ABCD-EFGH       tiny self-contained approval page (uses the site's session cookie)
//   POST   /api/cli/device/approve   same-origin form post from that page (cookie + one-time CSRF value)
//   POST   /api/cli/token            CLI polls with the device code; receives a fresh PAT exactly once
//   DELETE /api/cli/token            revokes the PAT presented as Bearer (dit logout)
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { config } from './config.ts'
import { sql } from './db.ts'
import { authenticate, createToken } from './auth.ts'

export const cliAuth = new Hono()

const TTL_SECONDS = 600
const INTERVAL = 5
const COOKIE = 'dheet_session'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
const sha = (v: string) => createHash('sha256').update(v).digest()
const normCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '')
const prettyCode = (n: string) => `${n.slice(0, 4)}-${n.slice(4)}`
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

// Per-IP fixed-window limiter (the edge proxy sets x-forwarded-for, like the /api/auth limiter in index.ts).
const hits = new Map<string, { n: number; reset: number }>()
function limited(c: import('hono').Context, bucket: string, max: number): boolean {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  const key = `${bucket}:${ip}`, now = Date.now(), h = hits.get(key)
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + 60_000 }); return false }
  return ++h.n > max
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  // Not 'no-referrer': under that policy browsers send `Origin: null` on the approval form POST, which the same-origin check
  // (correctly) refuses. 'same-origin' still sends nothing to other sites.
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
}

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#14171f;--mut:#5b6472;--line:#d9dde4;--acc:#4f46e5}
@media(prefers-color-scheme:dark){:root{--bg:#0f1218;--fg:#e8ebf1;--mut:#9aa3b2;--line:#2a3140;--acc:#818cf8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:30rem;width:100%;border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0}.mut{color:var(--mut);font-size:.9rem}
code{font:600 1.4rem ui-monospace,monospace;letter-spacing:.12em}
button,a.btn{font:inherit;padding:.55rem 1rem;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
button.p{background:var(--acc);border-color:var(--acc);color:#fff}input[type=text]{font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
.row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
</style></head><body><main>${body}</main></body></html>`, { status, headers: HTML_HEADERS })
}

async function cleanup() { await sql`DELETE FROM cli_device_codes WHERE expires_at < now() - interval '1 day'`.catch(() => {}) }

cliAuth.post('/api/cli/device', async (c) => {
  if (limited(c, 'cli-new', 10)) return c.json({ error: 'too many requests' }, 429)
  const b = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = String(b.name ?? 'dit').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60) || 'dit'
  void cleanup()
  const deviceCode = randomBytes(32).toString('base64url')
  for (let attempt = 0; attempt < 5; attempt++) {
    const norm = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const ins = await sql`INSERT INTO cli_device_codes (device_hash, user_hash, client_name, expires_at)
      VALUES (${sha(deviceCode)}, ${sha(norm)}, ${name}, now() + (${TTL_SECONDS} * interval '1 second'))
      ON CONFLICT DO NOTHING RETURNING id`
    if (!ins.length) continue
    const userCode = prettyCode(norm)
    return c.json({ deviceCode, userCode, verificationUrl: `${config.publicUrl.replace(/\/$/, '')}/cli?code=${userCode}`, expiresIn: TTL_SECONDS, interval: INTERVAL }, 201)
  }
  return c.json({ error: 'could not allocate a code, retry' }, 503)
})

async function rowByUserCode(code: string) {
  const norm = normCode(code)
  if (norm.length !== 8) return null
  const [r] = await sql`SELECT id, user_hash, client_name, status, expires_at > now() AS live FROM cli_device_codes WHERE user_hash = ${sha(norm)}`
  return r && eq(Buffer.from(r.user_hash), sha(norm)) ? (r as { id: number; client_name: string; status: string; live: boolean }) : null
}

const hostname = () => new URL(config.publicUrl).host

cliAuth.get('/cli', async (c) => {
  if (limited(c, 'cli-page', 60)) return page('Too many requests', '<h1>Too many requests</h1><p>Try again in a minute.</p>', 429)
  const raw = c.req.query('code') ?? ''
  const here = `/cli${raw ? `?code=${encodeURIComponent(raw.slice(0, 20))}` : ''}`
  if (!raw) return page('Approve dit', `<h1>Sign in the dit CLI</h1><p>Enter the code shown in your terminal.</p>
    <form method="get" action="/cli"><input type="text" name="code" placeholder="ABCD-EFGH" autocomplete="off" maxlength="12" autofocus> <button class="p">Continue</button></form>`)
  const user = getCookie(c, COOKIE) ? await authenticate(c) : null
  if (!user) return page('Sign in first', `<h1>Sign in first</h1><p>Open <a href="/">${esc(hostname())}</a> in this browser, sign in with your wallet, then come back to this page (reload it).</p>
    <p class="mut">Code: ${esc(raw.slice(0, 20))}</p><div class="row"><a class="btn p" href="/">Go to ${esc(hostname())}</a><a class="btn" href="${esc(here)}">I signed in, reload</a></div>`)
  const row = await rowByUserCode(raw)
  if (!row || !row.live || row.status !== 'pending') return page('Code not valid', `<h1>Code not valid</h1><p>This code is unknown, expired or already used. Run <code style="font-size:1rem">dit login</code> again.</p>`, 404)
  const csrf = randomBytes(24).toString('base64url')
  await sql`UPDATE cli_device_codes SET csrf_hash = ${sha(csrf)}, csrf_session = ${sha(getCookie(c, COOKIE)!)} WHERE id = ${row.id}`
  return page('Approve dit', `<h1>Approve dit on ${esc(hostname())} as ${esc(user.login)}</h1>
    <p>A command-line client called <b>${esc(row.client_name)}</b> is asking for a personal access token for your account.</p>
    <p>Code: <code>${esc(prettyCode(normCode(raw)))}</code></p>
    <p class="mut">Only approve if this code matches the one in your terminal. You can revoke the token later.</p>
    <form method="post" action="/api/cli/device/approve"><input type="hidden" name="code" value="${esc(prettyCode(normCode(raw)))}"><input type="hidden" name="csrf" value="${esc(csrf)}">
    <div class="row"><button class="p" name="action" value="approve">Approve</button><button name="action" value="deny">Deny</button></div></form>`)
})

/** Same-origin check: Origin (or Referer) must be this site. Browsers always send Origin on form POSTs. */
function sameOrigin(c: import('hono').Context): boolean {
  const origin = c.req.header('origin') ?? (c.req.header('referer') ? new URL(c.req.header('referer')!, 'http://x').origin : null)
  if (!origin || origin === 'null') return false
  let host: string; try { host = new URL(origin).host } catch { return false }
  const site = c.req.header('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  return host === new URL(config.publicUrl).host || host === c.req.header('host')
}

cliAuth.post('/api/cli/device/approve', async (c) => {
  if (limited(c, 'cli-approve', 20)) return page('Too many requests', '<h1>Too many requests</h1>', 429)
  if (!sameOrigin(c)) return page('Refused', '<h1>Refused</h1><p>Cross-origin approval is not allowed.</p>', 403)
  const cookie = getCookie(c, COOKIE)
  const user = cookie ? await authenticate(c) : null
  if (!cookie || !user) return page('Sign in first', '<h1>Sign in first</h1><p>Your session is missing or expired. Sign in at the site and retry.</p>', 401)
  const ct = c.req.header('content-type') ?? ''
  let code = '', csrf = '', action = 'approve'
  if (ct.includes('application/json')) { const j = await c.req.json<Record<string, string>>().catch(() => ({} as Record<string, string>)); code = String(j.code ?? j.userCode ?? ''); csrf = String(j.csrf ?? ''); action = String(j.action ?? 'approve') }
  else { const f = await c.req.parseBody().catch(() => ({} as Record<string, unknown>)); code = String(f.code ?? ''); csrf = String(f.csrf ?? ''); action = String(f.action ?? 'approve') }
  const row = await rowByUserCode(code)
  const bad = () => page('Not approved', '<h1>Not approved</h1><p>The code is invalid, expired, already used, or the page is stale. Run <code style="font-size:1rem">dit login</code> again.</p>', 400)
  if (!row || !row.live || row.status !== 'pending' || !csrf) return bad()
  const [sec] = await sql`SELECT csrf_hash, csrf_session FROM cli_device_codes WHERE id = ${row.id}`
  if (!sec?.csrf_hash || !sec.csrf_session || !eq(Buffer.from(sec.csrf_hash), sha(csrf)) || !eq(Buffer.from(sec.csrf_session), sha(cookie))) return bad()
  // One-time: the csrf value is cleared in the same statement that changes the status.
  const upd = action === 'deny'
    ? await sql`UPDATE cli_device_codes SET status = 'denied', csrf_hash = NULL, csrf_session = NULL WHERE id = ${row.id} AND status = 'pending' AND expires_at > now() RETURNING id`
    : await sql`UPDATE cli_device_codes SET status = 'approved', user_id = ${user.id}, approved_at = now(), csrf_hash = NULL, csrf_session = NULL WHERE id = ${row.id} AND status = 'pending' AND expires_at > now() RETURNING id`
  if (!upd.length) return bad()
  return action === 'deny'
    ? page('Denied', '<h1>Denied</h1><p>The CLI was not given access.</p>')
    : page('Approved', `<h1>Approved</h1><p>dit is now signed in as <b>${esc(user.login)}</b>. You can close this tab and return to your terminal.</p>`)
})

cliAuth.post('/api/cli/token', async (c) => {
  if (limited(c, 'cli-poll', 60)) return c.json({ error: 'slow_down' }, 429)
  const b = await c.req.json<{ deviceCode?: string }>().catch(() => ({} as { deviceCode?: string }))
  if (typeof b.deviceCode !== 'string' || b.deviceCode.length < 20 || b.deviceCode.length > 200) return c.json({ error: 'invalid_request' }, 400)
  const h = sha(b.deviceCode)
  const [r] = await sql`SELECT id, device_hash, status, user_id, client_name, expires_at <= now() AS expired,
      (last_poll_at IS NOT NULL AND last_poll_at > now() - ((${INTERVAL - 1}) * interval '1 second')) AS too_fast
    FROM cli_device_codes WHERE device_hash = ${h}`
  if (!r || !eq(Buffer.from(r.device_hash), h)) return c.json({ error: 'invalid_grant' }, 400)
  if (r.expired || r.status === 'consumed') return c.json({ error: 'expired_token' }, 400)
  if (r.status === 'denied') return c.json({ error: 'access_denied' }, 403)
  if (r.status === 'pending') {
    if (r.too_fast) return c.json({ error: 'slow_down' }, 429)
    await sql`UPDATE cli_device_codes SET last_poll_at = now() WHERE id = ${r.id}`
    return c.json({ error: 'authorization_pending' }, 400)
  }
  // approved: flip to consumed atomically so exactly one poll receives the token.
  const claimed = await sql`UPDATE cli_device_codes SET status = 'consumed' WHERE id = ${r.id} AND status = 'approved' AND expires_at > now() RETURNING user_id`
  if (!claimed.length) return c.json({ error: 'expired_token' }, 400)
  const [u] = await sql`SELECT login FROM users WHERE id = ${claimed[0].user_id} AND suspended_at IS NULL`
  if (!u) return c.json({ error: 'access_denied' }, 403)
  const token = await createToken(Number(claimed[0].user_id), String(r.client_name))
  return c.json({ token, login: u.login, note: 'shown once' })
})

cliAuth.delete('/api/cli/token', async (c) => {
  const header = c.req.header('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return c.json({ error: 'send the token to revoke as a Bearer token' }, 400)
  const rows = await sql`UPDATE access_tokens SET revoked_at = now() WHERE token_hash = ${sha(header.slice(7).trim())} AND revoked_at IS NULL RETURNING id`
  return rows.length ? c.json({ ok: true }) : c.json({ error: 'token not found or already revoked' }, 404)
})
