import { apiFor } from '../api.ts'
import { csv, flag, needArg, parse, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { findToken, primaryHost } from '../config.ts'
import { configureCredentialHelper, currentBranch, git, gitInherit, hasRemote, inferFromGit, toplevel, withHelperEnv } from '../git.ts'
import { repoCtx } from '../repoctx.ts'
import { repoBrowse } from './extra.ts'
import { c, info, printJson, table, ago } from '../ui.ts'

const PERMS = ['read', 'triage', 'write', 'maintain', 'admin']

export async function createRepoRemote(o: { name: string; org?: string | undefined; visibility: 'public' | 'private'; description?: string | undefined; host?: string | undefined; cwd: string | null; push: boolean; json?: boolean }): Promise<unknown> {
  const host = primaryHost(o.host)
  const api = apiFor(host, { flagHost: o.host })
  if (!api.hasToken) throw new DitError('you need to be logged in to create a repository', 1, 'Run `dit login`.')
  const created = await api.post<{ owner: string; name: string; cloneUrl: string; repoId: string }>('/api/repos', {
    name: o.name, ...(o.org ? { org: o.org } : {}), visibility: o.visibility, ...(o.description ? { description: o.description } : {}),
  })
  const url = `${host}/git/${created.owner}/${created.name}`
  if (o.cwd) {
    if (hasRemote('origin', o.cwd)) info(c.yellow(`origin already exists in ${o.cwd}; not changing it. New repo URL: ${url}`))
    else {
      git(['remote', 'add', 'origin', url], { cwd: o.cwd })
      configureCredentialHelper(o.cwd, host)
      info(`Added remote ${c.bold('origin')} -> ${url}`)
      if (o.push) {
        const br = currentBranch(o.cwd)
        if (!br || git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: o.cwd }).code !== 0) info(c.yellow('Nothing to push yet (no commits).'))
        else if (gitInherit(['push', '-u', 'origin', br], { cwd: o.cwd, env: withHelperEnv(host) }) !== 0) throw new DitError('created the repository but the push failed')
      }
    }
  }
  if (o.json) printJson({ ...created, cloneUrl: url }); else info(`${c.green('Created')} ${c.bold(`${created.owner}/${created.name}`)} (${o.visibility}) at ${host}`)
  return created
}

export async function repoCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'create': {
      const p = parse(rest, { org: { type: 'string' }, private: { type: 'boolean' }, public: { type: 'boolean' }, description: { type: 'string', short: 'd' }, push: { type: 'boolean' } })
      const top = toplevel()
      const name = p.positionals[0] ?? (top ? top.split('/').pop()! : undefined)
      if (!name) throw new UsageError('missing <name>', 'Usage: dit repo create <name> [--org o] [--private]')
      await createRepoRemote({ name, org: str(p.values.org), visibility: flag(p.values.private) && !flag(p.values.public) ? 'private' : 'public', description: str(p.values.description), host: str(p.values.host), cwd: top, push: flag(p.values.push), json: flag(p.values.json) })
      return 0
    }
    case 'list': {
      const p = parse(rest, { owner: { type: 'string' }, limit: { type: 'string', short: 'L' } }, { allowPositionals: false })
      const host = primaryHost(str(p.values.host))
      const r = await apiFor(host, { flagHost: str(p.values.host) }).get<{ repos: Array<{ owner: string; name: string; description: string | null; visibility: string; pushedAt: string | null }> }>('/api/repos')
      let repos = r.repos
      if (str(p.values.owner)) repos = repos.filter((x) => x.owner === str(p.values.owner))
      repos = repos.slice(0, Number(str(p.values.limit)) || 100)
      if (flag(p.values.json)) printJson(repos)
      else if (!repos.length) info('No repositories.')
      else console.log(table(['REPO', 'VISIBILITY', 'UPDATED', 'DESCRIPTION'], repos.map((x) => [`${x.owner}/${x.name}`, x.visibility, ago(x.pushedAt), x.description ?? ''])))
      return 0
    }
    case 'view': {
      const p = parse(rest)
      const v = { ...p.values, ...(p.positionals[0] ? { repo: p.positionals[0] } : {}) }
      const ctx = repoCtx(v)
      const r = await ctx.api.get<{ owner: string; name: string; description: string | null; visibility: string; defaultBranch: string; canWrite: boolean; cloneUrl: string; refs: Array<{ name: string; oid: string }> }>(ctx.R)
      if (flag(p.values.json)) { printJson(r); return 0 }
      console.log(`${c.bold(`${r.owner}/${r.name}`)}  ${c.dim(r.visibility)}`)
      if (r.description) console.log(r.description)
      console.log(`default branch: ${r.defaultBranch}   you can push: ${r.canWrite ? 'yes' : 'no'}`)
      console.log(`clone: dit clone ${r.owner}/${r.name}${ctx.host === primaryHost() ? '' : `@${ctx.host}`}`)
      console.log(`url:   ${ctx.host}/git/${r.owner}/${r.name}`)
      const branches = r.refs.filter((x) => x.name.startsWith('refs/heads/'))
      if (branches.length) console.log(`branches: ${branches.map((b) => b.name.slice(11)).join(', ')}`)
      return 0
    }
    case 'ls': case 'cat': case 'commits': case 'ledger': return repoBrowse(sub, rest)
    case 'collaborators': case 'collab': return collaborators(rest)
    case 'grant-team': {
      const p = parse(rest)
      const ctx = repoCtx(p.values)
      const team = needArg(p, 0, 'team'), perm = needArg(p, 1, 'permission')
      if (!PERMS.includes(perm)) throw new UsageError(`permission must be one of ${PERMS.join(', ')}`)
      await ctx.api.put(`${ctx.R}/teams/${team}`, { permission: perm })
      if (flag(p.values.json)) printJson({ ok: true }); else info(`Team ${team} now has ${perm} on ${ctx.slug}.`)
      return 0
    }
    case 'delete': case 'rm':
      throw new DitError('the Dithub API has no repository delete endpoint yet, so `dit repo delete` is not available')
    default: throw new UsageError(sub ? `unknown subcommand "repo ${sub}"` : 'missing subcommand', 'Run `dit repo --help`.')
  }
}

