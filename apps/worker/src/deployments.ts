// Deployment mirror: Sepolia DeployRegistry/DeployAttestations logs -> Postgres `deployments` -> Arkiv (dheet-activity-v1, kinds 'deploy' / 'attest').
// Cursor-based (chain_cursors), bounded getLogs ranges, idempotent, exponential backoff, safe to restart at any point.
import type { SQL } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, http, parseAbi, type Address, type Log } from 'viem'
import { sepolia } from 'viem/chains'
import { recordActivity, sha256, type createArkivConnection } from '../../../packages/sdk/src/index.ts'

const registryEvent = parseAbi(['event ReleasePublished(uint256 indexed id, bytes32 indexed commit, bytes32 bundleHash, string url, address indexed publisher)'])
const attestedEvent = parseAbi(['event Attested(uint256 indexed releaseId, bytes32 indexed bundleHash, bool ok, uint64 observedAt)'])

const CHUNK = BigInt(process.env.DEPLOY_LOG_CHUNK ?? 2000)   // publicnode accepts ~2000 blocks; some free-tier RPCs allow only 10
const POLL_MS = Number(process.env.DEPLOY_POLL_MS ?? 30_000)
export const DEPLOYMENTS_REPO_KEY = sha256('dheet:deployments')

type Json = Record<string, unknown>
const find = (obj: unknown, name: string, depth = 0): unknown => {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined
  for (const [k, v] of Object.entries(obj as Json)) if (k.toLowerCase() === name.toLowerCase()) return v
  for (const v of Object.values(obj as Json)) { const r = find(v, name, depth + 1); if (r !== undefined) return r }
  return undefined
}
const addrOf = (v: unknown): Address | undefined => {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return v as Address
  if (v && typeof v === 'object') for (const k of ['address', 'addr']) { const a = addrOf((v as Json)[k]); if (a) return a }
  return undefined
}
const numOf = (v: unknown): bigint | undefined => {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) return BigInt(v)
  if (v && typeof v === 'object') for (const k of ['deployBlock', 'blockNumber', 'block']) { const n = numOf((v as Json)[k]); if (n !== undefined) return n }
  return undefined
}

/** Env (DEPLOY_REGISTRY, DEPLOY_ATTESTATIONS, DEPLOY_START_BLOCK) wins; otherwise deployments/sepolia.json (never hard-coded). */
function loadAddresses() {
  const file = process.env.DEPLOYMENTS_FILE ?? resolve(import.meta.dir, '../../../deployments/sepolia.json')
  const json: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const reg = find(json, 'DeployRegistry'), att = find(json, 'DeployAttestations')
  return {
    registry: (process.env.DEPLOY_REGISTRY as Address | undefined) ?? addrOf(reg),
    attestations: (process.env.DEPLOY_ATTESTATIONS as Address | undefined) ?? addrOf(att),
    start: process.env.DEPLOY_START_BLOCK ? BigInt(process.env.DEPLOY_START_BLOCK) : numOf(reg) ?? numOf(find(json, 'deployBlock')) ?? numOf(find(json, 'startBlock')) ?? 0n,
  }
}

const hexBuf = (v: string) => Buffer.from(v.replace(/^0x/, ''), 'hex')

