// Developer flow: "Submit changes" -> review changed files (diffs) -> PR title -> POST /api/sessions/:id/proposals (files variant).
import * as vscode from 'vscode'
import { ApiError } from './api.ts'
import type { Auth } from './auth.ts'
import { buildProposal, prUrl, type Change, type Task } from './core.ts'
import { originalUri, taskFileUri, type TaskFileSystem } from './taskFs.ts'
import { describe } from './ui.ts'

type ChangeItem = vscode.QuickPickItem & { change: Change }

function openDiff(task: Task, c: Change): Thenable<unknown> {
  return vscode.commands.executeCommand('vscode.diff', originalUri(task.sessionId, c.path), taskFileUri(task.sessionId, c.path), `${c.path} (${c.status === 'added' ? 'new file' : `${task.ref} ↔ your edit`})`, { preview: true })
}

/** Review list: every changed file pre-selected; the eye button (or Enter on one item with none selected) opens the diff. */
async function reviewChanges(task: Task, changes: Change[]): Promise<Change[] | undefined> {
  const diffButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Open diff' }
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<ChangeItem>()
    qp.title = `Submit changes for ${task.repo.owner}/${task.repo.name} #${task.issue.number}`
    qp.placeholder = 'Choose the files to include (use the diff button to review each one), then press Enter'
    qp.canSelectMany = true
    qp.ignoreFocusOut = true
    qp.items = changes.map((c) => ({ label: c.path, description: c.status === 'added' ? 'new file' : 'modified', change: c, buttons: [diffButton] }))
    qp.selectedItems = qp.items
    let done = false
    qp.onDidTriggerItemButton((e) => { void openDiff(task, e.item.change) })
    qp.onDidAccept(() => { done = true; resolve(qp.selectedItems.map((i) => i.change)); qp.hide() })
    qp.onDidHide(() => { if (!done) resolve(undefined); qp.dispose() })
    qp.show()
  })
}

export async function submitChanges(auth: Auth, fs: TaskFileSystem, task: Task): Promise<void> {
  let changes: Change[]
  try {
    changes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Dithub: collecting changes' }, () => fs.changes(task))
  } catch (err) { void vscode.window.showErrorMessage(describe(err, 'Could not compare your changes')); return }
  // Unsaved editors are not part of the overlay yet.
  const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'dithub-task' && d.uri.authority === task.sessionId)
  if (dirty.length) {
    const c = await vscode.window.showWarningMessage(`${dirty.length} file(s) of this task have unsaved edits.`, { modal: true }, 'Save all and continue')
    if (c !== 'Save all and continue') return
    for (const d of dirty) await d.save()
    changes = await fs.changes(task)
  }
  if (!changes.length) { void vscode.window.showInformationMessage('No changes to submit: edit files in the task folder first (edits are kept by the extension, not on disk).'); return }
  const picked = await reviewChanges(task, changes)
  if (!picked) return
  if (!picked.length) { void vscode.window.showInformationMessage('Nothing selected; nothing was submitted.'); return }
  const title = await vscode.window.showInputBox({ title: 'Pull request title', value: `Fix #${task.issue.number}: ${task.issue.title}`.slice(0, 200), ignoreFocusOut: true, validateInput: (v) => (v.trim() ? (v.length > 300 ? 'At most 300 characters' : null) : 'A title is required') })
  if (title === undefined) return
  const body = await vscode.window.showInputBox({ title: 'Pull request description (optional)', placeHolder: 'What changed and why', ignoreFocusOut: true })
  if (body === undefined) return

  let proposal: ReturnType<typeof buildProposal>
  try { proposal = buildProposal(task.allowedPaths, picked, title, body) } catch (err) { void vscode.window.showErrorMessage(`Not submitted: ${(err as Error).message}`); return }
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Submitting ${proposal.files.length} file(s)…` },
      () => auth.api.proposeFiles(task.sessionId, task.allowedPaths, proposal))
    await fs.clearOverlay(task.sessionId, picked.map((c) => c.path))
    const url = prUrl(auth.host, task.repo.owner, task.repo.name, r.pullRequest)
    const c = await vscode.window.showInformationMessage(`Submitted ${r.files} file(s) as pull request #${r.pullRequest} on branch ${r.branch}. The task folder now shows ${task.ref} again; your changes live in the pull request.`, 'Open pull request', 'Copy link')
    if (c === 'Open pull request') await vscode.env.openExternal(vscode.Uri.parse(url))
    if (c === 'Copy link') await vscode.env.clipboard.writeText(url)
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      const paths = ((err.body as { paths?: unknown } | null)?.paths as unknown[] | undefined)?.filter((p): p is string => typeof p === 'string') ?? []
      void vscode.window.showErrorMessage(`The proposal was rejected: ${err.message}${paths.length ? `. Out-of-scope paths: ${paths.join(', ')}` : ''}`, { modal: true })
      return
    }
    void vscode.window.showErrorMessage(describe(err, 'Could not submit your changes'))
  }
}
