// Shared task protocol, scope checks and formatting for dit and the VS Code extension. No editor dependencies.
import { countdown as ditCountdown } from '../ui.ts'
import { DEFAULT_HOST } from '../constants.ts'

export { DEFAULT_HOST }

// ---------------------------------------------------------------- logins

/** Same rule as the server (`apps/api/src/sessions.ts` LOGIN). */
export const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/

/** "@Alice " -> "alice"? No: logins are lowercase on the server, so uppercase is rejected with a hint rather than silently changed. */
export function parseLogin(input: string): { ok: true; login: string } | { ok: false; error: string } {
  const s = input.trim().replace(/^@+/, '')
  if (!s) return { ok: false, error: 'Type a Dithub username, for example @alice' }
  if (/\s/.test(s)) return { ok: false, error: 'A username cannot contain spaces' }
  if (s !== s.toLowerCase() && LOGIN_RE.test(s.toLowerCase())) return { ok: false, error: `Usernames are lowercase: did you mean @${s.toLowerCase()}?` }
  if (!LOGIN_RE.test(s)) return { ok: false, error: 'Usernames are 1-39 characters of a-z, 0-9 and "-" (not at the start or end)' }
  return { ok: true, login: s }
}

// ---------------------------------------------------------------- paths and scope (mirrors apps/api/src/sessions.ts)

/** Canonical repo path: NFC, no empty/./.. segments, no leading slash, no control/bidi/zero-width characters, no backslash, no `.git` segment. */
export function normalizePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 1024) return null
  if (/[\u0000-\u001f\u007f\\]/.test(p) || /[​-‏‪-‮⁠-⁤﻿]/.test(p)) return null
  if (p !== p.normalize('NFC') || p.startsWith('/')) return null
  const segs = p.endsWith('/') ? p.slice(0, -1).split('/') : p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) return null
  return segs.join('/')
}
/** A path we may request: additionally no glob or pathspec magic. */
export const normalizeReadPath = (p: unknown): string | null => { const n = normalizePath(p); return n && !/[*?[\]]/.test(n) && !n.startsWith(':') ? n : null }

const segMatch = (pat: string, seg: string) => !pat.includes('*') ? pat === seg
  : new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(seg)

/** True when `path` equals an allowed entry or lies below it (whole segments, case-sensitive like git). */
export function pathInScope(allowedPaths: readonly string[], path: string): boolean {
  const n = normalizeReadPath(path); if (!n) return false
  const p = n.split('/')
  return allowedPaths.some((entry) => {
    const e = entry.replace(/\/$/, '').split('/')
    for (let i = 0; i < e.length; i++) {
      if (e[i] === '**') return true
      if (i >= p.length || !segMatch(e[i]!, p[i]!)) return false
    }
    return true
  })
}
/** True when `dir` ('' = root) is a directory on the way to an allowed entry. */
export function isAncestorOfScope(allowedPaths: readonly string[], dir: string): boolean {
  if (dir !== '' && !normalizeReadPath(dir)) return false
  const d = dir === '' ? [] : dir.split('/')
  return allowedPaths.some((entry) => {
    const e = entry.replace(/\/$/, '').split('/')
    for (let i = 0; i < d.length; i++) {
      if (e[i] === '**') return true
      if (i >= e.length || !segMatch(e[i]!, d[i]!)) return false
    }
    return true
  })
}
/** May this path be shown at all (as a file in scope, or a directory leading to the scope)? */
export const visiblePath = (allowed: readonly string[], path: string, isDir: boolean) =>
  path === '' ? isDir : pathInScope(allowed, path) || (isDir && isAncestorOfScope(allowed, path))
/** May this path be written (created/edited) in the task workspace? */
export const writablePath = (allowed: readonly string[], path: string) => path !== '' && pathInScope(allowed, path)

export interface TreeEntry { type: string; name: string; path: string; size?: number | null; mode?: string; oid?: string; restricted?: boolean }

/** Client-side filter on top of the server's: drops `restricted` names (employee top-level listing), submodules and anything outside the scope. */
export function visibleEntries(allowed: readonly string[], entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.filter((e) => !e.restricted && (e.type === 'blob' || e.type === 'tree') && typeof e.path === 'string' && visiblePath(allowed, e.path, e.type === 'tree'))
}

