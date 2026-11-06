// Dithub for VS Code: activate/deactivate wiring.
import * as vscode from 'vscode'
import { Auth } from './auth.ts'
import { assignWithZeroG } from './assign.ts'
import { AssistantPanels } from './assistantPanel.ts'
import { ORIGINAL_SCHEME, TASK_SCHEME, countdown, isLive, type Task } from './core.ts'
import { IssueItem, IssuesView } from './issuesView.ts'
import { submitChanges } from './submit.ts'
import { TaskFileSystem, taskRootUri } from './taskFs.ts'
import { TaskStore } from './taskStore.ts'
import { TaskItem, TasksView } from './tasksView.ts'
import { describe, showError } from './ui.ts'

const taskFolders = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === TASK_SCHEME)

function removeTaskFolder(sessionId: string): void {
  const all = vscode.workspace.workspaceFolders ?? []
  const idx = all.findIndex((f) => f.uri.scheme === TASK_SCHEME && f.uri.authority === sessionId)
  if (idx >= 0) vscode.workspace.updateWorkspaceFolders(idx, 1)
}

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Dithub')
  const auth = new Auth(ctx, log)
  const store = new TaskStore(auth)
  const panels = new AssistantPanels(auth)

  const handleDead = (sessionId: string, why: string) => {
    const t = store.get(sessionId)
    store.markEnded(sessionId, why === 'expired' ? 'expired' : t?.status === 'active' ? 'ended' : t?.status ?? 'ended')
    const name = t ? `${t.repo.owner}/${t.repo.name} #${t.issue.number}` : `session ${sessionId}`
    const unsaved = Object.keys(fs.overlay(sessionId).files).length
    void fs.clearOverlay(sessionId).then(() => fs.forget(sessionId))
    panels.close(sessionId)
    removeTaskFolder(sessionId)
    void vscode.window.showWarningMessage(`Dithub task ${name} is no longer available (${why}). Its folder was removed${unsaved ? ` and ${unsaved} unsubmitted change(s) were discarded` : ''}.`)
  }
  const fs: TaskFileSystem = new TaskFileSystem(ctx, auth, store, handleDead)

  const issuesView = new IssuesView(ctx, auth)
  const tasksView = new TasksView(auth, store, () => { checkExpiry(); updateStatus() })
  const issuesTree = vscode.window.createTreeView('dithub.issues', { treeDataProvider: issuesView, showCollapseAll: false })
  issuesView.view = issuesTree
  const tasksTree = vscode.window.createTreeView('dithub.tasks', { treeDataProvider: tasksView })

  const status = vscode.window.createStatusBarItem('dithub.connect', vscode.StatusBarAlignment.Left, 50)
  status.name = 'Dithub: Connect with 0G'
  status.command = 'dithub.connect'
  async function updateStatus(): Promise<void> {
    if (!(await auth.signedIn())) { status.hide(); return }
    const open = taskFolders().map((f) => store.get(f.uri.authority)).filter((t): t is Task => !!t && isLive(t))
    if (open.length === 1) {
      const t = open[0]!
      status.text = `$(sparkle) 0G · #${t.issue.number} · ${countdown(t.expiresAt)}`
      status.tooltip = `Dithub task ${t.repo.owner}/${t.repo.name} #${t.issue.number}: ${t.issue.title}\nClick to connect another task with 0G`
    } else {
      const n = store.active().length
      status.text = `$(sparkle) Connect with 0G${n ? ` (${n})` : ''}`
      status.tooltip = n ? `Open one of your ${n} Dithub task(s) as a scoped workspace folder` : 'Dithub: no active tasks assigned to you'
    }
    status.show()
  }
  function checkExpiry(): void {
    const now = Date.now()
    for (const f of taskFolders()) {
      const t = store.get(f.uri.authority)
      if (t && !isLive(t, now)) handleDead(t.sessionId, t.status === 'active' ? 'expired' : t.status)
    }
  }
  const tick = setInterval(() => { checkExpiry(); void updateStatus() }, 30_000)

  /** The task an action applies to: tree item argument, else the task folder of the active editor / workspace, else a pick. */
  async function resolveTask(arg: unknown, verb: string): Promise<Task | undefined> {
    if (!(await auth.require())) return undefined
    if (arg instanceof TaskItem) return store.get(arg.task.sessionId) ?? arg.task
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri
    const fromUri = uri && (uri.scheme === TASK_SCHEME || uri.scheme === ORIGINAL_SCHEME) ? uri.authority : undefined
    const folders = taskFolders()
    const sid = fromUri ?? (folders.length === 1 ? folders[0]!.uri.authority : undefined)
    if (sid) { const t = await store.ensure(sid); if (t) return t }
    try { await store.refresh() } catch (err) { showError(err, 'Could not load your tasks'); return undefined }
    const active = store.active()
    if (!active.length) { void vscode.window.showInformationMessage('No active Dithub tasks are assigned to you.'); return undefined }
    if (active.length === 1) return active[0]
    const pick = await vscode.window.showQuickPick(active.map((t) => ({ label: `${t.repo.owner}/${t.repo.name} #${t.issue.number}`, description: `${t.role} · ${countdown(t.expiresAt)}`, detail: t.issue.title, t })), { title: `Which task do you want to ${verb}?` })
    return pick?.t
  }
  const requireLive = (t: Task) => { if (isLive(t)) return true; void vscode.window.showWarningMessage(`This task is ${t.status === 'active' ? 'expired' : t.status}.`); return false }

  ctx.subscriptions.push(
    log, auth, store, panels, fs, issuesView, tasksView, issuesTree, tasksTree, status, { dispose: () => clearInterval(tick) },
    vscode.workspace.registerFileSystemProvider(TASK_SCHEME, fs, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, fs),
    auth.onDidChange(() => { void updateStatus() }),
    store.onDidChange(() => { void updateStatus() }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void updateStatus() }),

    vscode.commands.registerCommand('dithub.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('dithub.signOut', async () => {
      const open = taskFolders()
      if (open.length && (await vscode.window.showWarningMessage('Signing out removes your open task folders. Unsubmitted edits stay saved for this workspace.', { modal: true }, 'Sign out')) !== 'Sign out') return
      for (const f of open) removeTaskFolder(f.uri.authority)
      await auth.signOut()
    }),
    vscode.commands.registerCommand('dithub.chooseRepo', () => issuesView.chooseRepo()),
    vscode.commands.registerCommand('dithub.refreshIssues', () => issuesView.refresh()),
    vscode.commands.registerCommand('dithub.assign', async (item?: IssueItem) => {
      if (!(item instanceof IssueItem)) { void vscode.window.showInformationMessage('Use "Assign with 0G…" on an issue in the Dithub Issues view.'); return }
      await assignWithZeroG(auth, { owner: item.owner, repo: item.repo, number: item.issue.number, title: item.issue.title }, () => issuesView.refresh())
    }),
    vscode.commands.registerCommand('dithub.refreshTasks', () => tasksView.refresh()),

    vscode.commands.registerCommand('dithub.connect', async (arg?: unknown) => {
      const t = await resolveTask(arg, 'connect with 0G'); if (!t || !requireLive(t)) return
      const uri = taskRootUri(t.sessionId)
      if (!taskFolders().some((f) => f.uri.authority === t.sessionId)) {
        const n = vscode.workspace.workspaceFolders?.length ?? 0
        const ok = vscode.workspace.updateWorkspaceFolders(n, 0, { uri, name: `Task ${t.repo.owner}/${t.repo.name} #${t.issue.number}` })
        if (!ok) { void vscode.window.showErrorMessage('VS Code refused to add the task folder to this workspace.'); return }
      }
      await vscode.commands.executeCommand('workbench.view.explorer')
      void vscode.window.showInformationMessage(`Connected to #${t.issue.number} with 0G: only ${t.allowedPaths.join(', ')} are visible. Edits stay in the extension until you run "Dithub: Submit changes".`, 'Show task', 'Ask 0G')
        .then((c) => { if (c === 'Show task') void panels.showTask(t); if (c === 'Ask 0G') void panels.openChat(t) })
    }),
    vscode.commands.registerCommand('dithub.showTask', async (arg?: unknown) => { const t = await resolveTask(arg, 'show'); if (t && requireLive(t)) await panels.showTask(t) }),
    vscode.commands.registerCommand('dithub.ask', async (arg?: unknown) => { const t = await resolveTask(arg, 'ask 0G about'); if (t && requireLive(t)) await panels.openChat(t) }),
    vscode.commands.registerCommand('dithub.submit', async (arg?: unknown) => { const t = await resolveTask(arg, 'submit'); if (t && requireLive(t)) await submitChanges(auth, fs, t) }),
    vscode.commands.registerCommand('dithub.endTask', async (arg?: unknown) => {
      const t = await resolveTask(arg, 'end'); if (!t) return
      const pending = Object.keys(fs.overlay(t.sessionId).files).length
      const ok = await vscode.window.showWarningMessage(`End task ${t.repo.owner}/${t.repo.name} #${t.issue.number}?`, { modal: true, detail: `Your access ends now and the task folder is removed.${pending ? ` ${pending} edited file(s) that were not submitted will be discarded.` : ''}` }, 'End task')
      if (ok !== 'End task') return
      try { await auth.api.endSession(t.sessionId) }
      catch (err) { if (!/already/.test(describe(err))) { showError(err, 'Could not end the task'); return } }
      store.markEnded(t.sessionId)
      await fs.clearOverlay(t.sessionId); fs.forget(t.sessionId)
      panels.close(t.sessionId)
      removeTaskFolder(t.sessionId)
      void tasksView.refresh(true)
      void vscode.window.showInformationMessage(`Task #${t.issue.number} ended.`)
    }),
  )

  void auth.refreshContext().then(() => tasksView.refresh(true)).then(() => updateStatus())
}

export function deactivate(): void { /* disposables are released through ctx.subscriptions */ }
