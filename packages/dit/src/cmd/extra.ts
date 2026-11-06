// Smaller platform commands: repo browsing without cloning, names, deployments, labels, tokens, assistant history.
import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flag, needArg, parse, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { findToken, primaryHost, saveCredential } from '../config.ts'
import { apiForFlags, repoCtx, type Ctx } from '../repoctx.ts'
import { parseRepoRef } from '../git.ts'
import { Api, apiFor } from '../api.ts'
import { ago, c, info, printJson, short, table, trunc } from '../ui.ts'

// ---------- dit repo ls|cat|commits|ledger (read through the API, normal permissions, no session header) ----------
export async function repoBrowse(sub: string, argv: string[]): Promise<number> {
  const p = parse(argv, { ref: { type: 'string' }, limit: { type: 'string', short: 'L' } })
  const json = flag(p.values.json)
  const ctx = repoCtx(p.values)
  const ref = str(p.values.ref)
  if (sub === 'ls') {
    const path = (p.positionals[0] ?? '').replace(/^\/+|\/+$/g, '')
    const r = await ctx.api.get<{ entries: Array<{ type: string; name: string; path: string; size: number | null; mode: string }> }>(`${ctx.R}/tree`, { path, ref })
    if (json) printJson(r.entries)
    else if (!r.entries.length) info('(empty or no such path)')
    else for (const e of r.entries) console.log(`${e.type === 'tree' ? c.cyan('dir ') : 'file'}  ${e.type === 'tree' ? c.cyan(e.name + '/') : e.name}${e.size != null ? c.dim(`  ${e.size}B`) : ''}`)
    return 0
  }
  if (sub === 'cat') {
    const path = needArg(p, 0, 'path').replace(/^\/+/, '')
    const r = await ctx.api.get<{ path: string; size: number; binary?: boolean; truncated?: boolean; content: string | null }>(`${ctx.R}/blob`, { path, ref })
    if (json) { printJson(r); return 0 }
    if (r.content === null) throw new DitError(r.truncated ? `${path} is too large to print (${r.size} bytes); clone the repo` : `${path} is binary (${r.size} bytes); clone the repo`)
    process.stdout.write(r.content)
    return 0
  }
  if (sub === 'commits') {
    const r = await ctx.api.get<{ commits: Array<{ oid: string; subject: string; author: string; committedAt: string; anchor?: { status: string; l1Tx: string | null; arkivTx: string | null } }> }>(`${ctx.R}/commits`)
    const rows = r.commits.slice(0, Number(str(p.values.limit)) || 30)
    if (json) { printJson(rows); return 0 }
    const chip = (s?: string) => (s === 'anchored' ? c.green('anchored') : s === 'failed' ? c.red(s) : s === 'done_private' ? c.dim('private') : s && s !== 'none' ? c.yellow(s) : c.dim('none'))
    console.log(table(['COMMIT', 'SUBJECT', 'AUTHOR', 'WHEN', 'ANCHOR', 'L1 TX', 'ARKIV TX'], rows.map((x) => [short(x.oid, 8), trunc(x.subject, 44), x.author ?? '', ago(x.committedAt), chip(x.anchor?.status), x.anchor?.l1Tx ? short(x.anchor.l1Tx, 12) : '-', x.anchor?.arkivTx ? short(x.anchor.arkivTx, 12) : '-'])))
    return 0
  }
  // ledger
  const r = await ctx.api.get<{ anchors: Array<{ ref_name: string; chain_id: number | string; contract: string; tx: string; ref_sequence: number | string; root: string }>; entities: Array<{ schema: string; entity: string; tx: string; expires_at_block: number | string | null }> }>(`${ctx.R}/ledger`)
  if (json) { printJson(r); return 0 }
  console.log(c.bold('L1 anchors'))
  console.log(r.anchors.length ? table(['REF', 'SEQ', 'CHAIN', 'TX', 'ROOT'], r.anchors.map((a) => [a.ref_name, String(a.ref_sequence), String(a.chain_id), short(a.tx, 14), short(a.root, 14)])) : c.dim('none yet'))
  console.log('\n' + c.bold('Arkiv entities'))
  console.log(r.entities.length ? table(['SCHEMA', 'ENTITY', 'TX', 'EXPIRES AT BLOCK'], r.entities.map((e) => [e.schema, short(e.entity, 14), short(e.tx, 14), e.expires_at_block == null ? '-' : String(e.expires_at_block)])) : c.dim('none yet'))
  return 0
}

