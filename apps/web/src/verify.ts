// Pure, dependency-free helpers for the "Verify this site" panel (browser-native: crypto.subtle + fetch).
export const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
export const REGISTRY = '0x9caa2fEB7880Bb81b7A3C3324c22C3293c65655e'      // deployments/sepolia.json
export const ATTESTATIONS = '0x458d41E371141655c5b04618875aF22F83809BC9'
export const SEL_LATEST_RELEASE = '0x7be0ca5e'      // cast sig 'latestRelease()'
export const SEL_LATEST_ATTESTATION = '0x24b6d96a'  // cast sig 'latestAttestation()'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
}
/** Same as apps/web/build.ts: sha256 of JSON.stringify({name: '0x'+hash}) with keys sorted ascending. */
export async function bundleHashOf(files: Record<string, string>): Promise<string> {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]!
  return '0x' + (await sha256Hex(JSON.stringify(sorted)))
}

function words(data: string): string[] {
  const h = data.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 64 !== 0) throw new Error('malformed ABI data')
  return h.match(/.{64}/g) ?? []
}
const big = (w: string | undefined) => { if (w === undefined) throw new Error('ABI data too short'); return BigInt('0x' + w) }
const addrOf = (w: string | undefined) => { if (w === undefined) throw new Error('ABI data too short'); return '0x' + w.slice(24) }

export interface OnchainRelease { id: number; commit: string; bundleHash: string; url: string; publishedAt: number; publisher: string }
/** Decode (uint256 id, bytes32 commit, bytes32 bundleHash, string url, uint64 publishedAt, address publisher). */
export function decodeLatestRelease(data: string): OnchainRelease {
  const w = words(data)
  const off = Number(big(w[3])) / 32
  const len = Number(big(w[off]))
  const h = data.replace(/^0x/, '')
  const start = (off + 1) * 64
  if (len * 2 > h.length - start) throw new Error('ABI string out of range')
  const urlBytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) urlBytes[i] = parseInt(h.slice(start + i * 2, start + i * 2 + 2), 16)
  return { id: Number(big(w[0])), commit: '0x' + w[1], bundleHash: '0x' + w[2], url: new TextDecoder().decode(urlBytes), publishedAt: Number(big(w[4])), publisher: addrOf(w[5]) }
}
export interface OnchainAttestation { releaseId: number; ok: boolean; observedAt: number }
/** Decode (uint256 releaseId, bool ok, uint64 observedAt). */
export function decodeLatestAttestation(data: string): OnchainAttestation {
  const w = words(data)
  return { releaseId: Number(big(w[0])), ok: big(w[1]) === 1n, observedAt: Number(big(w[2])) }
}

export async function ethCall(to: string, data: string, f: typeof fetch = fetch, rpc = SEPOLIA_RPC): Promise<string> {
  const res = await f(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })
  const j = (await res.json()) as { result?: string; error?: { message?: string } }
  if (j.error || typeof j.result !== 'string') throw new Error(j.error?.message ?? 'RPC returned no result')
  return j.result
}

export interface Check { label: string; status: 'pass' | 'fail' | 'info'; detail: string }
export interface BuildJson { commit?: string; bundleHash?: string; files?: Record<string, string> }
/** Decide the checklist from already-fetched facts (pure; unit tested). */
export function evaluate(i: { build: BuildJson; actual: Record<string, string>; local: string; chain: OnchainRelease | null; chainErr?: string; api: { bundleHash: string | null } | null; att: OnchainAttestation | null }): Check[] {
  const c: Check[] = []
  const names = Object.keys(i.build.files ?? {}).sort()
  const bad = names.filter((n) => i.build.files![n]!.toLowerCase() !== i.actual[n]?.toLowerCase())
  c.push({ label: 'Served files match build.json', status: names.length && !bad.length ? 'pass' : 'fail', detail: bad.length ? `mismatch: ${bad.join(', ')}` : `${names.length} file(s) hashed in your browser` })
  c.push({ label: 'Recomputed bundleHash matches build.json', status: i.local === (i.build.bundleHash ?? '').toLowerCase() ? 'pass' : 'fail', detail: i.local })
  if (i.chain && i.chain.id > 0) c.push({ label: 'Bundle hash matches the on-chain release (Sepolia)', status: i.local === i.chain.bundleHash.toLowerCase() ? 'pass' : 'fail', detail: `release #${i.chain.id}, on-chain ${i.chain.bundleHash}` })
  else c.push({ label: 'Bundle hash matches the on-chain release (Sepolia)', status: 'fail', detail: i.chainErr ?? 'no release published on-chain' })
  if (i.api?.bundleHash) c.push({ label: 'API (Arkiv mirror) agrees with the chain', status: i.chain && i.api.bundleHash.toLowerCase() === i.chain.bundleHash.toLowerCase() ? 'pass' : 'fail', detail: i.api.bundleHash })
  else c.push({ label: 'API (Arkiv mirror) agrees with the chain', status: 'info', detail: 'API returned no deployment' })
  if (i.att && i.att.releaseId > 0) c.push({ label: 'On-chain attestation (DeployAttestations)', status: i.att.ok && i.chain && i.att.releaseId === i.chain.id ? 'pass' : i.att.ok ? 'info' : 'fail', detail: `release #${i.att.releaseId} ${i.att.ok ? 'ok' : 'MISMATCH'} observed ${new Date(i.att.observedAt * 1000).toISOString()}` })
  else c.push({ label: 'On-chain attestation (DeployAttestations)', status: 'info', detail: 'no attestation recorded yet' })
  return c
}
