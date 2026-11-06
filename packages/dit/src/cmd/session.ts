import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Api, apiFor } from '../api.ts'
import { csv, flag, intArg, needArg, parse, str } from '../args.ts'
import { ApiError, DitError, UsageError, describeApiError } from '../errors.ts'
import { currentSession, primaryHost, setCurrentSession, type SessionRef } from '../config.ts'
import { git, toplevel } from '../git.ts'
import { extractTar } from '../tar.ts'
import { repoCtx } from '../repoctx.ts'
import { sessionCalls } from './extra.ts'
import { ago, c, countdown, info, printJson, table, trunc } from '../ui.ts'

interface Sess { id: string; owner?: string; repo?: string; issueNumber: number; user: string; createdBy: string; role: string; allowedPaths: string[]; ref: string; status: string; expiresAt: string; createdAt: string }

/** Active session for this host (flag > env > saved by `dit session open`). */
function active(host: string, p: { values: Record<string, unknown> }): SessionRef {
  const saved = currentSession(host)
  const id = str(p.values.session as string) ?? process.env.DIT_SESSION ?? saved?.id
  if (!id) throw new DitError('no active session', 1, 'Run `dit session list` then `dit session open <id>`.')
  if (saved && saved.id === id) return saved
  throw new DitError(`session ${id} was not opened with \`dit session open\``, 1, 'Run `dit session open <id>` first.')
}
const denied = (err: unknown): never => {
  if (err instanceof ApiError && err.status === 403) throw new DitError(c.red(`access denied by your session scope: ${err.message}`))
  throw err
}