export function startDeploymentMirror(args: { sql: SQL; arkiv: ReturnType<typeof createArkivConnection>; relayer: `0x${string}` }) {
  const { sql, arkiv, relayer } = args
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') })
  const chainId = sepolia.id

  async function cursor(name: string, fallback: bigint) {
    const [row] = await sql`SELECT last_block FROM chain_cursors WHERE name = ${name}`
    return row ? BigInt(row.last_block) + 1n : fallback
  }
  const saveCursor = (name: string, block: bigint) => sql`INSERT INTO chain_cursors (name, last_block) VALUES (${name}, ${block.toString()})
    ON CONFLICT (name) DO UPDATE SET last_block = GREATEST(chain_cursors.last_block, EXCLUDED.last_block)`
  const track = (entityKey: string, txHash: string, expiresAt: bigint) => sql`INSERT INTO arkiv_entities (entity_key, schema, repo_id, outbox_id, tx_hash, expires_at_block)
    VALUES (${hexBuf(entityKey)}, 'dheet-activity-v1', NULL, NULL, ${hexBuf(txHash)}, ${expiresAt.toString()}) ON CONFLICT (entity_key) DO NOTHING`

  const blockTime = new Map<bigint, Date>()
  async function tsOf(block: bigint) {
    let t = blockTime.get(block)
    if (!t) { t = new Date(Number((await client.getBlock({ blockNumber: block })).timestamp) * 1000); blockTime.set(block, t); if (blockTime.size > 500) blockTime.clear() }
    return t
  }

  async function handleRelease(log: Log<bigint, number, false, undefined, true, typeof registryEvent, 'ReleasePublished'>) {
    const { id, commit, bundleHash, url, publisher } = log.args
    const publishedAt = await tsOf(log.blockNumber!)
    await sql`INSERT INTO deployments (id, commit, bundle_hash, url, published_at, publisher, publish_tx)
      VALUES (${id!.toString()}, ${hexBuf(commit!)}, ${hexBuf(bundleHash!)}, ${url!}, ${publishedAt}, ${hexBuf(publisher!)}, ${hexBuf(log.transactionHash!)})
      ON CONFLICT (id) DO UPDATE SET commit = EXCLUDED.commit, bundle_hash = EXCLUDED.bundle_hash, url = EXCLUDED.url,
        published_at = EXCLUDED.published_at, publisher = EXCLUDED.publisher, publish_tx = EXCLUDED.publish_tx`
    const [row] = await sql`SELECT arkiv_entity FROM deployments WHERE id = ${id!.toString()}`
    if (row?.arkiv_entity) return
    const r = await recordActivity(arkiv, {
      kind: 'deploy', repoId: DEPLOYMENTS_REPO_KEY, seq: Number(id), actor: relayer, ref: url!, commitOid: commit!, title: `release #${id} ${commit!.slice(-12)}`,
      l1ChainId: chainId, l1Tx: log.transactionHash!, manifestHash: bundleHash!,
      body: { releaseId: Number(id), commit, bundleHash, url, publisher, publishedAt: publishedAt.toISOString() },
    })
    await sql`UPDATE deployments SET arkiv_entity = ${hexBuf(r.entityKey)}, arkiv_tx = ${hexBuf(r.txHash)} WHERE id = ${id!.toString()}`
    await track(r.entityKey, r.txHash, r.expiresAt)
    console.log(`deployments: release #${id} -> Arkiv ${r.entityKey}`)
  }

  async function handleAttest(log: Log<bigint, number, false, undefined, true, typeof attestedEvent, 'Attested'>) {
    const { releaseId, bundleHash, ok, observedAt } = log.args
    const [row] = await sql`SELECT attest_tx, encode(commit,'hex') AS commit FROM deployments WHERE id = ${releaseId!.toString()}`
    if (!row) throw new Error(`attestation for unknown release #${releaseId} (registry not yet mirrored)`)
    if (row.attest_tx && Buffer.from(row.attest_tx).equals(hexBuf(log.transactionHash!))) return   // already mirrored
    const r = await recordActivity(arkiv, {
      kind: 'attest', repoId: DEPLOYMENTS_REPO_KEY, seq: Number(releaseId), actor: relayer, ref: ok ? 'ok' : 'mismatch', commitOid: `0x${row.commit}`,
      title: `attest #${releaseId} ${ok ? 'ok' : 'MISMATCH'}`, l1ChainId: chainId, l1Tx: log.transactionHash!, manifestHash: bundleHash!,
      body: { releaseId: Number(releaseId), bundleHash, ok, observedAt: Number(observedAt), logIndex: log.logIndex },
    })
    await sql`UPDATE deployments SET attested = true, attested_ok = ${ok!}, attested_at = ${new Date(Number(observedAt) * 1000)},
      attest_tx = ${hexBuf(log.transactionHash!)} WHERE id = ${releaseId!.toString()}`
    await track(r.entityKey, r.txHash, r.expiresAt)
    console.log(`deployments: attestation #${releaseId} ok=${ok} -> Arkiv ${r.entityKey}`)
  }

  /** Scan one contract from its cursor to head in <=2000-block windows. Returns true if it reached head. */
  async function scan(name: string, address: Address, start: bigint, head: bigint, run: (from: bigint, to: bigint) => Promise<void>) {
    let from = await cursor(name, start)
    while (from <= head) {
      const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n
      await run(from, to)
      await saveCursor(name, to)       // advanced only after every log in the window was mirrored
      from = to + 1n
    }
    void address
  }

  async function cycle() {
    const { registry, attestations, start } = loadAddresses()
    if (!registry) { console.log('deployments: DeployRegistry address not configured yet; idle'); return }
    const head = await client.getBlockNumber()
    await scan('deploy-registry', registry, start, head, async (fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: registry, event: registryEvent[0], fromBlock, toBlock, strict: true })
      for (const l of logs) await handleRelease(l as never)
    })
    if (!attestations) return
    await scan('deploy-attestations', attestations, start, head, async (fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: attestations, event: attestedEvent[0], fromBlock, toBlock, strict: true })
      for (const l of logs) await handleAttest(l as never)
    })
  }

  void (async () => {
    let failures = 0
    console.log('deployments mirror started')
    for (;;) {
      try { await cycle(); failures = 0; await Bun.sleep(POLL_MS) }
      catch (e) {
        failures++
        const delay = Math.min(300_000, 2 ** Math.min(failures, 8) * 1000)
        const msg = ((e as { shortMessage?: string }).shortMessage ?? String(e)).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)   // RPC URLs may embed API keys
        console.error(`deployments mirror error (retry in ${delay / 1000}s): ${msg}`)
        await Bun.sleep(delay)
      }
    }
  })()
}
