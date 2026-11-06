// Maintainer flow: "Assign with 0G…" on an issue.
// @username -> 0G suggests files (suggest-scope) -> maintainer reviews paths -> role -> TTL -> confirm -> assign + create session.
import * as vscode from 'vscode'
import { ApiError } from './api.ts'
import type { Auth } from './auth.ts'
import { ROLE_CHOICES, TTL_CHOICES, assignSummary, normalizeReadPath, parentOf, parseLogin, type ScopeSuggestion } from './core.ts'
import { describe, showError } from './ui.ts'

export interface IssueRef { owner: string; repo: string; number: number; title: string }

type PathItem = vscode.QuickPickItem & { path: string }

/** Ask for one path and check it against the repository tree (when the tree can be read). */
async function addManualPath(auth: Auth, issue: IssueRef, existing: Set<string>): Promise<PathItem | undefined> {
  const raw = await vscode.window.showInputBox({
    title: `Add a path to the task scope (${issue.owner}/${issue.repo})`,
    prompt: 'A file or folder path relative to the repository root, e.g. src/payments or src/payments/retry.ts',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const p = normalizeReadPath(v.trim().replace(/\/$/, ''))
      if (!p) return 'Not a valid repository path (no leading "/", "..", backslashes or wildcards)'
      if (existing.has(p)) return 'That path is already in the list'
      return null
    },
  })
  if (!raw) return undefined
  const path = normalizeReadPath(raw.trim().replace(/\/$/, ''))!
  let kind: 'file' | 'dir' | null = null, checked = false
  try {
    const entries = await auth.api.repoTree(issue.owner, issue.repo, parentOf(path))
    checked = true
    const e = entries.find((x) => x.path === path)
    if (e) kind = e.type === 'tree' ? 'dir' : 'file'
  } catch { /* tree unreadable: cannot validate */ }
  if (!kind) {
    const msg = checked ? `${path} does not exist in ${issue.owner}/${issue.repo} (default branch). Add it anyway (for example, a file the developer should create)?` : `Could not check ${path} against the repository tree. Add it anyway?`
    if ((await vscode.window.showWarningMessage(msg, { modal: true }, 'Add anyway')) !== 'Add anyway') return undefined
  }
  return { label: path, path, description: kind === 'dir' ? 'folder · added manually' : kind === 'file' ? 'file · added manually' : 'added manually (not found in the tree)', picked: true }
}

/** Multi-select of paths, all pre-selected, with a title-bar button to add a path manually. */
async function pickPaths(auth: Auth, issue: IssueRef, initial: PathItem[], banner: string): Promise<string[] | undefined> {
  let items = initial
  let selected = new Set(initial.filter((i) => i.picked !== false).map((i) => i.path))
  const addButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: 'Add a path manually' }
  for (;;) {
    const result = await new Promise<{ kind: 'done'; paths: string[] } | { kind: 'add'; keep: Set<string> } | { kind: 'cancel' }>((resolve) => {
      const qp = vscode.window.createQuickPick<PathItem>()
      qp.title = `Files for ${issue.owner}/${issue.repo} #${issue.number}`
      qp.placeholder = items.length ? `${banner} Uncheck anything that is not needed; use + to add a path.` : 'No paths yet: press + (top right) to add one manually.'
      qp.canSelectMany = true
      qp.ignoreFocusOut = true
      qp.matchOnDescription = true
      qp.matchOnDetail = true
      qp.buttons = [addButton]
      qp.items = items
      qp.selectedItems = items.filter((i) => selected.has(i.path))
      let settled = false
      const finish = (v: Parameters<typeof resolve>[0]) => { if (settled) return; settled = true; resolve(v); qp.hide() }
      qp.onDidTriggerButton((b) => { if (b === addButton) finish({ kind: 'add', keep: new Set(qp.selectedItems.map((i) => i.path)) }) })
      qp.onDidAccept(() => finish({ kind: 'done', paths: qp.selectedItems.map((i) => i.path) }))
      qp.onDidHide(() => { finish({ kind: 'cancel' }); qp.dispose() })
      qp.show()
    })
    if (result.kind === 'cancel') return undefined
    if (result.kind === 'add') {
      selected = result.keep
      const added = await addManualPath(auth, issue, new Set(items.map((i) => i.path)))
      if (added) { items = [...items, added]; selected.add(added.path) }
      continue
    }
    if (!result.paths.length) {
      const c = await vscode.window.showWarningMessage('Select at least one path: the developer gets access to nothing else.', 'Add a path', 'Back')
      if (c === 'Add a path') { const added = await addManualPath(auth, issue, new Set(items.map((i) => i.path))); if (added) { items = [...items, added]; selected.add(added.path) } }
      else if (c !== 'Back') return undefined
      continue
    }
    if (result.paths.length > 50) { void vscode.window.showWarningMessage('A session can have at most 50 paths.'); selected = new Set(result.paths); continue }
    return result.paths
  }
}

