import { flag, intArg, list, str, type Parsed } from '../args.ts'
import { findToken } from '../config.ts'
import { DitError, UsageError } from '../errors.ts'
import { repoCtx } from '../repoctx.ts'
import { VERSION } from '../constants.ts'
import { info, printJson, table } from '../ui.ts'
import { ApiError, DithubClient } from './api.ts'
import { assignSummary, normalizeReadPath, parentOf, parseLogin, type ScopeSuggestion } from './core.ts'
import { confirm, prompt } from './terminal.ts'

export async function assignTask(p: Parsed): Promise<number> {
  const issue = intArg(str(p.values.issue) ?? p.positionals[0] ?? '', 'issue')
  if (issue < 1) throw new UsageError('issue number must be positive')
  const login = parseLogin(str(p.values.login) ?? p.positionals[1] ?? await prompt('Developer username'))
  if (!login.ok) throw new UsageError(login.error)
  const role = str(p.values.role) ?? 'contractor'
  if (role !== 'contractor' && role !== 'employee') throw new UsageError('--role must be contractor or employee')
  const ttlMinutes = intArg(str(p.values.ttl) ?? '480', 'ttl')
  if (ttlMinutes < 1 || ttlMinutes > 1440) throw new UsageError('--ttl must be between 1 and 1440 minutes')
  const ctx = repoCtx(p.values)
  const flagHost = str(p.values.host)
  const client = new DithubClient({ host: ctx.host, getToken: () => findToken(ctx.host, flagHost)?.token ?? null, userAgent: `dit/${VERSION}` })
  const refFlag = str(p.values.ref)
  let suggestion: ScopeSuggestion | null = null
  let paths = list(p.values.path)
  if (!flag(p.values.manual)) {
    info('0G is reading the issue and choosing files…')
    try { suggestion = await client.suggestScope(ctx.owner, ctx.repo, issue, refFlag ? { ref: refFlag } : {}) }
    catch (err) {
      if (!(err instanceof ApiError) || ![0, 429, 502, 503, 504].includes(err.status)) throw err
      info(`0G could not suggest scope: ${err.message}.`)
      if (!paths.length && !process.stdin.isTTY) throw new DitError('no scope was chosen', 1, 'Retry 0G, or use --manual with explicit --path values.')
    }
    if (suggestion?.paths.length) {
      info(table(['PATH', 'REASON'], suggestion.paths.map((x) => [x.path, x.reason])))
      info(`0G model: ${suggestion.model ?? 'n/a'}; request: ${suggestion.requestId ?? 'n/a'}; sealed: ${suggestion.sealed ? 'yes' : 'no'}`)
    }
    if (!paths.length) paths = suggestion?.paths.map((s) => s.path) ?? []
  }
  // In a terminal users can replace suggestions, add paths or keep the proposed set before confirmation.
  if (!flag(p.values.yes) && process.stdin.isTTY) paths = (await prompt('Scope paths (comma separated)', paths.join(', '))).split(',').map((x) => x.trim()).filter(Boolean)
  if (!paths.length && process.stdin.isTTY) paths = (await prompt('Scope paths (comma separated)')).split(',').map((x) => x.trim()).filter(Boolean)
  paths = [...new Set(paths)]
  if (!paths.length || paths.length > 50 || paths.some((path) => normalizeReadPath(path) !== path)) {
    throw new UsageError('choose 1–50 clean file or directory paths with --path; wildcards and repository root are not allowed')
  }
  const ref = refFlag ?? suggestion?.ref ?? undefined
  const trees = new Map<string, Awaited<ReturnType<DithubClient['repoTree']>>>()
  for (const path of paths) {
    const parent = parentOf(path)
    let entries = trees.get(parent)
    if (!entries) { entries = await client.repoTree(ctx.owner, ctx.repo, parent, ref); trees.set(parent, entries) }
    if (!entries.some((entry) => entry.path === path && (entry.type === 'blob' || entry.type === 'tree'))) throw new UsageError(`scope path does not exist at ${ref ?? 'the default branch'}: ${path}`)
  }
  const summary = assignSummary({ owner: ctx.owner, repo: ctx.repo, issue, login: login.login, paths, role, ttlMinutes, model: suggestion?.model ?? null, requestId: suggestion?.requestId ?? null })
  const plan = { owner: ctx.owner, repo: ctx.repo, issueNumber: issue, login: login.login, role, paths, ttlMinutes, ...(ref ? { ref } : {}), suggestion }
  if (flag(p.values['dry-run'])) {
    if (flag(p.values.json)) printJson(plan); else info(summary)
    return 0
  }
  info(summary)
  await confirm('Assign this task?', flag(p.values.yes))
  // Session creation also assigns the issue, atomically on the server. Avoid a half-completed two-request assignment.
  const session = await client.createSession(ctx.owner, ctx.repo, { issueNumber: issue, login: login.login, role, paths, ttlMinutes, ...(ref ? { ref } : {}) })
  if (flag(p.values.json)) printJson({ session, suggestion })
  else console.log(`Assigned #${issue} to @${login.login}. Session: ${session.id}\nDeveloper: dit task connect ${session.id} --host ${ctx.host}`)
  return 0
}
