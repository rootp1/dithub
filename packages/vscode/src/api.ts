// Typed Dithub API client used by the extension (and by scripts/e2e-vscode-api.ts). NO `vscode` import here.
// The token only ever travels in the Authorization header; it is never put in a URL, logged, or included in an error.
import { ApiError } from '../../dit/src/errors.ts'
import { normalizeHost } from '../../dit/src/config.ts'
import {
  normalizeReadPath, parseAssistant, parseBlob, parseCalls, parseIssues, parseMyRepos, parseProposal, parseSession, parseSuggestScope, parseTasks, parseTree,
  pathInScope, isAncestorOfScope, LOGIN_RE, UUID_RE,
  type AssistantAnswer, type AssistantCall, type Blob, type Issue, type MaintainedRepo, type ProposalResult, type ScopeSuggestion, type SessionView, type Task, type TreeEntry,
} from './core.ts'

export { ApiError, normalizeHost }

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>
export interface ClientOptions {
  host: string
  /** Returns the bearer token or null (anonymous). Called per request so sign-in/out takes effect immediately. */
  getToken?: () => Promise<string | null> | string | null
  fetch?: FetchFn
  timeoutMs?: number
  userAgent?: string
  /** Called once per 401 (before the error is thrown). */
  onUnauthorized?: () => void
}
interface Req { query?: Record<string, string | number | undefined | null>; body?: unknown; session?: string; timeoutMs?: number; anonymous?: boolean; token?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const seg = (s: string) => encodeURIComponent(s)

/** The repo coordinates and scope a session-header request is checked against before anything is sent. */
export interface ScopedTarget { owner: string; repo: string; ref: string; sessionId: string; allowedPaths: readonly string[] }

export class OutOfScopeError extends Error {
  constructor(readonly path: string) { super(`${path || '/'} is outside the scope of this task`) }
}

export class DithubClient {
  readonly host: string
  private readonly f: FetchFn
  constructor(private readonly o: ClientOptions) {
    this.host = normalizeHost(o.host)
    this.f = o.fetch ?? ((u, i) => fetch(u, i))
  }

  url(path: string, query?: Req['query']): string {
    const u = new URL(path, this.host)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    return u.toString()
  }

