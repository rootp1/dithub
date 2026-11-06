import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { Api, apiFor } from '../api.ts'
import { flag, needArg, parse, str } from '../args.ts'
import { ApiError, DitError, UsageError } from '../errors.ts'
import { credentialsPath, deleteCredential, findToken, normalizeHost, primaryHost, saveCredential, setCurrentSession, storedHosts } from '../config.ts'
import { c, info, printJson } from '../ui.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const ch of process.stdin) chunks.push(ch as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref() } catch { /* the URL is printed anyway */ }
}

export async function login(argv: string[]): Promise<number> {
  const p = parse(argv, { 'token-stdin': { type: 'boolean' }, 'no-browser': { type: 'boolean' } }, { allowPositionals: false })
  const host = primaryHost(str(p.values.host))
  const anon = new Api({ host })

  if (flag(p.values['token-stdin'])) {
    const token = await readStdin()
    if (!token) throw new UsageError('--token-stdin: nothing on stdin', 'Example: echo "$TOKEN" | dit login --token-stdin --host https://...')
    const me = await new Api({ host, token }).get<{ user: { login: string } | null }>('/api/me')
    if (!me.user) throw new DitError('that token was not accepted by the server', 1, 'Create a personal access token on the site and try again.')
    saveCredential(host, { token, login: me.user.login })
    if (flag(p.values.json)) printJson({ host, login: me.user.login }); else info(`${c.green('Logged in')} to ${host} as ${c.bold(me.user.login)} (token from stdin).`)
    return 0
  }

  const machine = (() => { try { return hostname().replace(/[^\w.-]/g, '').slice(0, 30) || 'machine' } catch { return 'machine' } })()
  const dev = await anon.post<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>('/api/cli/device', { name: `dit on ${machine}` })
  info(`\nFirst copy your one-time code: ${c.bold(dev.userCode)}`)
  info(`Then open: ${dev.verificationUrl}`)
  info(`Make sure the page shows the same code, sign in on the site if needed, and press Approve.\n`)
  if (!flag(p.values['no-browser']) && process.stdout.isTTY) openBrowser(dev.verificationUrl)
  info('Waiting for approval (Ctrl+C to cancel)...')

  const deadline = Date.now() + dev.expiresIn * 1000
  let interval = Math.max(2, dev.interval) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    try {
      const t = await anon.post<{ token: string; login: string }>('/api/cli/token', { deviceCode: dev.deviceCode })
      saveCredential(host, { token: t.token, login: t.login })
      if (flag(p.values.json)) printJson({ host, login: t.login }); else info(`${c.green('Logged in')} to ${host} as ${c.bold(t.login)}. Credentials saved to ${credentialsPath()}`)
      return 0
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      const code = (err.body as { error?: string } | null)?.error ?? err.message
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') { interval += 5000; continue }
      if (code === 'access_denied') throw new DitError('login was denied in the browser')
      if (code === 'expired_token' || code === 'invalid_grant') throw new DitError('the code expired or was already used', 1, 'Run `dit login` again.')
      throw err
    }
  }
  throw new DitError('timed out waiting for approval', 1, 'Run `dit login` again.')
}

export async function logout(argv: string[]): Promise<number> {
  const p = parse(argv, {}, { allowPositionals: false })
  const host = primaryHost(str(p.values.host))
  const tok = findToken(host, str(p.values.host))
  let revoked = false, note = ''
  if (tok) {
    try { await new Api({ host, token: tok.token }).json('DELETE', '/api/cli/token'); revoked = true }
    catch (err) { note = err instanceof ApiError && err.status === 404 ? 'the token was already invalid on the server' : 'could not reach the server to revoke the token (it stays valid until you revoke it on the site)' }
  }
  const removed = deleteCredential(host)
  setCurrentSession(host, null)
  if (flag(p.values.json)) { printJson({ host, removed, revoked }); return 0 }
  if (!tok) info(`Not logged in to ${host}.`)
  else {
    info(`${removed ? 'Removed local credential' : 'No stored credential'} for ${host}${revoked ? ' and revoked the token on the server' : ''}.`)
    if (tok.source === 'env') info('DIT_TOKEN is set in your environment; unset it to stop using it.')
    if (note) info(c.yellow(note))
  }
  return 0
}

export async function whoami(argv: string[]): Promise<number> {
  const p = parse(argv, {}, { allowPositionals: false })
  const host = primaryHost(str(p.values.host))
  const me = await apiFor(host, { flagHost: str(p.values.host) }).get<{ user: { login: string; wallet: string | null; isAdmin: boolean } | null }>('/api/me')
  if (!me.user) throw new DitError(`not logged in to ${host}`, 1, 'Run `dit login`.')
  if (flag(p.values.json)) printJson({ host, ...me.user })
  else process.stdout.write(`${me.user.login}\n`)
  return 0
}

export async function authStatus(argv: string[]): Promise<number> {
  const p = parse(argv, {}, { allowPositionals: false })
  const flagHost = str(p.values.host)
  const primary = primaryHost(flagHost)
  const hosts = [...new Set([primary, ...storedHosts()])]
  const rows: Array<Record<string, unknown>> = []
  for (const h of hosts) {
    const tok = findToken(h, flagHost)
    let login: string | null = null, state = 'logged out', error: string | undefined
    if (tok) {
      try { login = (await new Api({ host: h, token: tok.token, timeoutMs: 10_000 }).get<{ user: { login: string } | null }>('/api/me')).user?.login ?? null; state = login ? 'logged in' : 'token rejected' }
      catch (err) { state = 'unreachable'; error = (err as Error).message }
    }
    rows.push({ host: h, primary: h === primary, state, login, source: tok?.source ?? null, ...(error ? { error } : {}) })
  }
  if (flag(p.values.json)) { printJson({ credentials: credentialsPath(), hosts: rows }); return rows.some((r) => r.state === 'logged in') ? 0 : 1 }
  for (const r of rows) {
    const mark = r.state === 'logged in' ? c.green('logged in') : c.red(String(r.state))
    process.stdout.write(`${c.bold(String(r.host))}${r.primary ? c.dim(' (default)') : ''}\n  ${mark}${r.login ? ` as ${r.login}` : ''}\n  token:  ${r.source === 'env' ? 'from DIT_TOKEN' : r.source === 'file' ? `stored in ${credentialsPath()}` : 'none'}\n`)
  }
  return rows.some((r) => r.state === 'logged in') ? 0 : 1
}

export async function authCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === 'status' || sub === undefined) return authStatus(rest)
  if (sub === 'login') return login(rest)
  if (sub === 'logout') return logout(rest)
  needArg({ values: {}, positionals: [] }, 0, 'status|login|logout')
  return 2
}
void normalizeHost
