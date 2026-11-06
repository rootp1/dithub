// `dit verify site|commit`: independent checks against Sepolia via manual JSON-RPC (no libraries).
import { createHash } from 'node:crypto'
import { Api, apiFor } from '../api.ts'
import { flag, needArg, parse, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { primaryHost } from '../config.ts'
import { SEPOLIA } from '../constants.ts'
import { git } from '../git.ts'
import { repoCtx } from '../repoctx.ts'
import { c, printJson } from '../ui.ts'

const rpcUrl = () => process.env.DIT_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? SEPOLIA.rpcUrl
export const sha256 = (b: Uint8Array | string) => `0x${createHash('sha256').update(b).digest('hex')}`
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function rpc<T = unknown>(method: string, params: unknown[], f: typeof fetch = fetch): Promise<T> {
  const res = await f(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
  const j = (await res.json()) as { result?: T; error?: { message?: string } }
  if (j.error) throw new Error(j.error.message ?? 'RPC error')
  return j.result as T
}

// ----- ABI decoding (static words + one dynamic string) -----
function words(data: string): string[] {
  const h = data.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 64 !== 0) throw new Error('malformed ABI data')
  return h.match(/.{64}/g) ?? []
}
const big = (w: string | undefined) => { if (w === undefined) throw new Error('ABI data too short'); return BigInt('0x' + w) }
export interface OnchainRelease { id: number; commit: string; bundleHash: string; url: string; publishedAt: number; publisher: string }
export function decodeLatestRelease(data: string): OnchainRelease {
  const w = words(data), h = data.replace(/^0x/, '')
  const off = Number(big(w[3])) / 32, len = Number(big(w[off]))
  const start = (off + 1) * 64
  if (len * 2 > h.length - start) throw new Error('ABI string out of range')
  const url = Buffer.from(h.slice(start, start + len * 2), 'hex').toString('utf8')
  return { id: Number(big(w[0])), commit: '0x' + w[1], bundleHash: '0x' + w[2], url, publishedAt: Number(big(w[4])), publisher: '0x' + w[5]!.slice(24) }
}
export function decodeLatestAttestation(data: string): { releaseId: number; ok: boolean; observedAt: number } {
  const w = words(data)
  return { releaseId: Number(big(w[0])), ok: big(w[1]) === 1n, observedAt: Number(big(w[2])) }
}
/** sha256 of the sorted name->hash JSON, exactly as apps/web/build.ts computes bundleHash. */
export function bundleHashOf(files: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]!
  return sha256(JSON.stringify(sorted))
}

export interface Row { check: string; status: 'PASS' | 'FAIL' | 'WARN' | 'INFO'; detail: string }
export function report(title: string, rows: Row[], json: boolean): number {
  const failed = rows.filter((r) => r.status === 'FAIL').length
  if (json) { printJson({ title, ok: failed === 0, checks: rows }); return failed ? 1 : 0 }
  console.log(c.bold(title))
  const w = Math.max(...rows.map((r) => r.check.length))
  for (const r of rows) {
    const tag = r.status === 'PASS' ? c.green('PASS') : r.status === 'FAIL' ? c.red('FAIL') : r.status === 'WARN' ? c.yellow('WARN') : c.dim('INFO')
    console.log(`${tag}  ${r.check.padEnd(w)}  ${r.detail}`)
  }
  console.log(failed ? `\n${c.red(`RESULT: FAIL (${failed})`)}` : `\n${c.green('RESULT: PASS')}`)
  return failed ? 1 : 0
}

