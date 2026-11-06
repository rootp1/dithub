import { csv, flag, intArg, needArg, parse, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { editText, splitTitleBody } from '../editor.ts'
import { repoCtx } from '../repoctx.ts'
import { ago, c, info, printJson, table, trunc } from '../ui.ts'

interface Issue { number: number; title: string; body: string | null; state: string; stateReason: string | null; author: string; comments: number; labels: Array<{ name: string }>; assignees: string[]; createdAt: string; updatedAt: string }

const stateColor = (s: string) => (s === 'open' ? c.green(s) : s === 'merged' ? c.magenta(s) : c.red(s))
const labelText = (i: Issue) => i.labels.map((l) => l.name).join(', ')

export async function issueCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const opts = {
    title: { type: 'string', short: 't' }, body: { type: 'string', short: 'b' }, state: { type: 'string', short: 's' }, label: { type: 'string', short: 'l', multiple: true },
    assignee: { type: 'string', short: 'a', multiple: true }, author: { type: 'string' }, search: { type: 'string', short: 'q' }, limit: { type: 'string', short: 'L' },
    comments: { type: 'boolean' }, reason: { type: 'string' }, add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true }, unassign: { type: 'boolean' },
  } as const
  const p = parse(rest, opts)
  const json = flag(p.values.json)
  const ctx = repoCtx(p.values)
  const num = () => intArg(needArg(p, 0, 'number'), 'number')

  switch (sub) {
    case 'list': case 'ls': {
      const state = str(p.values.state) ?? 'open'
      const r = await ctx.api.get<{ total: number; issues: Issue[] }>(`${ctx.R}/issues`, {
        state, label: csv(p.values.label).join(','), assignee: csv(p.values.assignee)[0], author: str(p.values.author), q: str(p.values.search), per_page: Number(str(p.values.limit)) || 30 })
      if (json) printJson(r.issues)
      else if (!r.issues.length) info(`No ${state === 'all' ? '' : state + ' '}issues in ${ctx.slug}.`)
      else console.log(table(['#', 'STATE', 'TITLE', 'LABELS', 'AUTHOR', 'UPDATED'], r.issues.map((i) => [`#${i.number}`, stateColor(i.state), trunc(i.title, 60), labelText(i), i.author ?? '', ago(i.updatedAt)])))
      return 0
    }
    case 'view': {
      const n = num()
      const i = await ctx.api.get<Issue>(`${ctx.R}/issues/${n}`)
      const cm = flag(p.values.comments) || json ? (await ctx.api.get<{ comments: Array<{ author: string; body: string; createdAt: string }> }>(`${ctx.R}/issues/${n}/comments`)).comments : []
      if (json) { printJson({ ...i, commentList: cm }); return 0 }
      console.log(`${c.bold(`#${i.number} ${i.title}`)}  ${stateColor(i.state)}`)
      console.log(c.dim(`${i.author} opened ${ago(i.createdAt)} | ${i.comments} comment(s)${i.labels.length ? ' | labels: ' + labelText(i) : ''}${i.assignees.length ? ' | assigned: ' + i.assignees.join(', ') : ''}`))
      console.log(`\n${i.body?.trim() || c.dim('(no description)')}`)
      for (const m of cm) console.log(`\n${c.bold(m.author)} ${c.dim(ago(m.createdAt))}\n${m.body}`)
      console.log(c.dim(`\n${ctx.host}/${ctx.owner}/${ctx.repo}/issues/${i.number}`))
      return 0
    }
    case 'create': case 'new': {
      let title = str(p.values.title), body = str(p.values.body)
      if (!title) {
        const t = splitTitleBody(editText(`${body ?? ''}\n\n# First line is the title; the rest is the description. Lines starting with # are ignored.\n`))
        title = t.title; body = body ?? t.body
        if (!title) throw new DitError('aborted: empty title')
      }
      const i = await ctx.api.post<Issue>(`${ctx.R}/issues`, { title, ...(body ? { body } : {}), ...(csv(p.values.label).length ? { labels: csv(p.values.label) } : {}), ...(csv(p.values.assignee).length ? { assignees: csv(p.values.assignee) } : {}) })
      if (json) printJson(i); else console.log(`${ctx.host}/${ctx.owner}/${ctx.repo}/issues/${i.number}\n${c.green('Created')} issue #${i.number}`)
      return 0
    }
    case 'comment': {
      const n = num()
      let body = str(p.values.body)
      if (!body) body = editText('\n# Write your comment. Lines starting with # are ignored.\n')
      if (!body) throw new DitError('aborted: empty comment')
      const r = await ctx.api.post(`${ctx.R}/issues/${n}/comments`, { body })
      if (json) printJson(r); else info(`${c.green('Commented')} on #${n}.`)
      return 0
    }
    case 'close': case 'reopen': {
      const n = num()
      const reason = str(p.values.reason)
      if (reason && !['completed', 'not_planned'].includes(reason)) throw new UsageError('--reason must be completed or not_planned')
      const i = await ctx.api.patch<Issue>(`${ctx.R}/issues/${n}`, sub === 'close' ? { state: 'closed', stateReason: reason ?? 'completed' } : { state: 'open' })
      if (json) printJson(i); else info(`#${n} is now ${i.state}.`)
      return 0
    }
    case 'label': {
      const n = num()
      const add = [...csv(p.values.add), ...p.positionals.slice(1).flatMap((x) => x.split(','))].filter(Boolean), remove = csv(p.values.remove)
      if (!add.length && !remove.length) throw new UsageError('nothing to do', 'Usage: dit issue label <n> bug,help-wanted   or   --add a --remove b')
      if (add.length) await ctx.api.post(`${ctx.R}/issues/${n}/labels`, { labels: add })
      for (const l of remove) await ctx.api.del(`${ctx.R}/issues/${n}/labels/${encodeURIComponent(l)}`)
      const i = await ctx.api.get<Issue>(`${ctx.R}/issues/${n}`)
      if (json) printJson(i.labels); else info(`#${n} labels: ${labelText(i) || '(none)'}`)
      return 0
    }
    case 'assign': {
      const n = num()
      const logins = p.positionals.slice(1).flatMap((x) => x.split(',')).filter(Boolean)
      if (!logins.length) throw new UsageError('missing <login>', 'Usage: dit issue assign <n> <login>... [--unassign]')
      if (flag(p.values.unassign)) for (const l of logins) await ctx.api.del(`${ctx.R}/issues/${n}/assignees/${encodeURIComponent(l)}`)
      else await ctx.api.post(`${ctx.R}/issues/${n}/assignees`, { assignees: logins })
      const i = await ctx.api.get<Issue>(`${ctx.R}/issues/${n}`)
      if (json) printJson(i.assignees); else info(`#${n} assignees: ${i.assignees.join(', ') || '(none)'}`)
      return 0
    }
    case 'import': {
      const r = await ctx.api.post<Issue>(`${ctx.R}/issues/import`, { url: needArg(p, 0, 'github-issue-url') })
      if (json) printJson(r); else info(`Imported as #${r.number}.`)
      return 0
    }
    default: throw new UsageError(sub ? `unknown subcommand "issue ${sub}"` : 'missing subcommand', 'Run `dit issue --help`.')
  }
}