/** "/src/a.ts" (URI path) -> "src/a.ts"; "/" -> "". Returns null for anything that is not a clean repo path. */
export function repoPathFromUri(uriPath: string): string | null {
  const s = uriPath.replace(/^\/+/, '').replace(/\/+$/, '')
  if (s === '') return ''
  return normalizeReadPath(s)
}
export const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const TASK_SCHEME = 'dithub-task'
export const ORIGINAL_SCHEME = 'dithub-task-original'

// ---------------------------------------------------------------- overlay (the VS Code adapter persists this in workspaceState)

export interface OverlayFile { content: string; mtime: number }
export interface Overlay { version: 1; files: Record<string, OverlayFile>; dirs: string[] }
export const emptyOverlay = (): Overlay => ({ version: 1, files: {}, dirs: [] })

export function parseOverlay(v: unknown): Overlay {
  const o = v as Partial<Overlay> | null | undefined
  if (!o || o.version !== 1 || typeof o.files !== 'object' || !o.files || !Array.isArray(o.dirs)) return emptyOverlay()
  const files: Record<string, OverlayFile> = {}
  for (const [k, f] of Object.entries(o.files)) if (normalizeReadPath(k) && f && typeof f.content === 'string') files[k] = { content: f.content, mtime: Number(f.mtime) || 0 }
  return { version: 1, files, dirs: o.dirs.filter((d): d is string => typeof d === 'string' && !!normalizeReadPath(d)) }
}

/** Overlay entries directly inside `dir` (files and directories, including directories implied by deeper files). */
export function overlayChildren(o: Overlay, dir: string): Array<{ name: string; path: string; type: 'file' | 'dir' }> {
  const out = new Map<string, { name: string; path: string; type: 'file' | 'dir' }>()
  const prefix = dir === '' ? '' : `${dir}/`
  const add = (p: string, isFile: boolean) => {
    if (!p.startsWith(prefix) || p === dir) return
    const rest = p.slice(prefix.length)
    const seg = rest.split('/')[0]!
    const full = prefix + seg
    const type = isFile && !rest.includes('/') ? 'file' : 'dir'
    const prev = out.get(seg)
    if (!prev || (prev.type === 'file' && type === 'dir')) out.set(seg, { name: seg, path: full, type })
  }
  for (const p of Object.keys(o.files)) add(p, true)
  for (const d of o.dirs) add(d, false)
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}
/** Is `p` a directory in the overlay (explicit or implied by a file below it)? */
export const overlayHasDir = (o: Overlay, p: string) => o.dirs.includes(p) || Object.keys(o.files).some((f) => f.startsWith(`${p}/`)) || o.dirs.some((d) => d.startsWith(`${p}/`))

export interface Change { path: string; status: 'added' | 'modified'; content: string }

/** Overlay vs. the session ref: drops edits that were reverted to the original content. `original(path)` is null for files that do not exist at the ref. */
export async function diffOverlay(o: Overlay, original: (path: string) => Promise<string | null>): Promise<Change[]> {
  const out: Change[] = []
  for (const path of Object.keys(o.files).sort()) {
    const base = await original(path)
    const content = o.files[path]!.content
    if (base === null) out.push({ path, status: 'added', content })
    else if (base !== content) out.push({ path, status: 'modified', content })
  }
  return out
}

/** The files-variant proposal body. Refuses (throws) if any path is outside the scope, before any request is made. */
export function buildProposal(allowed: readonly string[], changes: readonly Change[], title: string, body: string): { title: string; body?: string; files: Array<{ path: string; content: string }> } {
  const bad = changes.filter((c) => !writablePath(allowed, c.path)).map((c) => c.path)
  if (bad.length) throw new Error(`these files are outside the task scope: ${bad.join(', ')}`)
  if (!changes.length) throw new Error('there are no changes to submit')
  const t = title.trim()
  return { title: t, ...(body.trim() ? { body: body.trim() } : {}), files: changes.map((c) => ({ path: c.path, content: c.content })) }
}

// ---------------------------------------------------------------- formatting

export const countdown = (iso: string, now = Date.now()) => ditCountdown(iso, now)