async function collaborators(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, { permission: { type: 'string', short: 'p' } })
  const ctx = repoCtx(p.values)
  const json = flag(p.values.json)
  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const r = await ctx.api.get<{ collaborators: Array<{ login: string; permission: string }>; teams: Array<{ slug: string; permission: string }> }>(`${ctx.R}/collaborators`)
    if (json) printJson(r)
    else {
      console.log(table(['USER', 'PERMISSION'], r.collaborators.map((x) => [x.login, x.permission])))
      if (r.teams.length) console.log('\n' + table(['TEAM', 'PERMISSION'], r.teams.map((x) => [x.slug, x.permission])))
    }
    return 0
  }
  const login = needArg(p, 0, 'login')
  if (sub === 'add') {
    const permission = str(p.values.permission) ?? 'write'
    if (!PERMS.includes(permission)) throw new UsageError(`permission must be one of ${PERMS.join(', ')}`)
    await ctx.api.put(`${ctx.R}/collaborators/${login}`, { permission })
    if (json) printJson({ ok: true, login, permission }); else info(`${login} now has ${permission} on ${ctx.slug}.`)
    return 0
  }
  if (sub === 'remove' || sub === 'rm') {
    await ctx.api.del(`${ctx.R}/collaborators/${login}`)
    if (json) printJson({ ok: true, login }); else info(`Removed ${login} from ${ctx.slug}.`)
    return 0
  }
  throw new UsageError(`unknown subcommand "repo collaborators ${sub}"`)
}

export async function protect(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, { 'require-pr': { type: 'boolean' }, 'no-require-pr': { type: 'boolean' }, approvals: { type: 'string' }, 'allow-force-push': { type: 'boolean' }, 'allow-deletions': { type: 'boolean' } })
  const ctx = repoCtx(p.values)
  const json = flag(p.values.json)
  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const r = await ctx.api.get<{ protections: Array<{ pattern: string; require_pr: boolean; required_approvals: number; allow_force_push: boolean; allow_deletions: boolean }> }>(`${ctx.R}/protections`)
    if (json) printJson(r.protections)
    else if (!r.protections.length) info('No branch protection rules.')
    else console.log(table(['PATTERN', 'REQUIRE PR', 'APPROVALS', 'FORCE PUSH', 'DELETIONS'], r.protections.map((x) => [x.pattern, x.require_pr ? 'yes' : 'no', String(x.required_approvals), x.allow_force_push ? 'allowed' : 'blocked', x.allow_deletions ? 'allowed' : 'blocked'])))
    return 0
  }
  const pattern = needArg(p, 0, 'branch-pattern')
  if (sub === 'set') {
    const approvals = str(p.values.approvals)
    if (approvals !== undefined && !/^\d+$/.test(approvals)) throw new UsageError('--approvals must be a number')
    await ctx.api.put(`${ctx.R}/protections`, {
      pattern, requirePr: !flag(p.values['no-require-pr']), ...(approvals !== undefined ? { requiredApprovals: Number(approvals) } : {}),
      allowForcePush: flag(p.values['allow-force-push']), allowDeletions: flag(p.values['allow-deletions']),
    })
    if (json) printJson({ ok: true, pattern }); else info(`Protected ${pattern} on ${ctx.slug}.`)
    return 0
  }
  if (sub === 'remove' || sub === 'rm') {
    await ctx.api.del(`${ctx.R}/protections`, { pattern })
    if (json) printJson({ ok: true, pattern }); else info(`Removed protection for ${pattern} on ${ctx.slug}.`)
    return 0
  }
  throw new UsageError(`unknown subcommand "protect ${sub}"`)
}
void csv; void inferFromGit
