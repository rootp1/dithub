// Independent verifier: does the frontend served at SITE match the release recorded on-chain (and attested by CRE)?
// Usage: SITE=https://dithub.app bun scripts/verify-site.ts   (exit code 1 on any FAIL)
// Env: SITE, SEPOLIA_RPC_URL, REQUIRE_ATTESTATION=1 (treat a missing attestation as FAIL instead of WARN)
import { createHash } from 'node:crypto'
import { attestationsAbi, loadDeployAddresses, publicClient, registryAbi } from './deploy-lib.ts'

const SITE = (process.env.SITE ?? 'https://dithub.app').replace(/\/$/, '')
const sha256 = (b: Uint8Array) => `0x${createHash('sha256').update(b).digest('hex')}`
type Row = { check: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string }
const rows: Row[] = []
const add = (check: string, status: Row['status'], detail: string) => rows.push({ check, status, detail })
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

async function main() {
  const res = await fetch(`${SITE}/build.json`)
  if (!res.ok) { add('fetch /build.json', 'FAIL', `HTTP ${res.status}`); return }
  const text = await res.text()
  let build: { commit: string; bundleHash: string; files: Record<string, string> }
  try { build = JSON.parse(text) } catch { add('fetch /build.json', 'FAIL', 'response is not JSON (site not rebuilt with build.json?)'); return }
  add('fetch /build.json', 'PASS', `commit ${build.commit.slice(0, 12)}`)

  // 1. Re-hash every file the site actually serves.
  const actual: Record<string, string> = {}
  for (const name of Object.keys(build.files).sort()) {
    const r = await fetch(`${SITE}/${name}`)
    if (!r.ok) { add(`file ${name}`, 'FAIL', `HTTP ${r.status}`); continue }
    actual[name] = sha256(new Uint8Array(await r.arrayBuffer()))
    add(`file ${name}`, eq(actual[name]!, build.files[name]!) ? 'PASS' : 'FAIL', actual[name]!.slice(0, 18) + '...')
  }
  // 2. Recompute bundleHash exactly as apps/web/build.ts does: sha256(JSON.stringify(sorted name->hash map)).
  const recomputed = sha256(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(actual).sort().map((k) => [k, actual[k]])))))
  add('bundleHash recomputed', eq(recomputed, build.bundleHash) ? 'PASS' : 'FAIL', recomputed.slice(0, 18) + '...')

  // 3. Compare against the chain.
  const { registry, attestations } = loadDeployAddresses()
  if (!registry) { add('DeployRegistry address', 'FAIL', 'not found in deployments/sepolia.json'); return }
  const pc = publicClient()
  const [id, commit, bundleHash, url, publishedAt, publisher] = await pc.readContract({ address: registry, abi: registryAbi, functionName: 'latestRelease' })
  add('on-chain latestRelease', 'PASS', `#${id} by ${publisher} at ${new Date(Number(publishedAt) * 1000).toISOString()} (${url})`)
  add('bundleHash == on-chain', eq(bundleHash, recomputed) ? 'PASS' : 'FAIL', `chain ${bundleHash.slice(0, 18)}...`)
  const wantCommit = `0x${build.commit.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
  add('commit == on-chain', /^[0-9a-f]{40}$/i.test(build.commit.replace(/^0x/, '')) && eq(commit, wantCommit) ? 'PASS' : 'FAIL', `chain ${commit.slice(26, 38)}...`)

  if (!attestations) { add('DeployAttestations address', 'WARN', 'not found'); return }
  const [relId, ok, observedAt] = await pc.readContract({ address: attestations, abi: attestationsAbi, functionName: 'latestAttestation' })
  const att = await pc.readContract({ address: attestations, abi: attestationsAbi, functionName: 'attestation', args: [id] })
  if (!att[0]) add('CRE attestation for latest release', process.env.REQUIRE_ATTESTATION === '1' ? 'FAIL' : 'WARN', `none yet (latest attested release: #${relId})`)
  else add('CRE attestation for latest release', att[1] ? 'PASS' : 'FAIL', `ok=${att[1]} observed ${new Date(Number(att[2]) * 1000).toISOString()} count=${att[3]}`)
  void ok; void observedAt
}

await main().catch((e) => add('verifier error', 'FAIL', String(e).slice(0, 200)))
const w = Math.max(...rows.map((r) => r.check.length))
console.log(`Site: ${SITE}`)
for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.check.padEnd(w)}  ${r.detail}`)
const failed = rows.filter((r) => r.status === 'FAIL').length
console.log(failed ? `\nRESULT: FAIL (${failed})` : '\nRESULT: PASS')
process.exit(failed ? 1 : 0)