/** Description line for a task in the My Tasks view. */
export function taskDescription(t: Task, now = Date.now()): string {
  const left = t.status === 'active' ? countdown(t.expiresAt, now) : t.status
  return `${t.role} · ${left}`
}
export function taskLabel(t: Task): string { return `${t.repo.owner}/${t.repo.name} #${t.issue.number} ${t.issue.title}` }
export function taskTooltip(t: Task, now = Date.now()): string {
  return [
    `${t.repo.owner}/${t.repo.name} #${t.issue.number}: ${t.issue.title}`,
    `Status: ${t.status}${t.status === 'active' ? ` (${countdown(t.expiresAt, now)})` : ''}`,
    `Role: ${t.role}   Ref: ${t.ref}   Assigned by: ${t.createdBy}`,
    'Allowed paths:',
    ...t.allowedPaths.map((p) => `  • ${p}`),
  ].join('\n')
}
export const isLive = (t: Task, now = Date.now()) => t.status === 'active' && Date.parse(t.expiresAt) > now

export const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"'`]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[ch]!)

export function prUrl(host: string, owner: string, repo: string, n: number): string {
  return `${host.replace(/\/$/, '')}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${n}`
}

export const TTL_CHOICES = [
  { label: '2 hours', minutes: 120 },
  { label: '8 hours', minutes: 480, default: true },
  { label: '24 hours', minutes: 1440 },
] as const
export const ROLE_CHOICES = [
  { role: 'contractor', detail: 'Only the chosen files; no repository listing, no clone.', default: true },
  { role: 'employee', detail: 'The chosen files, plus the names (not contents) of top-level entries.' },
] as const

/** Summary text for the assign confirmation modal. */
export function assignSummary(a: { owner: string; repo: string; issue: number; login: string; paths: readonly string[]; role: string; ttlMinutes: number; model?: string | null; requestId?: string | null }): string {
  const hours = a.ttlMinutes % 60 === 0 ? `${a.ttlMinutes / 60}h` : `${a.ttlMinutes}m`
  return [
    `Give @${a.login} a ${a.role} session on ${a.owner}/${a.repo} #${a.issue} for ${hours}.`,
    '',
    `Files (${a.paths.length}):`,
    ...a.paths.map((p) => `  ${p}`),
    '',
    a.model || a.requestId ? `Scope suggested by 0G model ${a.model ?? 'n/a'}, request ${a.requestId ?? 'n/a'}.` : 'Scope chosen manually (no 0G suggestion used).',
    `@${a.login} gets no repository access: only these paths, read-only, until the session ends.`,
  ].join('\n')
}

// ---------------------------------------------------------------- API shapes + defensive parsing

export class ProtocolError extends Error {}
const obj = (v: unknown, what: string): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProtocolError(`unexpected response: ${what} is not an object`); return v as Record<string, unknown> }
const arr = (v: unknown, what: string): unknown[] => { if (!Array.isArray(v)) throw new ProtocolError(`unexpected response: ${what} is not a list`); return v }
const str = (v: unknown, what: string): string => { if (typeof v !== 'string') throw new ProtocolError(`unexpected response: ${what} is not a string`); return v }
const num = (v: unknown, what: string): number => { const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v; if (typeof n !== 'number' || !Number.isFinite(n)) throw new ProtocolError(`unexpected response: ${what} is not a number`); return n }
const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const isoOf = (v: unknown, what: string): string => { if (v instanceof Date) return v.toISOString(); const s = str(v, what); if (Number.isNaN(Date.parse(s))) throw new ProtocolError(`unexpected response: ${what} is not a date`); return s }

export type TaskStatus = 'active' | 'ended' | 'expired' | 'revoked'
export interface Task {
  sessionId: string; repo: { owner: string; name: string }; issue: { number: number; title: string; state: string }
  role: string; allowedPaths: string[]; ref: string; status: TaskStatus; expiresAt: string; createdAt: string; createdBy: string
}
export function parseTasks(v: unknown): Task[] {
  return arr(obj(v, 'body').tasks, 'tasks').map((raw, i) => {
    const t = obj(raw, `tasks[${i}]`), repo = obj(t.repo, 'task.repo'), issue = obj(t.issue, 'task.issue')
    const sessionId = str(t.sessionId, 'task.sessionId')
    if (!UUID_RE.test(sessionId)) throw new ProtocolError('unexpected response: task.sessionId is not a uuid')
    const status = str(t.status, 'task.status') as TaskStatus
    return {
      sessionId, repo: { owner: str(repo.owner, 'repo.owner'), name: str(repo.name, 'repo.name') },
      issue: { number: num(issue.number, 'issue.number'), title: str(issue.title, 'issue.title'), state: optStr(issue.state) ?? 'open' },
      role: str(t.role, 'task.role'), allowedPaths: arr(t.allowedPaths, 'task.allowedPaths').map((p) => str(p, 'allowedPaths[]')),
      ref: str(t.ref, 'task.ref'), status: (['active', 'ended', 'expired', 'revoked'].includes(status) ? status : 'ended') as TaskStatus,
      expiresAt: isoOf(t.expiresAt, 'task.expiresAt'), createdAt: isoOf(t.createdAt, 'task.createdAt'), createdBy: optStr(t.createdBy) ?? '',
    }
  })
}

