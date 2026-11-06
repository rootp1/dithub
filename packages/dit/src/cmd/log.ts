import { flag } from '../args.ts'
import { DitError } from '../errors.ts'
import { git, gitInherit, withHelperEnv } from '../git.ts'
import { repoCtx } from '../repoctx.ts'
import { c, printJson, short, table, trunc } from '../ui.ts'
import { findToken } from '../config.ts'

/** `dit log`: plain git log, or with --anchors the per-commit anchoring status from the API. */
export async function logCmd(argv: string[]): Promise<number> {
  if (!argv.includes('--anchors')) {
    return gitInherit(['log', ...argv])
  }
  const rest: string[] = []
  let json = false, repo: string | undefined, host: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--anchors') continue
    if (a === '--json') json = true
    else if (a === '-R' || a === '--repo') repo = argv[++i]
    else if (a === '--host') host = argv[++i]
    else rest.push(a)
  }
  const ctx = repoCtx({ ...(repo ? { repo } : {}), ...(host ? { host } : {}) })
  const l = git(['log', '--format=%H%x00%s', ...rest])
  if (l.code !== 0) throw new DitError(l.err.trim() || 'git log failed')
  const local = l.out.split('\n').filter(Boolean).map((x) => { const [oid, subject] = x.split('\0'); return { oid: oid!, subject: subject ?? '' } })
  const remote = await ctx.api.get<{ commits: Array<{ oid: string; anchor: { status: string; l1ChainId: number | null; l1Tx: string | null; arkivTx: string | null; arkivEntity: string | null } }> }>(`${ctx.R}/commits`)
  const known = new Map(remote.commits.map((x) => [x.oid.replace(/^0x/, ''), x.anchor]))
  const rows = local.filter((x) => known.has(x.oid)).map((x) => ({ commit: x.oid, subject: x.subject, ...known.get(x.oid)! }))
  if (json) { printJson(rows); return 0 }
  if (!rows.length) { console.log(c.dim('None of these commits are known to Dithub yet (push first).')); return 0 }
  const st = (s: string) => (s === 'anchored' ? c.green(s) : s === 'failed' ? c.red(s) : s === 'done_private' ? c.dim(s) : c.yellow(s))
  console.log(table(['COMMIT', 'SUBJECT', 'ANCHOR', 'SEPOLIA TX', 'ARKIV TX'], rows.map((r) => [short(r.commit, 8), trunc(r.subject, 40), st(r.status), r.l1Tx ? short(r.l1Tx, 14) : '-', r.arkivTx ? short(r.arkivTx, 14) : '-'])))
  return 0
}
void withHelperEnv; void findToken; void flag