export async function assignWithZeroG(auth: Auth, issue: IssueRef, onDone: () => void): Promise<void> {
  if (!(await auth.require())) return
  // 1. who
  const loginRaw = await vscode.window.showInputBox({
    title: `Assign ${issue.owner}/${issue.repo} #${issue.number} with 0G`, prompt: `Developer's Dithub username for "${issue.title}"`, placeHolder: '@username', ignoreFocusOut: true,
    validateInput: (v) => { const r = parseLogin(v); return r.ok ? null : r.error },
  })
  if (loginRaw === undefined) return
  const lr = parseLogin(loginRaw); if (!lr.ok) return
  const login = lr.login

  // 2. 0G picks the files
  let suggestion: ScopeSuggestion | null = null
  let banner = ''
  try {
    suggestion = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '0G is reading the issue and choosing files…', cancellable: false },
      () => auth.api.suggestScope(issue.owner, issue.repo, issue.number, { maxPaths: 8 }))
    banner = `0G (${suggestion.model ?? 'model n/a'}${suggestion.sealed ? ', sealed' : ''}) suggested ${suggestion.paths.length} path(s).`
    if (!suggestion.paths.length) {
      const c = await vscode.window.showWarningMessage('0G did not find any relevant files for this issue. Pick the paths manually?', 'Pick manually', 'Cancel')
      if (c !== 'Pick manually') return
    }
  } catch (err) {
    if (err instanceof ApiError && [0, 429, 502, 503, 504].includes(err.status)) {
      const why = err.status === 429 ? 'the 0G suggestion service is rate limited' : err.status === 0 ? err.message : `0G could not suggest files (${err.status}: ${err.message})`
      const c = await vscode.window.showWarningMessage(`${why}. No paths were suggested; nothing was guessed. Pick the paths manually instead?`, 'Pick manually', 'Cancel')
      if (c !== 'Pick manually') return
    } else { showError(err, 'Could not get 0G file suggestions'); return }
  }
  const initial: PathItem[] = (suggestion?.paths ?? []).map((p) => ({ label: p.path, path: p.path, description: p.kind === 'dir' ? 'folder' : 'file', ...(p.reason ? { detail: p.reason } : {}), picked: true }))
  if (!initial.length) {
    const first = await addManualPath(auth, issue, new Set())
    if (!first) return
    initial.push(first)
  }
  const paths = await pickPaths(auth, issue, initial, banner)
  if (!paths) return

  // 3. role and TTL
  const role = await vscode.window.showQuickPick(ROLE_CHOICES.map((r) => ({ label: r.role, description: 'default' in r && r.default ? 'default' : '', detail: r.detail, role: r.role })), { title: `Role for @${login}`, ignoreFocusOut: true })
  if (!role) return
  const ttl = await vscode.window.showQuickPick(TTL_CHOICES.map((t) => ({ label: t.label, description: 'default' in t && t.default ? 'default' : '', minutes: t.minutes })).sort((a, b) => Number(!!b.description) - Number(!!a.description)), { title: 'How long should access last?', ignoreFocusOut: true })
  if (!ttl) return

  // 4. confirm
  const summary = assignSummary({ owner: issue.owner, repo: issue.repo, issue: issue.number, login, paths, role: role.role, ttlMinutes: ttl.minutes, model: suggestion?.model ?? null, requestId: suggestion?.requestId ?? null })
  const ok = await vscode.window.showWarningMessage(`Assign #${issue.number} to @${login}?`, { modal: true, detail: summary }, 'Assign')
  if (ok !== 'Assign') return

  // 5. assign + session
  try {
    const session = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Assigning #${issue.number} to @${login}…` }, async () => {
      await auth.api.assign(issue.owner, issue.repo, issue.number, [login])
      return auth.api.createSession(issue.owner, issue.repo, { issueNumber: issue.number, login, role: role.role, paths, ttlMinutes: ttl.minutes })
    })
    onDone()
    const c = await vscode.window.showInformationMessage(
      `@${login} is assigned to #${issue.number} with a ${session.role} session (${session.allowedPaths.length} path(s), until ${new Date(session.expiresAt).toLocaleString()}). Session id: ${session.id}. They will see it under "My Tasks" in VS Code.`,
      'Copy session id')
    if (c === 'Copy session id') await vscode.env.clipboard.writeText(session.id)
  } catch (err) {
    onDone()
    void vscode.window.showErrorMessage(describe(err, `Could not assign #${issue.number} to @${login}`))
  }
}