// ---------- dit name resolve ----------
export async function nameCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest)
  if (sub !== 'resolve') throw new UsageError(sub ? `unknown subcommand "name ${sub}"` : 'missing subcommand', 'Usage: dit name resolve <owner/repo>')
  const ref = parseRepoRef(needArg(p, 0, 'owner/repo'))
  if (!ref) throw new UsageError('use owner/repo')
  const r = await apiForFlags(p.values).get<{ repoId: string; claimant: string | null; arkivEntity: string | null }>(`/api/names/${ref.owner}/${ref.repo}`)
  if (flag(p.values.json)) printJson({ name: `${ref.owner}/${ref.repo}`, ...r })
  else console.log(`name:      ${ref.owner}/${ref.repo}\nrepoId:    ${r.repoId}\nclaimant:  ${r.claimant ?? '-'}\narkiv entity: ${r.arkivEntity ?? '(not mirrored yet)'}`)
  return 0
}

// ---------- dit deployments ----------
interface Dep { releaseId: number; commit: string | null; bundleHash: string | null; url: string | null; publishedAt: string | null; publishTx: string | null; attested: boolean; ok: boolean | null; attestedAt: string | null; attestTx: string | null; arkivEntity: string | null }
export async function deploymentsCmd(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  const sub = first && !first.startsWith('-') ? first : 'list'
  const p = parse(sub === 'list' && first !== 'list' ? argv : rest, { limit: { type: 'string', short: 'L' } }, { allowPositionals: false })
  const json = flag(p.values.json)
  const api = apiForFlags(p.values)
  if (sub === 'latest') {
    const r = await api.get<{ source: string; deployment: Dep | null }>('/api/deployments/latest')
    if (json) { printJson(r); return 0 }
    const d = r.deployment!
    console.log(`${c.bold(`release #${d.releaseId}`)}  source: ${r.source}\ncommit:      ${d.commit ?? '-'}\nbundleHash:  ${d.bundleHash ?? '-'}\nurl:         ${d.url ?? '-'}\npublished:   ${d.publishedAt ?? '-'}  tx ${d.publishTx ?? '-'}\nattested:    ${d.attested ? (d.ok ? c.green('ok') : c.red('MISMATCH')) : c.yellow('not yet')}${d.attestTx ? `  tx ${d.attestTx}` : ''}\narkiv entity: ${d.arkivEntity ?? '-'}`)
    return 0
  }
  if (sub !== 'list') throw new UsageError(`unknown subcommand "deployments ${sub}"`)
  const r = await api.get<{ source: string; deployments: Dep[] }>('/api/deployments')
  const rows = r.deployments.slice(0, Number(str(p.values.limit)) || 20)
  if (json) { printJson({ source: r.source, deployments: rows }); return 0 }
  console.log(table(['RELEASE', 'COMMIT', 'BUNDLE HASH', 'ATTESTED', 'PUBLISH TX', 'ATTEST TX'], rows.map((d) => [`#${d.releaseId}`, short(d.commit, 8), short(d.bundleHash, 12), d.attested ? (d.ok ? c.green('ok') : c.red('MISMATCH')) : c.yellow('no'), short(d.publishTx, 12), short(d.attestTx, 12)])))
  console.log(c.dim(`source: ${r.source}${r.source !== 'arkiv' ? ' (Arkiv was unreachable; showing the SQLite mirror)' : ''}`))
  return 0
}

// ---------- dit label ----------
export async function labelCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, { color: { type: 'string' }, description: { type: 'string', short: 'd' }, name: { type: 'string' } })
  const json = flag(p.values.json)
  const ctx: Ctx = repoCtx(p.values)
  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const r = await ctx.api.get<{ labels: Array<{ name: string; color: string; description: string | null }> }>(`${ctx.R}/labels`)
    if (json) printJson(r.labels); else console.log(table(['NAME', 'COLOR', 'DESCRIPTION'], r.labels.map((l) => [l.name, '#' + l.color, l.description ?? ''])))
    return 0
  }
  const name = needArg(p, 0, 'name')
  const color = str(p.values.color)?.replace(/^#/, '')
  if (color && !/^[0-9a-fA-F]{6}$/.test(color)) throw new UsageError('--color must be a 6-digit hex value like ff0000')
  const out = (v: unknown, msg: string) => { if (json) printJson(v); else info(msg) }
  if (sub === 'create') { out(await ctx.api.post(`${ctx.R}/labels`, { name, ...(color ? { color } : {}), ...(str(p.values.description) ? { description: str(p.values.description) } : {}) }), `${c.green('Created')} label ${name}.`); return 0 }
  if (sub === 'edit') {
    if (!color && str(p.values.description) === undefined && !str(p.values.name)) throw new UsageError('nothing to change', 'Use --color, --description or --name.')
    out(await ctx.api.patch(`${ctx.R}/labels/${encodeURIComponent(name)}`, { ...(str(p.values.name) ? { name: str(p.values.name) } : {}), ...(color ? { color } : {}), ...(str(p.values.description) !== undefined ? { description: str(p.values.description) } : {}) }), `Updated label ${name}.`); return 0
  }
  if (sub === 'delete' || sub === 'rm') { out(await ctx.api.del(`${ctx.R}/labels/${encodeURIComponent(name)}`), `Deleted label ${name}.`); return 0 }
  throw new UsageError(`unknown subcommand "label ${sub}"`)
}

