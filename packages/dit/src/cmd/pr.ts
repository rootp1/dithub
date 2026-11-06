import { csv, flag, intArg, needArg, parse, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { editText, splitTitleBody } from '../editor.ts'
import { configureCredentialHelper, currentBranch, git, gitInherit, withHelperEnv } from '../git.ts'
import { repoCtx } from '../repoctx.ts'
import { ago, c, info, printJson, table, trunc } from '../ui.ts'

interface Pr {
  number: number; title: string; body?: string | null; state: string; draft: boolean; author: string; head: string; base: string; headOid?: string
  mergeable: string; additions: number; deletions: number; changedFiles: number; createdAt: string; updatedAt: string; mergedAt?: string | null
  comments?: number; fromSession?: boolean; labels?: Array<{ name: string }>
  reviews?: { approvals: string[]; changesRequested: string[]; requiredApprovals: number }
  protection?: { pattern: string; requireStatusChecks: string[] } | null
}
const color = (s: string) => (s === 'open' ? c.green(s) : s === 'merged' ? c.magenta(s) : c.red(s))

export function colorDiff(text: string): string {
  return text.split('\n').map((l) => (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? c.bold(l) : l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : l)).join('\n')
}

export async function prCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, {
    title: { type: 'string', short: 't' }, body: { type: 'string', short: 'b' }, head: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' }, push: { type: 'boolean' },
    state: { type: 'string', short: 's' }, limit: { type: 'string', short: 'L' }, comments: { type: 'boolean' },
    approve: { type: 'boolean' }, 'request-changes': { type: 'boolean' }, comment: { type: 'boolean' },
    merge: { type: 'boolean' }, squash: { type: 'boolean' }, rebase: { type: 'boolean' },
  })
  const json = flag(p.values.json)
  const ctx = repoCtx(p.values)
  const num = () => intArg(needArg(p, 0, 'number'), 'number')
  const link = (n: number) => `${ctx.host}/${ctx.owner}/${ctx.repo}/pulls/${n}`

  switch (sub) {
    case 'list': case 'ls': {
      const state = str(p.values.state) ?? 'open'
      const r = await ctx.api.get<{ pulls: Pr[] }>(`${ctx.R}/pulls`, { state, per_page: Number(str(p.values.limit)) || 30 })
      if (json) printJson(r.pulls)
      else if (!r.pulls.length) info(`No ${state === 'all' ? '' : state + ' '}pull requests in ${ctx.slug}.`)
      else console.log(table(['#', 'STATE', 'TITLE', 'BRANCH', 'CHANGES', 'AUTHOR', 'UPDATED'], r.pulls.map((x) => [`#${x.number}`, color(x.draft ? 'draft' : x.state), trunc(x.title, 50), `${x.head} -> ${x.base}`, `+${x.additions} -${x.deletions}`, x.author ?? '', ago(x.updatedAt)])))
      return 0
    }
    case 'view': {
      const n = num()
      const pr = await ctx.api.get<Pr>(`${ctx.R}/pulls/${n}`)
      const cm = flag(p.values.comments) || json ? (await ctx.api.get<{ comments: Array<{ author: string; body: string; createdAt: string }> }>(`${ctx.R}/issues/${n}/comments`)).comments : []
      if (json) { printJson({ ...pr, commentList: cm }); return 0 }
      console.log(`${c.bold(`#${pr.number} ${pr.title}`)}  ${color(pr.state)}${pr.draft ? c.dim(' (draft)') : ''}${pr.fromSession ? c.dim(' (from a scoped session)') : ''}`)
      console.log(c.dim(`${pr.author} wants to merge ${pr.head} into ${pr.base} | +${pr.additions} -${pr.deletions} in ${pr.changedFiles} file(s) | mergeable: ${pr.mergeable}`))
      if (pr.reviews) console.log(c.dim(`reviews: ${pr.reviews.approvals.length}/${pr.reviews.requiredApprovals} approvals${pr.reviews.changesRequested.length ? `, changes requested by ${pr.reviews.changesRequested.join(', ')}` : ''}`))
      console.log(`\n${pr.body?.trim() || c.dim('(no description)')}`)
      for (const m of cm) console.log(`\n${c.bold(m.author)} ${c.dim(ago(m.createdAt))}\n${m.body}`)
      console.log(c.dim(`\n${link(pr.number)}`))
      return 0
    }
    case 'create': case 'new': {
      let head = str(p.values.head) ?? currentBranch() ?? undefined
      if (!head) throw new UsageError('cannot tell which branch to use', 'Pass --head <branch> or check out a branch.')
      let title = str(p.values.title), body = str(p.values.body)
      if (flag(p.values.push)) {
        if (gitInherit(['push', '-u', 'origin', head], { env: withHelperEnv(ctx.host) }) !== 0) throw new DitError(`could not push ${head}`)
      }
      if (!title) {
        const last = git(['log', '-1', '--format=%s'], {}).out.trim()
        const t = splitTitleBody(editText(`${last}\n\n${body ?? ''}\n# First line is the title; the rest is the description. Lines starting with # are ignored.\n`))
        title = t.title; body = body ?? t.body
        if (!title) throw new DitError('aborted: empty title')
      }
      try {
        const pr = await ctx.api.post<Pr>(`${ctx.R}/pulls`, { title, ...(body ? { body } : {}), head, ...(str(p.values.base) ? { base: str(p.values.base) } : {}), draft: flag(p.values.draft) })
        if (json) printJson(pr); else console.log(`${link(pr.number)}\n${c.green('Created')} pull request #${pr.number} (${pr.head} -> ${pr.base})`)
      } catch (err) {
        if (!flag(p.values.push) && /branch|head/i.test((err as Error).message)) info(c.yellow('Hint: the branch must exist on Dithub. Add --push to push it first.'))
        throw err
      }
      return 0
    }
    case 'diff': {
      const text = await ctx.api.text(`${ctx.R}/pulls/${num()}/diff`)
      process.stdout.write(process.stdout.isTTY && !process.env.NO_COLOR ? colorDiff(text) : text)
      return 0
    }
    case 'files': {
      const r = await ctx.api.get<{ files: Array<{ path: string; status: string; additions: number; deletions: number }> }>(`${ctx.R}/pulls/${num()}/files`)
      if (json) printJson(r.files)
      else console.log(table(['STATUS', 'PATH', 'CHANGES'], r.files.map((f) => [f.status, f.path, `+${f.additions} -${f.deletions}`])))
      return 0
    }
    case 'checks': {
      const n = num()
      const [pr, m] = await Promise.all([ctx.api.get<Pr>(`${ctx.R}/pulls/${n}`), ctx.api.get<{ mergeable: string; canMerge: boolean; blockers: string[] }>(`${ctx.R}/pulls/${n}/mergeable`)])
      const out = { number: n, state: pr.state, mergeable: m.mergeable, canMerge: m.canMerge, blockers: m.blockers, reviews: pr.reviews ?? null, requiredStatusChecks: pr.protection?.requireStatusChecks ?? [], protectedBy: pr.protection?.pattern ?? null }
      if (json) { printJson(out); return m.canMerge ? 0 : 1 }
      console.log(`${c.bold(`#${n}`)} ${color(pr.state)}   can merge: ${m.canMerge ? c.green('yes') : c.red('no')}   conflicts: ${m.mergeable}`)
      if (pr.reviews) console.log(`approvals: ${pr.reviews.approvals.length}/${pr.reviews.requiredApprovals}${pr.reviews.approvals.length ? ` (${pr.reviews.approvals.join(', ')})` : ''}`)
      if (out.requiredStatusChecks.length) console.log(`required status checks: ${out.requiredStatusChecks.join(', ')}`)
      for (const b of m.blockers) console.log(`  ${c.red('x')} ${b}`)
      if (!m.blockers.length && pr.state === 'open') console.log(`  ${c.green('ok')} nothing blocks this merge`)
      return m.canMerge ? 0 : 1
    }
    case 'review': {
      const n = num()
      const picks = [flag(p.values.approve) && 'approve', flag(p.values['request-changes']) && 'request_changes', flag(p.values.comment) && 'comment'].filter(Boolean) as string[]
      if (picks.length !== 1) throw new UsageError('choose exactly one of --approve, --request-changes, --comment')
      const event = picks[0]!
      let body = str(p.values.body)
      if (!body && event !== 'approve') body = editText('\n# Write your review. Lines starting with # are ignored.\n')
      const r = await ctx.api.post(`${ctx.R}/pulls/${n}/reviews`, { event, ...(body ? { body } : {}) })
      if (json) printJson(r); else info(`${c.green('Submitted')} ${event.replace('_', ' ')} review on #${n}.`)
      return 0
    }
    case 'merge': {
      const n = num()
      const methods = [flag(p.values.merge) && 'merge', flag(p.values.squash) && 'squash', flag(p.values.rebase) && 'rebase'].filter(Boolean) as string[]
      if (methods.length > 1) throw new UsageError('choose only one of --merge, --squash, --rebase')
      const r = await ctx.api.post<{ merged: boolean; method: string; mergeCommitOid: string }>(`${ctx.R}/pulls/${n}/merge`, { method: methods[0] ?? 'merge' })
      if (json) printJson(r); else info(`${c.green('Merged')} #${n} (${r.method}) as ${r.mergeCommitOid.slice(2, 12)}.`)
      return 0
    }
    case 'close': case 'reopen': {
      const n = num()
      const pr = await ctx.api.patch<Pr>(`${ctx.R}/pulls/${n}`, { state: sub === 'close' ? 'closed' : 'open' })
      if (json) printJson(pr); else info(`#${n} is now ${pr.state}.`)
      return 0
    }
    case 'checkout': {
      // PRs here are same-repo branches, so there is no refs/pull/N/head: fetch the head branch itself over git smart HTTP.
      const n = num()
      const pr = await ctx.api.get<Pr>(`${ctx.R}/pulls/${n}`)
      const remote = git(['remote'], {}).out.split('\n').includes('origin') ? 'origin' : null
      if (!remote) throw new DitError('no `origin` remote; run this inside a clone of the repository')
      configureCredentialHelper(git(['rev-parse', '--show-toplevel']).out.trim() || '.', ctx.host)
      const env = withHelperEnv(ctx.host)
      if (gitInherit(['fetch', remote, `+refs/heads/${pr.head}:refs/remotes/${remote}/${pr.head}`], { env }) !== 0) throw new DitError(`could not fetch branch ${pr.head}`)
      const code = gitInherit(['checkout', '-B', pr.head, '--track', `${remote}/${pr.head}`])
      if (code === 0) info(`On branch ${pr.head} (pull request #${n}).`)
      return code
    }
    default: throw new UsageError(sub ? `unknown subcommand "pr ${sub}"` : 'missing subcommand', 'Run `dit pr --help`.')
  }
}
void csv