export interface ScopeSuggestion { paths: Array<{ path: string; kind: 'file' | 'dir'; reason: string }>; model: string | null; requestId: string | null; sealed: boolean; ref: string | null; considered: number | null }
/** Suggestions are kept only if they are clean repo paths: the extension never invents or "fixes" a path. */
export function parseSuggestScope(v: unknown): ScopeSuggestion {
  const b = obj(v, 'body')
  const seen = new Set<string>()
  const paths = arr(b.paths, 'paths').flatMap((raw, i) => {
    const p = obj(raw, `paths[${i}]`)
    const path = normalizeReadPath(str(p.path, 'paths[].path').replace(/\/$/, ''))
    if (!path || seen.has(path)) return []
    seen.add(path)
    return [{ path, kind: p.kind === 'dir' ? 'dir' as const : 'file' as const, reason: optStr(p.reason) ?? '' }]
  })
  return { paths, model: optStr(b.model), requestId: optStr(b.requestId), sealed: b.sealed === true, ref: optStr(b.ref), considered: typeof b.considered === 'number' ? b.considered : null }
}

export interface MaintainedRepo { owner: string; name: string; visibility: string; permission: string; defaultBranch: string; repoId: string | null }
export function parseMyRepos(v: unknown): MaintainedRepo[] {
  return arr(obj(v, 'body').repos, 'repos').map((raw, i) => {
    const r = obj(raw, `repos[${i}]`)
    return { owner: str(r.owner, 'repo.owner'), name: str(r.name, 'repo.name'), visibility: optStr(r.visibility) ?? 'public', permission: optStr(r.permission) ?? '', defaultBranch: optStr(r.defaultBranch) ?? 'main', repoId: optStr(r.repoId) }
  })
}

export interface Issue { number: number; title: string; state: string; author: string | null; assignees: string[]; labels: string[]; updatedAt: string | null }
export function parseIssues(v: unknown): Issue[] {
  return arr(obj(v, 'body').issues, 'issues').map((raw, i) => {
    const x = obj(raw, `issues[${i}]`)
    return {
      number: num(x.number, 'issue.number'), title: str(x.title, 'issue.title'), state: optStr(x.state) ?? 'open', author: optStr(x.author),
      assignees: Array.isArray(x.assignees) ? x.assignees.filter((a): a is string => typeof a === 'string') : [],
      labels: Array.isArray(x.labels) ? x.labels.map((l) => (l && typeof l === 'object' ? optStr((l as { name?: unknown }).name) : null)).filter((l): l is string => !!l) : [],
      updatedAt: optStr(x.updatedAt),
    }
  })
}

export function parseTree(v: unknown): TreeEntry[] {
  return arr(obj(v, 'body').entries, 'entries').map((raw, i) => {
    const e = obj(raw, `entries[${i}]`)
    return { type: optStr(e.type) ?? 'blob', name: str(e.name, 'entry.name'), path: str(e.path, 'entry.path'), size: typeof e.size === 'number' ? e.size : null, ...(e.restricted === true ? { restricted: true } : {}) }
  })
}

export interface Blob { path: string; size: number; binary: boolean; truncated: boolean; content: string | null }
export function parseBlob(v: unknown): Blob {
  const b = obj(v, 'body')
  return { path: str(b.path, 'blob.path'), size: typeof b.size === 'number' ? b.size : 0, binary: b.binary === true, truncated: b.truncated === true, content: typeof b.content === 'string' ? b.content : null }
}