// ---------- dit token create ----------
export async function tokenCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const p = parse(rest, { name: { type: 'string' }, show: { type: 'boolean' }, out: { type: 'string', short: 'o' } }, { allowPositionals: false })
  if (sub !== 'create') throw new UsageError(sub ? `unknown subcommand "token ${sub}"` : 'missing subcommand', 'Usage: dit token create [--name N] [--out FILE | --show]')
  const outFile = str(p.values.out), show = flag(p.values.show)
  if (!outFile && !show && process.stdout.isTTY) throw new UsageError('refusing to print a token to your terminal', 'Use --out FILE (mode 0600), --show, or pipe stdout: dit token create | pbcopy')
  const host = primaryHost(str(p.values.host))
  const api = apiFor(host, { flagHost: str(p.values.host) })
  if (!api.hasToken) throw new DitError('you need to be logged in', 1, 'Run `dit login`.')
  const r = await api.post<{ token: string }>('/api/tokens', { name: (str(p.values.name) ?? 'dit').slice(0, 60) })
  if (outFile) {
    const file = resolve(outFile)
    writeFileSync(file, r.token + '\n', { mode: 0o600, flag: 'wx' }); chmodSync(file, 0o600)
    if (flag(p.values.json)) printJson({ file }); else info(`Token written to ${file} (mode 0600). It is not shown again.`)
  } else if (flag(p.values.json)) printJson({ token: r.token })
  else process.stdout.write(r.token + '\n')
  return 0
}

// ---------- dit auth username ----------
export async function setUsername(argv: string[]): Promise<number> {
  const p = parse(argv)
  const login = needArg(p, 0, 'new-login')
  const host = primaryHost(str(p.values.host))
  const r = await apiFor(host, { flagHost: str(p.values.host) }).patch<{ ok: boolean; login: string }>('/api/me', { login })
  const tok = findToken(host, str(p.values.host))
  if (tok?.source === 'file') saveCredential(host, { token: tok.token, login: r.login })
  if (flag(p.values.json)) printJson(r); else info(`You are now ${c.bold(r.login)}. Remotes that used the old name need \`git remote set-url\`.`)
  return 0
}

// ---------- dit session calls ----------
export async function sessionCalls(api: Api, id: string, json: boolean): Promise<number> {
  const r = await api.get<{ calls: Array<{ id: string; kind: string; model: string | null; requestId: string | null; refused: boolean; refusalReason: string | null; sealed: boolean | null; teeVerified: boolean | null; failed: boolean; question: string | null; answer: string | null; createdAt: string }> }>(`/api/sessions/${id}/assistant/calls`)
  if (json) { printJson(r.calls); return 0 }
  if (!r.calls.length) { info('No assistant calls yet.'); return 0 }
  console.log(table(['WHEN', 'KIND', 'MODEL', '0G REQUEST', 'BADGES', 'QUESTION'], r.calls.map((x) => [ago(x.createdAt), x.kind, x.model ?? '-', x.requestId ?? '-', [x.refused ? c.yellow('REFUSED') : '', x.sealed ? c.green('sealed') : '', x.failed ? c.red('failed') : ''].filter(Boolean).join(' ') || '-', trunc(x.question ?? '', 40)])))
  return 0
}
