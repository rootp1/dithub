import { flag, needArg, parse, str } from '../args.ts'
import { UsageError } from '../errors.ts'
import { apiForFlags } from '../repoctx.ts'
import { c, info, printJson, table } from '../ui.ts'

export async function orgCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, { role: { type: 'string' }, private: { type: 'boolean' }, name: { type: 'string' } })
  const json = flag(p.values.json)
  const api = apiForFlags(p.values)
  const out = (v: unknown, msg: string) => { if (json) printJson(v); else info(msg) }
  switch (sub) {
    case 'list': case 'ls': case undefined: {
      const r = await api.get<{ orgs: Array<{ login: string; visibility: string; role: string; members: number; repos: number }> }>('/api/me/orgs')
      if (json) printJson(r.orgs)
      else if (!r.orgs.length) info('You do not belong to any organisation.')
      else console.log(table(['ORG', 'VISIBILITY', 'YOUR ROLE', 'MEMBERS', 'REPOS'], r.orgs.map((o) => [o.login, o.visibility, o.role, String(o.members), String(o.repos)])))
      return 0
    }
    case 'view': {
      const org = needArg(p, 0, 'org')
      const r = await api.get<{ login: string; visibility: string; yourRole: string | null; members: Array<{ login: string; role: string }>; teams: Array<{ slug: string; name: string; members: number }>; rbacSeq: number }>(`/api/orgs/${org}`)
      if (json) { printJson(r); return 0 }
      console.log(`${c.bold(r.login)}  ${c.dim(r.visibility)}  your role: ${r.yourRole ?? 'none'}  rbac events: ${r.rbacSeq}`)
      console.log('\n' + table(['MEMBER', 'ROLE'], r.members.map((m) => [m.login, m.role])))
      if (r.teams.length) console.log('\n' + table(['TEAM', 'NAME', 'MEMBERS'], r.teams.map((t) => [t.slug, t.name, String(t.members)])))
      return 0
    }
    case 'create': {
      const login = needArg(p, 0, 'org')
      const r = await api.post('/api/orgs', { login, visibility: flag(p.values.private) ? 'private' : 'public' })
      out(r, `${c.green('Created')} organisation ${login}.`)
      return 0
    }
    case 'log': {
      const org = needArg(p, 0, 'org')
      const r = await api.get<{ head: string | null; events: Array<{ seq: number; actor: string; action: string; hash: string; arkivTx: string | null }> }>(`/api/orgs/${org}/rbac-log`)
      if (json) printJson(r); else console.log(table(['SEQ', 'ACTOR', 'ACTION', 'HASH', 'ARKIV TX'], r.events.map((e) => [String(e.seq), e.actor, e.action, e.hash.slice(0, 14), e.arkivTx?.slice(0, 14) ?? '-'])))
      return 0
    }
    case 'members': {
      const [op, ...pos] = p.positionals
      const org = pos[0], login = pos[1]
      if (!op || !org || !login) throw new UsageError('usage: dit org members add|remove <org> <login> [--role owner|member]')
      if (op === 'add') { const role = str(p.values.role) ?? 'member'; await api.put(`/api/orgs/${org}/members/${login}`, { role }); out({ ok: true, org, login, role }, `${login} is now ${role} of ${org}.`) }
      else if (op === 'remove' || op === 'rm') { await api.del(`/api/orgs/${org}/members/${login}`); out({ ok: true }, `Removed ${login} from ${org}.`) }
      else throw new UsageError(`unknown subcommand "org members ${op}"`)
      return 0
    }
    case 'team': {
      const [op, ...pos] = p.positionals
      if (op === 'create') {
        const [org, slug] = pos
        if (!org || !slug) throw new UsageError('usage: dit org team create <org> <slug> [--name "Display name"]')
        await api.post(`/api/orgs/${org}/teams`, { slug, ...(str(p.values.name) ? { name: str(p.values.name) } : {}) })
        out({ ok: true, org, slug }, `${c.green('Created')} team ${slug} in ${org}.`)
      } else if (op === 'add' || op === 'remove' || op === 'rm') {
        const [org, team, login] = pos
        if (!org || !team || !login) throw new UsageError(`usage: dit org team ${op} <org> <team> <login>`)
        if (op === 'add') await api.put(`/api/orgs/${org}/teams/${team}/members/${login}`, {}); else await api.del(`/api/orgs/${org}/teams/${team}/members/${login}`)
        out({ ok: true }, `${op === 'add' ? 'Added' : 'Removed'} ${login} ${op === 'add' ? 'to' : 'from'} team ${team} in ${org}.`)
      } else throw new UsageError('usage: dit org team create|add|remove ...')
      return 0
    }
    default: throw new UsageError(`unknown subcommand "org ${sub}"`, 'Run `dit org --help`.')
  }
}
