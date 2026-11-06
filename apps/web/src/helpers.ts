// Pure helpers (no DOM access) so they can be unit tested with bun test.
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const short = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '')
export const ago = (d: string, now = Date.now()) => { const s = (now - new Date(d).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }
import { NETWORK } from './network.ts'
export const etherscanTx = (tx: string) => `${NETWORK.explorer}/tx/${encodeURIComponent(tx)}`
/** Only 0x + 64 hex chars may become an Etherscan link. */
export const isTxHash = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)

/** One path prefix per line; strips blanks and trailing slashes (the API wants `src/payments`, not `src/payments/`). */
export const parsePaths = (text: string) => text.split('\n').map((l) => l.trim().replace(/\/+$/, '')).filter(Boolean)

/** Remaining time as h:mm:ss; "expired" at or past the deadline. */
export function countdown(expiresAt: string, now = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return 'expired'
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string }
export interface DiffFile { path: string; additions: number; deletions: number; lines: DiffLine[] }
/** Parse a unified `git diff`. Never throws; unknown lines are shown as meta. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null, inHunk = false
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw)
      cur = { path: m ? m[2]! : raw.slice(11), additions: 0, deletions: 0, lines: [{ kind: 'meta', text: raw }] }
      files.push(cur); inHunk = false; continue
    }
    if (!cur) { if (raw) { cur = { path: '(diff)', additions: 0, deletions: 0, lines: [] }; files.push(cur) } else continue }
    if (raw.startsWith('@@')) { inHunk = true; cur.lines.push({ kind: 'hunk', text: raw }) }
    else if (inHunk && raw.startsWith('+')) { cur.additions++; cur.lines.push({ kind: 'add', text: raw }) }
    else if (inHunk && raw.startsWith('-')) { cur.deletions++; cur.lines.push({ kind: 'del', text: raw }) }
    else if (inHunk && (raw.startsWith(' ') || raw === '')) cur.lines.push({ kind: 'ctx', text: raw })
    else cur.lines.push({ kind: 'meta', text: raw })
  }
  const last = files[files.length - 1]
  if (last && last.lines[last.lines.length - 1]?.text === '') last.lines.pop()
  return files
}
/** Render parsed files to escaped HTML: one collapsible <details> per file. */
export function renderDiff(files: DiffFile[]): string {
  if (!files.length) return '<p class="muted">No changes.</p>'
  return files.map((f) => `<details class="dfile"${f.lines.length > 400 ? '' : ' open'}><summary><span class="mono">${esc(f.path)}</span> <span class="add-n">+${f.additions}</span> <span class="del-n">-${f.deletions}</span></summary><pre class="diff">${f.lines.map((l) => `<span class="dl ${l.kind}">${esc(l.text) || ' '}</span>`).join('')}</pre></details>`).join('')
}

// ---------------------------------------------------------------- usernames + avatars
/** Top-level paths owned by the app: a username here would shadow a page, so the UI refuses them. */
export const RESERVED_LOGINS = ['new', 'deployments', 'sessions', 'settings', 'orgs', 'docs', 'api', 'git', 'internal', 'login', 'logout', 'admin', 'about', 'explore', 'build', 'static', 'assets']
/** Same rule as PATCH /api/me (1-39 chars of a-z 0-9 -, no leading/trailing hyphen). Returns an error message, or null when fine. */
export function usernameProblem(raw: string): string | null {
  const v = raw.trim()
  if (!v) return 'Choose a username.'
  if (v.length > 39) return 'Use 39 characters or fewer.'
  if (/[A-Z]/.test(v)) return 'Use lowercase letters only.'
  if (!/^[a-z0-9-]+$/.test(v)) return 'Only letters, numbers and hyphens are allowed.'
  if (v.startsWith('-') || v.endsWith('-')) return 'A username cannot start or end with a hyphen.'
  if (RESERVED_LOGINS.includes(v)) return `"${v}" is reserved. Try another.`
  return null
}
/** First sign-in creates `u-<first 8 hex of the wallet>`; until the user renames it they are still onboarding. */
export const isPlaceholderLogin = (login: string, wallet: string | null | undefined) =>
  !!wallet && login === `u-${wallet.slice(2, 10).toLowerCase()}`
/** Stable 0-359 hue per name, so each person and organisation keeps the same avatar colour everywhere. */
export function avatarHue(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) % 360
}
/** Avatar bubble. `size` is one of the CSS size classes: sm | md | lg | xl. */
export const avatarHtml = (name: string, size: 'sm' | 'md' | 'lg' | 'xl' = 'md') =>
  `<span class="avatar ${size}" style="--hue:${avatarHue(name)}" aria-hidden="true">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`
