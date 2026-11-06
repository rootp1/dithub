// Small HTTP client for the Dithub API. Tokens only ever travel in the Authorization header.
import { ApiError, DitError, describeApiError } from './errors.ts'
import { VERSION } from './constants.ts'
import { findToken, normalizeHost } from './config.ts'

export interface ApiOptions { host: string; token?: string | null; session?: string | null; timeoutMs?: number }
export interface ReqOptions { query?: Record<string, string | number | undefined | null>; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; noSession?: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Api {
  readonly host: string
  constructor(private o: ApiOptions) { this.host = normalizeHost(o.host) }

  get hasToken() { return !!this.o.token }
  withSession(id: string | null) { return new Api({ ...this.o, session: id }) }

  url(path: string, query?: ReqOptions['query']): string {
    const u = new URL(path, this.host)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    return u.toString()
  }

  /** Low-level request; retries GETs on 502/503 and network errors. Throws ApiError for non-2xx. */
  async raw(method: string, path: string, opt: ReqOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': `dit/${VERSION}`, accept: 'application/json', ...(opt.headers ?? {}) }
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`
    if (this.o.session && !opt.noSession) headers['x-dheet-session'] = this.o.session
    let body: string | undefined
    if (opt.body !== undefined) { body = JSON.stringify(opt.body); headers['content-type'] = 'application/json' }
    const attempts = method === 'GET' ? 3 : 1
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(this.url(path, opt.query), { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(opt.timeoutMs ?? this.o.timeoutMs ?? 30_000), redirect: 'manual' })
        if ((res.status === 502 || res.status === 503) && i < attempts - 1) { await sleep(400 * 2 ** i); continue }
        if (res.status >= 300 && res.status < 400) {
          // Redirects are never followed (the token must not go to a host the user did not choose); explain the move instead.
          let movedTo: string | null = null
          try { const loc = res.headers.get('location'); if (loc) { const u = new URL(loc, this.o.host); if (u.protocol === 'https:') movedTo = u.origin } } catch { /* ignore */ }
          throw new ApiError(res.status, movedTo ? `Dithub has moved to ${movedTo}: run \`dit login --host ${movedTo}\` (or set DIT_HOST=${movedTo})` : 'unexpected redirect from the server', { movedTo })
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          let parsed: unknown = null
          try { parsed = JSON.parse(text) } catch { /* not JSON */ }
          const reason = (parsed as { error?: string } | null)?.error ?? (text.trim().slice(0, 200) || res.statusText || 'request failed')
          throw new ApiError(res.status, reason, parsed)
        }
        return res
      } catch (err) {
        if (err instanceof ApiError) throw err
        lastErr = err
        if (i < attempts - 1) { await sleep(400 * 2 ** i); continue }
      }
    }
    const e = lastErr as Error
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw new DitError(timeout ? `request to ${this.host} timed out` : `cannot reach ${this.host}: ${(e?.message ?? String(e)).replace(/\s+/g, ' ').slice(0, 160)}`, 1,
      'Check your network, proxy settings (HTTPS_PROXY) and --host / DIT_HOST.')
  }

  async json<T = any>(method: string, path: string, opt: ReqOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opt)
    return (await res.json()) as T
  }
  get<T = any>(path: string, query?: ReqOptions['query'], opt: ReqOptions = {}) { return this.json<T>('GET', path, { ...opt, ...(query ? { query } : {}) }) }
  post<T = any>(path: string, body?: unknown, opt: ReqOptions = {}) { return this.json<T>('POST', path, { ...opt, ...(body !== undefined ? { body } : {}) }) }
  put<T = any>(path: string, body?: unknown, opt: ReqOptions = {}) { return this.json<T>('PUT', path, { ...opt, ...(body !== undefined ? { body } : {}) }) }
  patch<T = any>(path: string, body?: unknown, opt: ReqOptions = {}) { return this.json<T>('PATCH', path, { ...opt, ...(body !== undefined ? { body } : {}) }) }
  del<T = any>(path: string, query?: ReqOptions['query']) { return this.json<T>('DELETE', path, query ? { query } : {}) }
  async text(path: string, query?: ReqOptions['query'], opt: ReqOptions = {}): Promise<string> { return (await this.raw('GET', path, { ...opt, ...(query ? { query } : {}), headers: { accept: 'text/plain', ...(opt.headers ?? {}) } })).text() }
}

/** Build a client for a host using stored credentials / DIT_TOKEN. */
export function apiFor(host: string, opts: { flagHost?: string | undefined; session?: string | null; timeoutMs?: number } = {}): Api {
  const tok = findToken(host, opts.flagHost)
  return new Api({ host, token: tok?.token ?? null, session: opts.session ?? null, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
}

/** Wrap API failures so the router prints plain language with a hint. */
export function toDitError(err: unknown): unknown {
  if (err instanceof ApiError) { const d = describeApiError(err.status, err.message, err.body); return new DitError(d.message, 1, d.hint) }
  return err
}