export interface AssistantAnswer { callId: string | null; refused: boolean; reason: string | null; answer: string | null; requestId: string | null; model: string | null; sealed: boolean; teeVerified: boolean | null; filesUsed: string[]; createdAt: string | null }
export function parseAssistant(v: unknown): AssistantAnswer {
  const b = obj(v, 'body')
  return {
    callId: b.callId == null ? null : String(b.callId), refused: b.refused === true, reason: optStr(b.reason), answer: optStr(b.answer), requestId: optStr(b.requestId), model: optStr(b.model),
    sealed: b.sealed === true, teeVerified: typeof b.teeVerified === 'boolean' ? b.teeVerified : null,
    filesUsed: Array.isArray(b.filesUsed) ? b.filesUsed.filter((f): f is string => typeof f === 'string') : [], createdAt: optStr(b.createdAt),
  }
}
export interface AssistantCall { id: string; kind: string; model: string | null; requestId: string | null; refused: boolean; refusalReason: string | null; sealed: boolean; question: string | null; answer: string | null; failed: boolean; createdAt: string | null }
export function parseCalls(v: unknown): AssistantCall[] {
  return arr(obj(v, 'body').calls, 'calls').map((raw, i) => {
    const c = obj(raw, `calls[${i}]`)
    return { id: String(c.id ?? i), kind: optStr(c.kind) ?? 'ask', model: optStr(c.model), requestId: optStr(c.requestId), refused: c.refused === true, refusalReason: optStr(c.refusalReason), sealed: c.sealed === true, question: optStr(c.question), answer: optStr(c.answer), failed: c.failed === true, createdAt: optStr(c.createdAt) }
  })
}

export interface ProposalResult { branch: string; commit: string; pullRequest: number; files: number }
export function parseProposal(v: unknown): ProposalResult {
  const b = obj(v, 'body')
  return { branch: str(b.branch, 'branch'), commit: str(b.commit, 'commit'), pullRequest: num(b.pullRequest, 'pullRequest'), files: typeof b.files === 'number' ? b.files : Array.isArray(b.files) ? b.files.length : 0 }
}

export interface SessionView { id: string; issueNumber: number; user: string; role: string; allowedPaths: string[]; ref: string; status: string; expiresAt: string }
export function parseSession(v: unknown): SessionView {
  const s = obj(v, 'body')
  return { id: str(s.id, 'session.id'), issueNumber: num(s.issueNumber, 'session.issueNumber'), user: optStr(s.user) ?? '', role: str(s.role, 'session.role'), allowedPaths: arr(s.allowedPaths, 'allowedPaths').map((p) => str(p, 'allowedPaths[]')), ref: optStr(s.ref) ?? '', status: optStr(s.status) ?? 'active', expiresAt: isoOf(s.expiresAt, 'session.expiresAt') }
}

// ---------------------------------------------------------------- errors -> plain language

export interface ApiErrorLike { status: number; message: string; body: unknown }

/** One sentence the user can act on. Always carries the server's reason; never contains a token (the server never echoes it). */
export function friendlyError(e: ApiErrorLike, context = ''): string {
  const pre = context ? `${context}: ` : ''
  const b = e.body as { paths?: unknown; blockers?: unknown } | null
  const paths = Array.isArray(b?.paths) ? (b!.paths as unknown[]).filter((p): p is string => typeof p === 'string') : []
  const tail = paths.length ? ` (paths: ${paths.join(', ')})` : ''
  switch (e.status) {
    case 0: return `${pre}${e.message}`
    case 401: return `${pre}you are not signed in to Dithub, or your token was revoked. Run "Dithub: Sign in".`
    case 403: return `${pre}permission denied: ${e.message}${tail}`
    case 404: return `${pre}not found: ${e.message} (it may not exist, or you may not have access)`
    case 409: return `${pre}conflict: ${e.message}`
    case 410: return `${pre}the task session has expired`
    case 422: return `${pre}rejected: ${e.message}${tail}`
    case 429: return `${pre}rate limited: ${e.message}. Wait a moment and try again.`
    case 502: return `${pre}0G or an upstream service is unavailable: ${e.message}`
    case 503: return `${pre}service unavailable: ${e.message}`
    default: return e.status >= 500 ? `${pre}server error (${e.status}): ${e.message}` : `${pre}${e.message} (HTTP ${e.status})${tail}`
  }
}

/** A tree/blob 403 with this reason means the session itself is gone (ended, revoked or expired), not just a denied path. */
export const isDeadSessionError = (e: ApiErrorLike) => (e.status === 403 && /invalid, expired or revoked session|session is not active/i.test(e.message)) || e.status === 410