export async function sessionCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, {
    session: { type: 'string', short: 's' }, output: { type: 'string', short: 'o' }, title: { type: 'string', short: 't' }, body: { type: 'string', short: 'b' },
    issue: { type: 'string' }, login: { type: 'string' }, role: { type: 'string' }, path: { type: 'string', multiple: true }, ttl: { type: 'string' }, status: { type: 'string' }, force: { type: 'boolean' },
  })
  const json = flag(p.values.json)
  const flagHost = str(p.values.host)
  const host = primaryHost(flagHost)
  const mkApi = (sessionId?: string) => apiFor(host, { flagHost, session: sessionId ?? null })

  switch (sub) {
    case 'list': case 'ls-sessions': {
      const r = await mkApi().get<{ sessions: Sess[] }>('/api/sessions', { status: str(p.values.status) })
      if (json) printJson(r.sessions)
      else if (!r.sessions.length) info('You have no sessions.')
      else console.log(table(['ID', 'REPO', 'ISSUE', 'ROLE', 'STATUS', 'EXPIRES'], r.sessions.map((s) => [s.id, `${s.owner}/${s.repo}`, `#${s.issueNumber}`, s.role, s.status === 'active' ? c.green(s.status) : c.dim(s.status), s.status === 'active' ? countdown(s.expiresAt) : '-'])))
      return 0
    }
    case 'open': {
      const id = needArg(p, 0, 'session-id')
      const api = mkApi()
      const all = await api.get<{ sessions: Sess[] }>('/api/sessions')
      const s = all.sessions.find((x) => x.id === id)
      if (!s || !s.owner || !s.repo) throw new DitError(`no session ${id} found for your account`, 1, 'Maintainers do not open sessions; they create and revoke them.')
      if (s.status !== 'active') throw new DitError(`session is ${s.status}`)
      const ref: SessionRef = { id: s.id, owner: s.owner, repo: s.repo, role: s.role, ref: s.ref, issueNumber: s.issueNumber, expiresAt: s.expiresAt, allowedPaths: s.allowedPaths }
      setCurrentSession(host, ref)
      let task: { title: string } | null = null
      try { task = await api.get(`/api/sessions/${id}/issue`) } catch { /* optional */ }
      if (json) { printJson({ ...ref, task }); return 0 }
      console.log(`${c.green('Session open')} ${c.dim(id)}`)
      console.log(`repo:   ${s.owner}/${s.repo} @ ${s.ref}   task: #${s.issueNumber}${task ? ` ${task.title}` : ''}`)
      console.log(`role:   ${c.bold(s.role)}`)
      console.log(`scope:  ${s.allowedPaths.join(', ')}`)
      console.log(`time:   ${countdown(s.expiresAt)} (until ${s.expiresAt})`)
      console.log(c.dim('Next: dit session ls | cat <path> | export | ask "..." | propose | end'))
      return 0
    }
    case 'issue': {
      const s = active(host, p)
      const r = await mkApi().get<{ number: number; title: string; body: string | null; state: string }>(`/api/sessions/${s.id}/issue`)
      if (json) printJson(r); else console.log(`${c.bold(`#${r.number} ${r.title}`)}  ${r.state}\n\n${r.body ?? ''}`)
      return 0
    }
    case 'ls': {
      const s = active(host, p)
      const path = (p.positionals[0] ?? '').replace(/^\/+|\/+$/g, '')
      let r: { entries: Array<{ type: string; name: string; path: string; size?: number | null; restricted?: boolean }> }
      try { r = await mkApi(s.id).get(`/api/repos/${s.owner}/${s.repo}/tree`, { path }) } catch (err) { return denied(err) }
      if (json) printJson(r.entries)
      else if (!r.entries.length) info('(empty)')
      else for (const e of r.entries) console.log(`${e.restricted ? c.dim('locked ') : e.type === 'tree' ? c.cyan('dir    ') : 'file   '} ${e.type === 'tree' ? c.cyan(e.name + '/') : e.restricted ? c.dim(e.name) : e.name}${e.size != null ? c.dim(`  ${e.size}B`) : ''}`)
      return 0
    }
    case 'cat': {
      const s = active(host, p)
      const path = needArg(p, 0, 'path').replace(/^\/+/, '')
      let r: { path: string; size: number; binary?: boolean; truncated?: boolean; content: string | null }
      try { r = await mkApi(s.id).get(`/api/repos/${s.owner}/${s.repo}/blob`, { path }) } catch (err) { return denied(err) }
      if (json) { printJson(r); return 0 }
      if (r.content === null) throw new DitError(r.truncated ? `${path} is too large to print (${r.size} bytes); use \`dit session export\`` : `${path} is binary (${r.size} bytes); use \`dit session export\``)
      process.stdout.write(r.content.endsWith('\n') ? r.content : r.content + '\n')
      return 0
    }
    case 'export': {
      const s = active(host, p)
      const dest = resolve(str(p.values.output) ?? `session-${s.issueNumber}-${s.id.slice(0, 8)}`)
      if (existsSync(dest) && readdirSync(dest).length) throw new DitError(`${dest} already exists and is not empty`)
      const res = await mkApi(s.id).raw('GET', `/api/sessions/${s.id}/export`, { headers: { accept: 'application/x-tar' }, timeoutMs: 300_000 })
      const buf = Buffer.from(await res.arrayBuffer())
      const created = !existsSync(dest)
      try {
        const { files } = extractTar(buf, dest)
        const env = { ...process.env, GIT_AUTHOR_NAME: 'dit', GIT_AUTHOR_EMAIL: 'dit@localhost', GIT_COMMITTER_NAME: 'dit', GIT_COMMITTER_EMAIL: 'dit@localhost' }
        const run = (args: string[]) => { const r = git(args, { cwd: dest, env }); if (r.code !== 0) throw new DitError(`git ${args[0]} failed: ${r.err.trim()}`); return r }
        run(['init', '-q', '-b', 'main'])
        run(['config', 'core.hooksPath', '/dev/null'])
        run(['add', '-A'])
        run(['commit', '-q', '-m', `Baseline: session ${s.id} (issue #${s.issueNumber})`, '--no-gpg-sign'])
        const baseline = run(['rev-parse', 'HEAD']).out.trim()
        writeFileSync(join(dest, '.git', 'dit-session.json'), JSON.stringify({ sessionId: s.id, owner: s.owner, repo: s.repo, host, baseline, ref: s.ref, issueNumber: s.issueNumber }, null, 2))
        if (json) printJson({ dir: dest, files, baseline }); else { info(`${c.green('Exported')} ${files} file(s) to ${dest}`); info(`Baseline commit ${baseline.slice(0, 10)}. Work normally, commit if you like, then run \`dit session propose\` inside that folder.`) }
      } catch (err) { if (created) rmSync(dest, { recursive: true, force: true }); throw err }
      return 0
    }
    case 'ask': case 'summarize': {
      const s = active(host, p)
      const question = sub === 'ask' ? p.positionals.join(' ').trim() : ''
      if (sub === 'ask' && !question) throw new UsageError('missing question', 'Usage: dit session ask "how does the payment retry work?"')
      let r: { refused: boolean; reason?: string; answer: string | null; requestId: string | null; model?: string; sealed?: boolean; teeVerified?: boolean | null; filesUsed?: string[]; callId?: string }
      try { r = await mkApi(s.id).post(`/api/sessions/${s.id}/assistant/${sub}`, sub === 'ask' ? { question } : {}, { timeoutMs: 180_000 }) }
      catch (err) { if (err instanceof ApiError && err.status === 502) throw new DitError(`the 0G assistant is unavailable: ${err.message}`); throw err }
      if (json) { printJson(r); return r.refused ? 1 : 0 }
      if (r.refused) {
        console.log(`${c.yellow(c.bold('REFUSED'))} ${c.yellow('(no model call was made)')}${r.reason ? c.dim(` reason: ${r.reason}`) : ''}`)
        console.log(r.answer ?? '')
        return 1
      }
      console.log(r.answer ?? '')
      console.log(c.dim(`\n0G request: ${r.requestId ?? 'n/a'}   model: ${r.model ?? 'n/a'}   sealed: ${r.sealed ? 'yes' : 'no'}${r.teeVerified != null ? `   tee verified: ${r.teeVerified}` : ''}${r.filesUsed?.length ? `\nfiles used: ${r.filesUsed.join(', ')}` : ''}`))
      return 0
    }
    case 'propose': {
      const dir = toplevel() ?? process.cwd()
      const metaFile = join(dir, '.git', 'dit-session.json')
      if (!existsSync(metaFile)) throw new DitError('this folder was not created by `dit session export`', 1, 'cd into the exported folder first.')
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { sessionId: string; owner: string; repo: string; baseline: string; host: string }
      // Diff the working tree against the baseline using a throwaway index, so the developer's own index is untouched.
      const tmp = mkdtempSync(join(tmpdir(), 'dit-idx-'))
      let patch: string
      try {
        const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') }
        for (const args of [['read-tree', meta.baseline], ['add', '-A']]) { const r = git(args, { cwd: dir, env }); if (r.code !== 0) throw new DitError(`git ${args[0]} failed: ${r.err.trim()}`) }
        const d = git(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', '-M', meta.baseline], { cwd: dir, env })
        if (d.code !== 0) throw new DitError(`git diff failed: ${d.err.trim()}`)
        patch = d.out
      } finally { rmSync(tmp, { recursive: true, force: true }) }
      if (!patch.trim()) throw new DitError('no changes against the session baseline; nothing to propose')
      const api = apiFor(meta.host, { flagHost: meta.host, session: meta.sessionId })
      try {
        const r = await api.post<{ branch: string; commit: string; pullRequest: number; files: number }>(`/api/sessions/${meta.sessionId}/proposals`, { patch, ...(str(p.values.title) ? { title: str(p.values.title) } : {}), ...(str(p.values.body) ? { body: str(p.values.body) } : {}) })
        const url = `${meta.host}/${meta.owner}/${meta.repo}/pulls/${r.pullRequest}`
        if (json) printJson({ ...r, url }); else console.log(`${url}\n${c.green('Proposed')} ${r.files} file(s) on branch ${r.branch} as pull request #${r.pullRequest}`)
      } catch (err) {
        if (err instanceof ApiError && err.status === 422) {
          const paths = (err.body as { paths?: string[] } | null)?.paths ?? []
          throw new DitError(c.red(`proposal rejected: ${err.message}`) + (paths.length ? `\nout-of-scope paths:\n  - ${paths.join('\n  - ')}` : ''))
        }
        throw err
      }
      return 0
    }
    case 'end': {
      const s = active(host, p)
      await mkApi().post(`/api/sessions/${s.id}/end`, {})
      setCurrentSession(host, null)
      if (json) printJson({ ok: true, id: s.id }); else info(`Session ${s.id} ended.`)
      return 0
    }
    case 'calls': { const s = active(host, p); return sessionCalls(mkApi(), s.id, json) }
    case 'create': {
      const ctx = repoCtx(p.values)
      const issue = str(p.values.issue), login = str(p.values.login), role = str(p.values.role) ?? 'contractor'
      if (!issue || !login) throw new UsageError('--issue and --login are required', 'Example: dit session create --issue 12 --login dev --role contractor --path src/payments --ttl 480')
      const paths = csv(p.values.path)
      const ttl = str(p.values.ttl)
      const r = await ctx.api.post<Sess>(`${ctx.R}/sessions`, { issueNumber: intArg(issue, 'issue'), login, role, ...(paths.length ? { paths } : {}), ...(ttl ? { ttlMinutes: intArg(ttl, 'ttl') } : {}) })
      if (json) printJson(r); else console.log(`${c.green('Created')} session ${c.bold(r.id)}\n${r.user} as ${r.role} on #${r.issueNumber}, scope: ${r.allowedPaths.join(', ')}, ${countdown(r.expiresAt)}\nTell ${r.user} to run: dit session open ${r.id}`)
      return 0
    }
    case 'revoke': {
      const id = needArg(p, 0, 'session-id')
      await mkApi().post(`/api/sessions/${id}/revoke`, {})
      if (json) printJson({ ok: true, id }); else info(`Session ${id} revoked.`)
      return 0
    }
    case 'events': {
      const id = needArg(p, 0, 'session-id')
      const r = await mkApi().get<{ events: Array<{ id: number; kind: string; actor: string | null; detail: unknown; createdAt: string }> }>(`/api/sessions/${id}/events`)
      if (json) printJson(r.events)
      else console.log(table(['WHEN', 'ACTOR', 'EVENT', 'DETAIL'], r.events.map((e) => [ago(e.createdAt), e.actor ?? '-', e.kind.includes('denied') || e.kind.includes('rejected') ? c.red(e.kind) : e.kind, trunc(JSON.stringify(e.detail ?? {}), 70)])))
      return 0
    }
    default: throw new UsageError(sub ? `unknown subcommand "session ${sub}"` : 'missing subcommand', 'Run `dit session --help`.')
  }
}
void Api; void describeApiError; void mkdirSync
