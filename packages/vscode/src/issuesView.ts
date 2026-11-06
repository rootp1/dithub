// "Issues": open issues of a repository the signed-in user maintains.
import * as vscode from 'vscode'
import type { Auth } from './auth.ts'
import type { Issue, MaintainedRepo } from './core.ts'
import { describe, showError } from './ui.ts'

const REPO_KEY = 'dithub.issuesRepo'

export class IssueItem extends vscode.TreeItem {
  constructor(readonly owner: string, readonly repo: string, readonly issue: Issue) {
    super(`#${issue.number} ${issue.title}`, vscode.TreeItemCollapsibleState.None)
    this.id = `${owner}/${repo}#${issue.number}`
    this.contextValue = 'dithub.issue'
    this.description = issue.assignees.length ? issue.assignees.map((a) => `@${a}`).join(' ') : ''
    this.tooltip = new vscode.MarkdownString().appendText(`${owner}/${repo} #${issue.number}: ${issue.title}\n`)
      .appendText(issue.labels.length ? `Labels: ${issue.labels.join(', ')}\n` : '')
      .appendText(issue.assignees.length ? `Assigned: ${issue.assignees.join(', ')}\n` : 'Not assigned\n')
      .appendText('Use "Assign with 0G…" to give a developer access to only the files this issue needs.')
    this.iconPath = new vscode.ThemeIcon('issue-opened', new vscode.ThemeColor('charts.green'))
  }
}
class MessageItem extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
    if (command) this.command = command
  }
}

export class IssuesView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event
  view: vscode.TreeView<vscode.TreeItem> | undefined
  private readonly subs: vscode.Disposable[] = []

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly auth: Auth) {
    this.subs.push(auth.onDidChange(() => this.refresh()))
  }

  get repo(): { owner: string; name: string } | null {
    const r = this.ctx.globalState.get<{ host: string; owner: string; name: string }>(REPO_KEY)
    return r && r.host === this.auth.host ? { owner: r.owner, name: r.name } : null
  }

  refresh(): void {
    const r = this.repo
    if (this.view) this.view.description = r ? `${r.owner}/${r.name}` : ''
    this.emitter.fire()
  }

  async chooseRepo(): Promise<void> {
    if (!(await this.auth.require())) return
    let repos: MaintainedRepo[]
    try {
      repos = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Dithub: loading repositories' }, () => this.auth.api.myRepos('maintain'))
    } catch (err) { showError(err, 'Could not list your repositories'); return }
    if (!repos.length) { void vscode.window.showInformationMessage('You do not maintain any Dithub repository yet (maintain or admin permission is needed to assign tasks).'); return }
    const pick = await vscode.window.showQuickPick(repos.map((r) => ({ label: `${r.owner}/${r.name}`, description: `${r.visibility} · ${r.permission}`, detail: `default branch ${r.defaultBranch}`, r })), { title: 'Dithub: choose a repository you maintain', matchOnDescription: true })
    if (!pick) return
    await this.ctx.globalState.update(REPO_KEY, { host: this.auth.host, owner: pick.r.owner, name: pick.r.name })
    this.refresh()
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem { return e }

  async getChildren(e?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (e) return []
    if (!(await this.auth.signedIn())) return []
    const r = this.repo
    if (!r) return [new MessageItem('Choose a repository…', 'repo', { command: 'dithub.chooseRepo', title: 'Choose repository' })]
    try {
      const issues = await this.auth.api.issues(r.owner, r.name, 'open')
      if (!issues.length) return [new MessageItem(`No open issues in ${r.owner}/${r.name}`, 'pass')]
      return issues.map((i) => new IssueItem(r.owner, r.name, i))
    } catch (err) {
      return [new MessageItem(describe(err, `Could not load issues of ${r.owner}/${r.name}`), 'error', { command: 'dithub.refreshIssues', title: 'Retry' })]
    }
  }

  dispose(): void { this.emitter.dispose(); for (const s of this.subs) s.dispose() }
}