export async function verifySite(host: string, json: boolean): Promise<number> {
  const rows: Row[] = []
  const add = (check: string, status: Row['status'], detail: string) => rows.push({ check, status, detail })
  const site = host.replace(/\/$/, '')
  await (async () => {
    const res = await fetch(`${site}/build.json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) { add('fetch /build.json', 'FAIL', `HTTP ${res.status}`); return }
    let build: { commit: string; bundleHash: string; files: Record<string, string> }
    try { build = JSON.parse(await res.text()) } catch { add('fetch /build.json', 'FAIL', 'response is not JSON (site not rebuilt with build.json?)'); return }
    add('fetch /build.json', 'PASS', `commit ${String(build.commit).slice(0, 12)}`)
    const actual: Record<string, string> = {}
    for (const name of Object.keys(build.files).sort()) {
      const r = await fetch(`${site}/${name}`, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok) { add(`file ${name}`, 'FAIL', `HTTP ${r.status}`); continue }
      actual[name] = sha256(new Uint8Array(await r.arrayBuffer()))
      add(`file ${name}`, eq(actual[name]!, build.files[name]!) ? 'PASS' : 'FAIL', actual[name]!.slice(0, 18) + '...')
    }
    const recomputed = bundleHashOf(actual)
    add('bundleHash recomputed', eq(recomputed, build.bundleHash) ? 'PASS' : 'FAIL', recomputed.slice(0, 18) + '...')
    const rel = decodeLatestRelease(await rpc<string>('eth_call', [{ to: SEPOLIA.registry, data: SEPOLIA.selLatestRelease }, 'latest']))
    if (rel.id === 0) { add('on-chain latestRelease', 'FAIL', 'no release published'); return }
    add('on-chain latestRelease', 'PASS', `#${rel.id} by ${rel.publisher} at ${new Date(rel.publishedAt * 1000).toISOString()} (${rel.url})`)
    add('bundleHash == on-chain', eq(rel.bundleHash, recomputed) ? 'PASS' : 'FAIL', `chain ${rel.bundleHash.slice(0, 18)}...`)
    const wantCommit = `0x${String(build.commit).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
    add('commit == on-chain', /^[0-9a-f]{40}$/i.test(String(build.commit).replace(/^0x/, '')) && eq(rel.commit, wantCommit) ? 'PASS' : 'FAIL', `chain ${rel.commit.slice(26, 38)}...`)
    const att = decodeLatestAttestation(await rpc<string>('eth_call', [{ to: SEPOLIA.attestations, data: SEPOLIA.selLatestAttestation }, 'latest']))
    if (att.releaseId === 0) add('CRE attestation', 'WARN', 'none recorded yet')
    else if (att.releaseId !== rel.id) add('CRE attestation', 'WARN', `latest attestation is for release #${att.releaseId}, not #${rel.id}`)
    else add('CRE attestation for latest release', att.ok ? 'PASS' : 'FAIL', `ok=${att.ok} observed ${new Date(att.observedAt * 1000).toISOString()}`)
  })().catch((e) => add('verifier error', 'FAIL', String(e?.message ?? e).slice(0, 200)))
  return report(`Site: ${site}`, rows, json)
}

export async function verifyCommit(ctx: ReturnType<typeof repoCtx>, shaArg: string, json: boolean): Promise<number> {
  let oid = shaArg.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{7,40}$/.test(oid)) {
    const r = git(['rev-parse', '--verify', `${shaArg}^{commit}`])
    if (r.code !== 0) throw new UsageError(`"${shaArg}" is not a commit id or a local revision`)
    oid = r.out.trim()
  }
  const rows: Row[] = []
  const add = (check: string, status: Row['status'], detail: string) => rows.push({ check, status, detail })
  const list = await ctx.api.get<{ commits: Array<{ oid: string; subject: string; anchor: { status: string; l1ChainId: number | null; l1Tx: string | null; arkivTx: string | null; arkivEntity: string | null } }>; scoped?: boolean }>(`${ctx.R}/commits`)
  if (list.scoped) throw new DitError('commit anchors are not available inside a scoped session')
  const m = list.commits.filter((x) => x.oid.replace(/^0x/, '').startsWith(oid))
  if (m.length !== 1) { add('commit known to Dithub', 'FAIL', m.length ? 'ambiguous prefix' : `not among the latest ${list.commits.length} commits of ${ctx.slug}`); return report(`Commit ${oid.slice(0, 12)}`, rows, json) }
  const cm = m[0]!, a = cm.anchor
  add('commit known to Dithub', 'PASS', cm.subject)
  add('anchor status', a.status === 'anchored' ? 'PASS' : a.status === 'failed' ? 'FAIL' : 'WARN', a.status === 'done_private' ? 'done_private (private repo: nothing is mirrored on-chain)' : a.status)
  if (a.l1Tx) {
    try {
      const rc = await rpc<{ status: string; blockNumber: string } | null>('eth_getTransactionReceipt', [a.l1Tx])
      if (!rc) add('Ethereum Sepolia tx receipt', 'FAIL', `${a.l1Tx} not found on ${rpcUrl()}`)
      else add('Ethereum Sepolia tx receipt', rc.status === '0x1' ? 'PASS' : 'FAIL', `${a.l1Tx.slice(0, 18)}... block ${parseInt(rc.blockNumber, 16)} status ${rc.status === '0x1' ? 'success' : 'reverted'}`)
    } catch (e) { add('Ethereum Sepolia tx receipt', 'FAIL', `RPC error: ${(e as Error).message.slice(0, 120)}`) }
  } else add('Ethereum Sepolia tx receipt', 'WARN', 'no L1 transaction recorded for this commit yet')
  if (a.arkivEntity) {
    try {
      const led = await ctx.api.get<{ entities: Array<{ entity: string; tx: string }>; anchors: Array<{ tx: string }> }>(`${ctx.R}/ledger`)
      const ent = a.arkivEntity.replace(/^0x/, '').toLowerCase()
      const hit = led.entities.find((x) => x.entity.toLowerCase() === ent)
      add('Arkiv entity in ledger', hit ? 'PASS' : 'FAIL', hit ? `entity ${ent.slice(0, 14)}... tx ${hit.tx?.slice(0, 14) ?? a.arkivTx?.slice(0, 14) ?? '-'}` : `entity ${ent.slice(0, 14)}... not in /ledger`)
    } catch (e) { add('Arkiv entity in ledger', 'FAIL', (e as Error).message) }
  } else add('Arkiv entity in ledger', 'WARN', 'no Arkiv entity recorded for this commit yet')
  return report(`Commit ${cm.oid.slice(2, 14)} in ${ctx.slug}`, rows, json)
}

export async function verifyCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === 'rebuild') { const { rebuildCmd } = await import('./rebuild.ts'); return rebuildCmd(rest) }
  const p = parse(rest)
  const json = flag(p.values.json)
  if (sub === 'site') return verifySite(primaryHost(str(p.values.host)), json)
  if (sub === 'commit') { const sha = needArg(p, 0, 'sha'); return verifyCommit(repoCtx(p.values), sha, json) }
  throw new UsageError(sub ? `unknown subcommand "verify ${sub}"` : 'missing subcommand', 'Run `dit verify --help`.')
}
void Api; void apiFor