  /** Low-level JSON request. GETs are retried on network errors and 502/503; everything else is sent once. */
  async request<T = unknown>(method: string, path: string, r: Req = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.o.userAgent ?? 'dithub-vscode/0.1.0' }
    const token = r.token ?? (r.anonymous ? null : await this.o.getToken?.())
    if (token) headers.authorization = `Bearer ${token}`
    if (r.session) {
      if (!UUID_RE.test(r.session)) throw new ApiError(0, 'invalid session id')
      headers['x-dheet-session'] = r.session
    }
    let body: string | undefined
    if (r.body !== undefined) { body = JSON.stringify(r.body); headers['content-type'] = 'application/json' }
    const attempts = method === 'GET' ? 3 : 1
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      let res: Response
      try {
        res = await this.f(this.url(path, r.query), { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(r.timeoutMs ?? this.o.timeoutMs ?? 30_000), redirect: 'manual' })
      } catch (err) {
        last = err
        if (i < attempts - 1) { await sleep(300 * 2 ** i); continue }
        const e = err as Error
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        throw new ApiError(0, timeout ? `the request to ${this.host} timed out` : `cannot reach ${this.host}: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}`)
      }
      if ((res.status === 502 || res.status === 503) && i < attempts - 1) { await sleep(300 * 2 ** i); continue }
      if (res.status >= 300 && res.status < 400) {
        // Never follow redirects automatically (the Authorization header must not go to a host the user did not choose),
        // but say clearly where the server moved so the caller can offer to switch.
        const loc = res.headers.get('location')
        let movedTo: string | null = null
        try { if (loc) { const u = new URL(loc, this.host); if (u.protocol === 'https:') movedTo = u.origin } } catch { /* ignore */ }
        throw new ApiError(res.status, movedTo && movedTo !== this.host ? `Dithub has moved: ${this.host} now redirects to ${movedTo}` : `unexpected redirect from ${this.host}`, { movedTo })
      }
      const text = await res.text().catch(() => '')
      let parsed: unknown = null
      try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON */ }
      if (!res.ok) {
        const reason = typeof (parsed as { error?: unknown } | null)?.error === 'string' ? (parsed as { error: string }).error
          : (parsed as { error?: { message?: string } } | null)?.error?.message ?? (text.trim().slice(0, 200) || res.statusText || 'request failed')
        if (res.status === 401) this.o.onUnauthorized?.()
        throw new ApiError(res.status, reason, parsed)
      }
      if (res.status >= 300) throw new ApiError(res.status, `unexpected redirect from ${this.host}`)
      return parsed as T
    }
    throw new ApiError(0, `cannot reach ${this.host}: ${String((last as Error)?.message ?? last)}`)
  }

  // ------------------------------------------------------------ auth (device code, RFC 8628 style; see apps/api/src/cli-auth.ts)
  startDeviceLogin(clientName: string) {
    return this.request<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>('POST', '/api/cli/device', { body: { name: clientName }, anonymous: true })
  }
  /** One poll. Never throws for the expected protocol states. */
  async pollDeviceToken(deviceCode: string): Promise<{ status: 'ok'; token: string; login: string } | { status: 'pending' | 'slow_down' | 'denied' | 'expired' }> {
    try {
      const t = await this.request<{ token: string; login: string }>('POST', '/api/cli/token', { body: { deviceCode }, anonymous: true })
      if (typeof t?.token !== 'string' || typeof t?.login !== 'string') throw new ApiError(0, 'unexpected token response')
      return { status: 'ok', token: t.token, login: t.login }
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === 0) throw err
      const code = (err.body as { error?: unknown } | null)?.error ?? err.message
      if (code === 'authorization_pending') return { status: 'pending' }
      if (code === 'slow_down') return { status: 'slow_down' }
      if (code === 'access_denied') return { status: 'denied' }
      if (code === 'expired_token' || code === 'invalid_grant') return { status: 'expired' }
      throw err
    }
  }
  /** Revoke a token server-side (sign out). Returns false if the server says it was already invalid. */
  async revokeToken(token: string): Promise<boolean> {
    try { await this.request('DELETE', '/api/cli/token', { token }); return true }
    catch (err) { if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return false; throw err }
  }
  async me(token?: string): Promise<{ login: string } | null> {
    const r = await this.request<{ user: { login: string } | null }>('GET', '/api/me', token ? { token } : {})
    return r?.user && typeof r.user.login === 'string' ? { login: r.user.login } : null
  }

  // ------------------------------------------------------------ maintainer
  async myRepos(min: 'read' | 'triage' | 'write' | 'maintain' | 'admin' = 'maintain'): Promise<MaintainedRepo[]> {
    return parseMyRepos(await this.request('GET', '/api/me/repos', { query: { min } }))
  }
  async issues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', page = 1): Promise<Issue[]> {
    return parseIssues(await this.request('GET', `/api/repos/${seg(owner)}/${seg(repo)}/issues`, { query: { state, per_page: 100, page } }))
  }
  async suggestScope(owner: string, repo: string, issue: number, opt: { maxPaths?: number; ref?: string } = {}): Promise<ScopeSuggestion> {
    return parseSuggestScope(await this.request('POST', `/api/repos/${seg(owner)}/${seg(repo)}/issues/${issue}/suggest-scope`, { body: { maxPaths: opt.maxPaths ?? 8, ...(opt.ref ? { ref: opt.ref } : {}) }, timeoutMs: 150_000 }))
  }
  async assign(owner: string, repo: string, issue: number, logins: string[]): Promise<string[]> {
    if (!logins.length || logins.some((l) => !LOGIN_RE.test(l))) throw new ApiError(0, 'invalid username')
    const r = await this.request<{ assignees?: unknown }>('POST', `/api/repos/${seg(owner)}/${seg(repo)}/issues/${issue}/assignees`, { body: { assignees: logins } })
    return Array.isArray(r?.assignees) ? r.assignees.filter((a): a is string => typeof a === 'string') : []
  }
  async createSession(owner: string, repo: string, b: { issueNumber: number; login: string; role: 'contractor' | 'employee'; paths: string[]; ttlMinutes: number; ref?: string }): Promise<SessionView> {
    if (!LOGIN_RE.test(b.login)) throw new ApiError(0, 'invalid username')
    const bad = b.paths.filter((p) => !normalizeReadPath(p))
    if (!b.paths.length || bad.length) throw new ApiError(0, bad.length ? `invalid path: ${bad.join(', ')}` : 'choose at least one path')
    return parseSession(await this.request('POST', `/api/repos/${seg(owner)}/${seg(repo)}/sessions`, { body: b }))
  }
  /** Plain (unscoped) tree listing, used to validate manually-added paths. */
  async repoTree(owner: string, repo: string, path = '', ref?: string): Promise<TreeEntry[]> {
    return parseTree(await this.request('GET', `/api/repos/${seg(owner)}/${seg(repo)}/tree`, { query: { path, ...(ref ? { ref } : {}) } }))
  }

  // ------------------------------------------------------------ developer
  async tasks(): Promise<Task[]> { return parseTasks(await this.request('GET', '/api/tasks')) }

  /** Scoped directory listing. Paths outside the scope are refused locally: no request is made. */
  async scopedTree(t: ScopedTarget, dir: string): Promise<TreeEntry[]> {
    if (dir !== '' && !(normalizeReadPath(dir) && (pathInScope(t.allowedPaths, dir) || isAncestorOfScope(t.allowedPaths, dir)))) throw new OutOfScopeError(dir)
    return parseTree(await this.request('GET', `/api/repos/${seg(t.owner)}/${seg(t.repo)}/tree`, { query: { path: dir, ref: t.ref }, session: t.sessionId }))
  }
  /** Scoped file read. Paths outside the scope are refused locally: no request is made. */
  async scopedBlob(t: ScopedTarget, path: string): Promise<Blob> {
    if (!normalizeReadPath(path) || !pathInScope(t.allowedPaths, path)) throw new OutOfScopeError(path)
    return parseBlob(await this.request('GET', `/api/repos/${seg(t.owner)}/${seg(t.repo)}/blob`, { query: { path, ref: t.ref }, session: t.sessionId }))
  }
  async sessionIssue(id: string): Promise<{ number: number; title: string; body: string | null; state: string }> {
    const r = await this.request<{ number: number; title: string; body: string | null; state: string }>('GET', `/api/sessions/${seg(id)}/issue`)
    return { number: Number(r.number), title: String(r.title ?? ''), body: typeof r.body === 'string' ? r.body : null, state: String(r.state ?? '') }
  }
  async summarize(id: string): Promise<AssistantAnswer> { return parseAssistant(await this.request('POST', `/api/sessions/${seg(id)}/assistant/summarize`, { body: {}, timeoutMs: 180_000 })) }
  async ask(id: string, question: string): Promise<AssistantAnswer> { return parseAssistant(await this.request('POST', `/api/sessions/${seg(id)}/assistant/ask`, { body: { question }, timeoutMs: 180_000 })) }
  async assistantCalls(id: string): Promise<AssistantCall[]> { return parseCalls(await this.request('GET', `/api/sessions/${seg(id)}/assistant/calls`)) }
  /** Files-variant proposal. Every path is checked against the scope locally first. */
  async proposeFiles(id: string, allowedPaths: readonly string[], b: { title?: string; body?: string; files: Array<{ path: string; content: string }> }): Promise<ProposalResult> {
    const bad = b.files.filter((f) => !pathInScope(allowedPaths, f.path)).map((f) => f.path)
    if (bad.length) throw new ApiError(422, 'these files are outside the task scope', { error: 'outside scope', paths: bad })
    return parseProposal(await this.request('POST', `/api/sessions/${seg(id)}/proposals`, { body: b, timeoutMs: 120_000 }))
  }
  async endSession(id: string): Promise<SessionView> { return parseSession(await this.request('POST', `/api/sessions/${seg(id)}/end`, { body: {} })) }
}
