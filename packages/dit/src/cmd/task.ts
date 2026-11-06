import { readFileSync } from 'node:fs'
import { flag, list, needArg, parse, str } from '../args.ts'
import { currentSession, findToken, primaryHost, setCurrentSession } from '../config.ts'
import { VERSION } from '../constants.ts'
import { DitError, UsageError } from '../errors.ts'
import { c, info, printJson, table } from '../ui.ts'
import { ApiError, DithubClient } from '../tasks/api.ts'
import { assignTask } from '../tasks/assign.ts'
import { buildProposal, countdown, isLive, normalizeReadPath, overlayChildren, prUrl, taskLabel, visibleEntries, writablePath, type TreeEntry } from '../tasks/core.ts'
import { TaskDrafts } from '../tasks/drafts.ts'
import { confirm, decodeText, editSource, prompt, taskDiff } from '../tasks/terminal.ts'
import { issueCmd } from './issue.ts'

export async function taskCmd(argv: string[]): Promise<number> {
  const sub = !argv[0] || argv[0].startsWith('-') ? 'list' : argv[0]
  const rest = sub === argv[0] ? argv.slice(1) : argv
  const p = parse(rest, {
    session: { type: 'string', short: 's' }, issue: { type: 'string' }, login: { type: 'string' }, role: { type: 'string' }, ttl: { type: 'string' }, ref: { type: 'string' },
    path: { type: 'string', multiple: true }, manual: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' }, all: { type: 'boolean' },
    from: { type: 'string' }, new: { type: 'boolean' }, title: { type: 'string', short: 't' }, body: { type: 'string', short: 'b' },
  })
  const known = ['list', 'repos', 'issues', 'assign', 'connect', 'disconnect', 'show', 'ls', 'cat', 'edit', 'status', 'diff', 'discard', 'submit', 'ask', 'summarize', 'calls', 'end']
  if (!known.includes(sub)) throw new UsageError(`unknown subcommand "task ${sub}"`, 'Run `dit task --help`.')
  if (sub === 'assign') return assignTask(p)
  if (sub === 'issues') return issueCmd(['list', ...rest])
  const json = flag(p.values.json), yes = flag(p.values.yes)
  const flagHost = str(p.values.host), host = primaryHost(flagHost)
  const client = new DithubClient({ host, getToken: () => findToken(host, flagHost)?.token ?? null, userAgent: `dit/${VERSION}` })
  if (sub === 'disconnect') {
    setCurrentSession(host, null)
    if (json) printJson({ connected: false }); else info('Disconnected. Drafts are kept for the next connection.')
    return 0
  }
  if (sub === 'repos') {
    const repos = await client.myRepos('maintain')
    if (json) printJson(repos); else console.log(table(['REPOSITORY', 'PERMISSION', 'VISIBILITY'], repos.map((r) => [`${r.owner}/${r.name}`, r.permission, r.visibility])))
    return 0
  }
  // Always revalidate the grant with the server before reading local drafts or touching repository contents.
  const tasks = await client.tasks()
  if (sub === 'list') {
    const shown = flag(p.values.all) ? tasks : tasks.filter((t) => isLive(t))
    if (json) printJson(shown)
    else if (!shown.length) info('No active tasks assigned to you. Use --all to include ended tasks.')
    else console.log(table(['SESSION', 'TASK', 'ROLE', 'TIME'], shown.map((t) => [t.sessionId, taskLabel(t), t.role, isLive(t) ? countdown(t.expiresAt) : t.status])))
    return 0
  }
  let id = str(p.values.session) ?? (process.env.DIT_SESSION?.trim() || currentSession(host)?.id)
  if (sub === 'connect') {
    id = p.positionals[0] ?? str(p.values.session)
    if (!id) {
      const active = tasks.filter((t) => isLive(t))
      if (active.length === 1) id = active[0]!.sessionId
      else if (active.length) {
        info(table(['#', 'TASK', 'TIME'], active.map((t, i) => [String(i + 1), taskLabel(t), countdown(t.expiresAt)])))
        const choice = await prompt('Task number')
        if (!/^\d+$/.test(choice) || !active[Number(choice) - 1]) throw new UsageError('invalid task number')
        id = active[Number(choice) - 1]!.sessionId
      }
    }
  }
  const task = tasks.find((t) => t.sessionId === id)
  if (!task || !isLive(task)) {
    if (id && currentSession(host)?.id === id) setCurrentSession(host, null)
    throw new DitError(task ? `task is ${task.status === 'active' ? 'expired' : task.status}` : id ? 'this task is no longer assigned to you' : 'no task connected', 1, 'Run `dit task list` then `dit task connect <session-id>`.')
  }
  const target = { owner: task.repo.owner, repo: task.repo.name, ref: task.ref, sessionId: task.sessionId, allowedPaths: task.allowedPaths }
  const drafts = new TaskDrafts(host, task)
  const pathArg = () => {
    const raw = needArg(p, 0, 'path'), path = normalizeReadPath(raw)
    if (!path || path !== raw || !writablePath(task.allowedPaths, path)) throw new UsageError(`${raw} is invalid or outside the task scope`)
    return path
  }
  switch (sub) {
    case 'connect': {
      setCurrentSession(host, { id: task.sessionId, owner: task.repo.owner, repo: task.repo.name, role: task.role, ref: task.ref, issueNumber: task.issue.number, expiresAt: task.expiresAt, allowedPaths: task.allowedPaths })
      if (json) printJson(task)
      else console.log(`Connected: ${taskLabel(task)}\nRole: ${task.role}; ${countdown(task.expiresAt)}\nScope: ${task.allowedPaths.join(', ')}\nNext: dit task show | ls | edit <path> | ask "…" | diff | submit`)
      return 0
    }
    case 'show': {
      const issue = await client.sessionIssue(task.sessionId)
      if (json) printJson({ task, issue }); else console.log(`${c.bold(`#${issue.number} ${issue.title}`)}\n\n${issue.body ?? ''}\n\nScope: ${task.allowedPaths.join(', ')}\n${countdown(task.expiresAt)}`)
      return 0
    }
    case 'ls': {
      const dir = p.positionals[0] ?? ''
      const local = drafts.read()
      const children = overlayChildren({ version: 1, files: Object.fromEntries(Object.entries(local).map(([path, d]) => [path, { content: d.content, mtime: 0 }])), dirs: [] }, dir)
      let remote: TreeEntry[]
      try { remote = await client.scopedTree(target, dir) }
      catch (err) { if (!(err instanceof ApiError && err.status === 404 && children.length)) throw err; remote = [] }
      const entries = visibleEntries(task.allowedPaths, remote)
      for (const child of children) if (!entries.some((e) => e.path === child.path)) entries.push({ ...child, type: child.type === 'dir' ? 'tree' : 'blob' })
      const result = entries.sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ ...entry, edited: Object.hasOwn(local, entry.path) }))
      if (json) printJson(result); else for (const e of result) console.log(`${e.type === 'tree' ? 'dir ' : 'file'} ${e.path}${e.type === 'tree' ? '/' : ''}${e.edited ? ' (edited)' : ''}`)
      return 0
    }
    case 'cat': {
      const path = pathArg(), local = drafts.read()
      const blob = Object.hasOwn(local, path) ? { path, content: local[path]!.content, draft: true } : await client.scopedBlob(target, path)
      if (json) printJson(blob)
      else { if (blob.content === null) throw new DitError('this file is binary or too large'); process.stdout.write(blob.content) }
      return 0
    }
    case 'edit': {
      const path = pathArg(), local = drafts.read()
      let draft = Object.hasOwn(local, path) ? local[path] : undefined
      if (!draft) {
        let content: string | null
        try {
          const blob = await client.scopedBlob(target, path)
          if (blob.content === null || blob.binary || blob.truncated) throw new DitError('this file is binary or too large')
          content = blob.content
          if (flag(p.values.new)) throw new UsageError('this file already exists; omit --new to edit it')
        } catch (err) {
          if (!(err instanceof Error && 'status' in err && err.status === 404 && flag(p.values.new))) throw err
          content = null
        }
        draft = { content: content ?? '', original: content }
      }
      const source = str(p.values.from)
      const content = source ? decodeText(source === '-' ? new Uint8Array(await Bun.stdin.arrayBuffer()) : readFileSync(source)) : editSource(path, draft.content)
      // Editing can outlast the session. Recheck before persisting the source.
      const latest = (await client.tasks()).find((t) => t.sessionId === task.sessionId)
      if (!latest || !isLive(latest) || latest.ref !== task.ref || !writablePath(latest.allowedPaths, path)) throw new DitError('task access changed while editing; the draft was not saved')
      drafts.put(path, { content, original: draft.original })
      if (json) printJson({ path, saved: true, changed: content !== draft.original }); else info(`Saved draft: ${path}. Review with dit task diff, then dit task submit.`)
      return 0
    }
    case 'status': case 'diff': {
      const changes = drafts.changes().filter((x) => !p.positionals[0] || x.path === pathArg())
      if (json) printJson(changes.map(({ path, status }) => ({ path, status })))
      else if (!changes.length) info('No changes.')
      else if (sub === 'diff') process.stdout.write(taskDiff(changes, drafts.read()))
      else console.log(table(['STATUS', 'PATH'], changes.map((x) => [x.status, x.path])))
      return 0
    }
    case 'discard': {
      const paths = p.positionals.length ? [pathArg()] : undefined
      await confirm(paths ? `Discard the draft for ${paths[0]}?` : 'Discard all drafts for this task?', yes)
      drafts.discard(paths)
      if (json) printJson({ discarded: paths ?? 'all' }); else info('Drafts discarded.')
      return 0
    }
    case 'submit': {
      const selected = list(p.values.path)
      const all = drafts.changes()
      if (selected.some((path) => !all.some((c) => c.path === path))) throw new UsageError('--path must name an edited file')
      const changes = selected.length ? all.filter((c) => selected.includes(c.path)) : all
      if (!changes.length) throw new DitError('no changes to submit')
      const title = str(p.values.title) ?? (process.stdin.isTTY ? await prompt('Pull request title', `Fix #${task.issue.number}: ${task.issue.title}`) : undefined)
      if (!title?.trim() || title.length > 300) throw new UsageError('provide a pull request title with -t (1–300 characters)')
      const proposal = buildProposal(task.allowedPaths, changes, title, str(p.values.body) ?? '')
      info(table(['STATUS', 'PATH'], changes.map((x) => [x.status, x.path])))
      info(`Pull request: ${title}`)
      await confirm(`Submit ${changes.length} file(s)?`, yes)
      const result = await client.proposeFiles(task.sessionId, task.allowedPaths, proposal)
      drafts.submitted(changes)
      const url = prUrl(host, task.repo.owner, task.repo.name, result.pullRequest)
      if (json) printJson({ ...result, url }); else console.log(`${url}\nSubmitted ${result.files} file(s). The submitted drafts were cleared; their changes are in the PR.`)
      return 0
    }
    case 'ask': case 'summarize': {
      const question = p.positionals.join(' ').trim()
      if (sub === 'ask' && !question) throw new UsageError('missing question', 'Usage: dit task ask "How does the retry work?"')
      const result = sub === 'ask' ? await client.ask(task.sessionId, question) : await client.summarize(task.sessionId)
      if (json) printJson(result)
      else console.log(`${result.refused ? 'REFUSED\n' : ''}${result.answer ?? result.reason ?? ''}\n\n0G request: ${result.requestId ?? 'n/a'}; model: ${result.model ?? 'n/a'}; sealed: ${result.sealed ? 'yes' : 'no'}`)
      return result.refused ? 1 : 0
    }
    case 'calls': {
      const calls = await client.assistantCalls(task.sessionId)
      if (json) printJson(calls)
      else for (const call of calls) console.log(`${call.refused ? 'REFUSED' : call.failed ? 'FAILED' : call.kind} · ${call.model ?? 'n/a'} · 0G request: ${call.requestId ?? 'n/a'}\n${call.question ?? ''}\n${call.answer ?? ''}\n`)
      return 0
    }
    case 'end': {
      const pending = drafts.changes().length
      await confirm(`End #${task.issue.number} and discard ${pending} unsubmitted draft(s)?`, yes)
      await client.endSession(task.sessionId)
      drafts.discard()
      if (currentSession(host)?.id === task.sessionId) setCurrentSession(host, null)
      if (json) printJson({ ended: true, sessionId: task.sessionId }); else info('Task ended. Access released and drafts discarded.')
      return 0
    }
  }
  throw new UsageError(`unknown subcommand "task ${sub}"`)
}
