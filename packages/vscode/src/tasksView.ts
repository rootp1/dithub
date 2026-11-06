// "My Tasks": the tickets assigned to the signed-in developer (GET /api/tasks).
import * as vscode from 'vscode'
import type { Auth } from './auth.ts'
import type { TaskStore } from './taskStore.ts'
import { isLive, taskDescription, taskLabel, taskTooltip, type Task } from './core.ts'
import { describe } from './ui.ts'

export class TaskItem extends vscode.TreeItem {
  constructor(readonly task: Task, now = Date.now()) {
    super(taskLabel(task), vscode.TreeItemCollapsibleState.None)
    const live = isLive(task, now)
    this.id = task.sessionId
    this.description = taskDescription(task, now)
    this.tooltip = taskTooltip(task, now)
    this.contextValue = live ? 'dithub.task.active' : 'dithub.task.inactive'
    this.iconPath = new vscode.ThemeIcon(live ? 'issues' : 'circle-slash', live ? undefined : new vscode.ThemeColor('disabledForeground'))
    if (live) this.command = { command: 'dithub.connect', title: 'Connect with 0G', arguments: [this] }
  }
}
class MessageItem extends vscode.TreeItem {
  constructor(label: string, icon = 'info', command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
    if (command) this.command = command
  }
}

export class TasksView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly subs: vscode.Disposable[] = []

  constructor(private readonly auth: Auth, private readonly store: TaskStore, private readonly onTick: () => void) {
    this.subs.push(store.onDidChange(() => this.emitter.fire()))
    this.subs.push(auth.onDidChange(() => { store.clear(); void this.refresh() }))
    this.timer = setInterval(() => { void this.refresh(true) }, 60_000)
  }

  async refresh(quiet = false): Promise<void> {
    if (!(await this.auth.signedIn())) { this.error = null; this.emitter.fire(); return }
    try { await this.store.refresh(); this.error = null }
    catch (err) { this.error = describe(err, 'Could not load your tasks'); if (!quiet) this.emitter.fire() }
    this.emitter.fire()
    this.onTick()
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem { return e }

  async getChildren(e?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (e) return []
    if (!(await this.auth.signedIn())) return []
    if (this.error) return [new MessageItem(this.error, 'error', { command: 'dithub.refreshTasks', title: 'Retry' })]
    const now = Date.now()
    const tasks = this.store.all().sort((a, b) => Number(isLive(b, now)) - Number(isLive(a, now)) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
    return tasks.map((t) => new TaskItem(t, now))
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.emitter.dispose(); for (const s of this.subs) s.dispose() }
}
