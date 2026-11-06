// Webviews: "Ask 0G" chat panel and the "Show task" issue view.
// Strict CSP (default-src 'none', nonce'd script/style), all content rendered with textContent (never innerHTML), no eval.
import * as vscode from 'vscode'
import type { Auth } from './auth.ts'
import type { AssistantAnswer, AssistantCall, Task } from './core.ts'
import { chatHtml, parseMsg, taskHtml } from './html.ts'
import { describe, nonce } from './ui.ts'

const toView = (a: AssistantAnswer | AssistantCall) => ({
  refused: a.refused, reason: 'reason' in a ? a.reason : a.refusalReason, answer: a.answer, requestId: a.requestId, model: a.model, sealed: a.sealed,
  teeVerified: 'teeVerified' in a ? a.teeVerified : null, filesUsed: 'filesUsed' in a ? a.filesUsed : [], createdAt: a.createdAt, failed: 'failed' in a ? a.failed : false,
  kind: 'kind' in a ? a.kind : undefined, question: 'question' in a ? a.question : undefined,
})

export class AssistantPanels implements vscode.Disposable {
  private readonly chats = new Map<string, vscode.WebviewPanel>()
  private readonly tasks = new Map<string, vscode.WebviewPanel>()
  constructor(private readonly auth: Auth) {}

  async openChat(task: Task): Promise<void> {
    const existing = this.chats.get(task.sessionId)
    if (existing) { existing.reveal(); return }
    const panel = vscode.window.createWebviewPanel('dithub.ask', `Ask 0G: #${task.issue.number}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [], enableCommandUris: false, enableForms: true })
    this.chats.set(task.sessionId, panel)
    panel.onDidDispose(() => this.chats.delete(task.sessionId))
    const post = (m: unknown) => void panel.webview.postMessage(m)
    let running = false
    panel.webview.onDidReceiveMessage(async (raw) => {
      const m = parseMsg(raw); if (!m) return
      if (m.type === 'ready') {
        try { post({ type: 'history', calls: (await this.auth.api.assistantCalls(task.sessionId)).slice().reverse().map(toView) }) }
        catch (err) { post({ type: 'history', calls: [] }); post({ type: 'error', text: describe(err, 'Could not load the history') }) }
        return
      }
      if (running) return
      running = true; post({ type: 'busy', on: true })
      post({ type: 'question', kind: m.type, text: m.type === 'ask' ? m.question : 'Summarize the task' })
      try {
        const a = m.type === 'ask' ? await this.auth.api.ask(task.sessionId, m.question) : await this.auth.api.summarize(task.sessionId)
        post({ type: 'answer', data: toView(a) })
      } catch (err) { post({ type: 'error', text: describe(err, '0G assistant') }) }
      finally { running = false; post({ type: 'busy', on: false }) }
    })
    panel.webview.html = chatHtml(task, nonce())
  }

  async showTask(task: Task): Promise<void> {
    let issue: Awaited<ReturnType<Auth['api']['sessionIssue']>>
    try { issue = await this.auth.api.sessionIssue(task.sessionId) } catch (err) { void vscode.window.showErrorMessage(describe(err, 'Could not load the task')); return }
    let panel = this.tasks.get(task.sessionId)
    if (!panel) {
      panel = vscode.window.createWebviewPanel('dithub.task', `Task #${task.issue.number}`, vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [], enableCommandUris: false })
      this.tasks.set(task.sessionId, panel)
      panel.onDidDispose(() => this.tasks.delete(task.sessionId))
    } else panel.reveal()
    panel.webview.html = taskHtml(task, issue, nonce())
  }

  close(sessionId: string): void { this.chats.get(sessionId)?.dispose(); this.tasks.get(sessionId)?.dispose() }
  dispose(): void { for (const p of [...this.chats.values(), ...this.tasks.values()]) p.dispose() }
}
