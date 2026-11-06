// Deployment mirror: DeployRegistry/DeployAttestations logs -> Postgres `deployments` -> Arkiv (dheet-activity-v1, kinds 'deploy' / 'attest').
// Cursor-based (chain_cursors), bounded getLogs ranges, idempotent, exponential backoff, safe to restart at any point.
import type { SQL } from 'bun'
import { withArkivLock } from './arkiv-lock.ts'
import { createPublicClient, http, parseAbi, type Address, type Log } from 'viem'
import { recordActivity, sha256, type createArkivConnection } from '../../../packages/sdk/src/index.ts'
import { chainScoped, type Network } from '../../../deployments/networks.ts'

const registryEvent = parseAbi(['event ReleasePublished(uint256 indexed id, bytes32 indexed commit, bytes32 bundleHash, string url, address indexed publisher)'])
const attestedEvent = parseAbi(['event Attested(uint256 indexed releaseId, bytes32 indexed bundleHash, bool ok, uint64 observedAt)'])

const CHUNK = BigInt(process.env.DEPLOY_LOG_CHUNK ?? 2000)   // publicnode accepts ~2000 blocks; some free-tier RPCs allow only 10
const POLL_MS = Number(process.env.DEPLOY_POLL_MS ?? 30_000)
/** Arkiv "repo" that holds release history; one per chain because release ids restart at 1 on each. */
export const deploymentsRepoKey = (n: Network) => sha256(chainScoped(n, 'dheet:deployments'))

/** Env (DEPLOY_REGISTRY, DEPLOY_ATTESTATIONS, DEPLOY_START_BLOCK) wins; otherwise deployments/<network>.json (never hard-coded). */
function loadAddresses(n: Network) {
  return {
    registry: (process.env.DEPLOY_REGISTRY as Address | undefined) || n.registry,
    attestations: (process.env.DEPLOY_ATTESTATIONS as Address | undefined) || n.attestations,
    start: process.env.DEPLOY_START_BLOCK ? BigInt(process.env.DEPLOY_START_BLOCK) : n.startBlock,
  }
}

const hexBuf = (v: string) => Buffer.from(v.replace(/^0x/, ''), 'hex')

export function startDeploymentMirror(args: { sql: SQL; arkiv: ReturnType<typeof createArkivConnection>; relayer: `0x${string}`; network: Network; rpcUrl: string }) {
  const { sql, arkiv, relayer, network } = args
  const client = createPublicClient({ transport: http(args.rpcUrl) })
  const chainId = network.chainId
  const repoKey = deploymentsRepoKey(network)

  async function cursor(name: string, fallback: bigint) {
    const [row] = await sql`SELECT last_block FROM chain_cursors WHERE name = ${chainScoped(network, name)}`
    return row ? BigInt(row.last_block) + 1n : fallback
  }
  const saveCursor = (name: string, block: bigint) => sql`INSERT INTO chain_cursors (name, last_block) VALUES (${chainScoped(network, name)}, ${block.toString()})
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
    await sql`INSERT INTO deployments (chain_id, id, commit, bundle_hash, url, published_at, publisher, publish_tx)
      VALUES (${chainId}, ${id!.toString()}, ${hexBuf(commit!)}, ${hexBuf(bundleHash!)}, ${url!}, ${publishedAt}, ${hexBuf(publisher!)}, ${hexBuf(log.transactionHash!)})
      ON CONFLICT (chain_id, id) DO UPDATE SET commit = EXCLUDED.commit, bundle_hash = EXCLUDED.bundle_hash, url = EXCLUDED.url,
        published_at = EXCLUDED.published_at, publisher = EXCLUDED.publisher, publish_tx = EXCLUDED.publish_tx`
    const [row] = await sql`SELECT arkiv_entity FROM deployments WHERE chain_id = ${chainId} AND id = ${id!.toString()}`
    if (row?.arkiv_entity) return
    const r = await recordActivity(arkiv, {
      kind: 'deploy', repoId: repoKey, seq: Number(id), actor: relayer, ref: url!, commitOid: commit!, title: `release #${id} ${commit!.slice(-12)}`,
      l1ChainId: chainId, l1Tx: log.transactionHash!, manifestHash: bundleHash!,
      body: { releaseId: Number(id), commit, bundleHash, url, publisher, publishedAt: publishedAt.toISOString() },
    })
    await sql`UPDATE deployments SET arkiv_entity = ${hexBuf(r.entityKey)}, arkiv_tx = ${hexBuf(r.txHash)} WHERE chain_id = ${chainId} AND id = ${id!.toString()}`
    await track(r.entityKey, r.txHash, r.expiresAt)
    console.log(`deployments: release #${id} -> Arkiv ${r.entityKey}`)
  }

  async function handleAttest(log: Log<bigint, number, false, undefined, true, typeof attestedEvent, 'Attested'>) {
    const { releaseId, bundleHash, ok, observedAt } = log.args
    const [row] = await sql`SELECT attest_tx, encode(commit,'hex') AS commit FROM deployments WHERE chain_id = ${chainId} AND id = ${releaseId!.toString()}`
    if (!row) throw new Error(`attestation for unknown release #${releaseId} (registry not yet mirrored)`)
    if (row.attest_tx && Buffer.from(row.attest_tx).equals(hexBuf(log.transactionHash!))) return   // already mirrored
    const r = await recordActivity(arkiv, {
      kind: 'attest', repoId: repoKey, seq: Number(releaseId), actor: relayer, ref: ok ? 'ok' : 'mismatch', commitOid: `0x${row.commit}`,
      title: `attest #${releaseId} ${ok ? 'ok' : 'MISMATCH'}`, l1ChainId: chainId, l1Tx: log.transactionHash!, manifestHash: bundleHash!,
      body: { releaseId: Number(releaseId), bundleHash, ok, observedAt: Number(observedAt), logIndex: log.logIndex },
    })
    await sql`UPDATE deployments SET attested = true, attested_ok = ${ok!}, attested_at = ${new Date(Number(observedAt) * 1000)},
      attest_tx = ${hexBuf(log.transactionHash!)} WHERE chain_id = ${chainId} AND id = ${releaseId!.toString()}`
    await track(r.entityKey, r.txHash, r.expiresAt)
    console.log(`deployments: attestation #${releaseId} ok=${ok} -> Arkiv ${r.entityKey}`)
  }

  /**
   * Scan one contract from its cursor to head. Public RPCs sit behind load balancers whose backends disagree on the head by a few
   * blocks and many free tiers cap the getLogs range, so on a range/params error we shrink the window and pull the upper bound in.
   */
  async function scan(name: string, address: Address, start: bigint, head: bigint, run: (from: bigint, to: bigint) => Promise<void>) {
    let from = await cursor(name, start)
    let chunk = CHUNK
    let cap = head
    while (from <= cap) {
      const to = from + chunk - 1n > cap ? cap : from + chunk - 1n
      try {
        await run(from, to)
      } catch (error) {
        const msg = String((error as Error)?.message ?? error)
        if (/range|limit|beyond|exceed|invalid param|not a valid request|too many|query returned more/i.test(msg) && (chunk > 10n || cap > from)) {
          chunk = chunk > 10n ? chunk / 2n : chunk
          cap = to > from + 2n ? to - 2n : from
          continue
        }
        throw error
      }
      await saveCursor(name, to)       // advanced only after every log in the window was mirrored
      from = to + 1n
    }
    void address
  }

  async function cycle() {
    const { registry, attestations, start } = loadAddresses(network)
    if (!registry) { console.log('deployments: DeployRegistry address not configured yet; idle'); return }
    const head = (await client.getBlockNumber()) - 4n   // stay a few blocks behind: backends disagree on the head, and it keeps us clear of shallow reorgs
    await scan('deploy-registry', registry, start, head, async (fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: registry, event: registryEvent[0], fromBlock, toBlock, strict: true })
      for (const l of logs) await withArkivLock(() => handleRelease(l as never))
    })
    if (!attestations) return
    await scan('deploy-attestations', attestations, start, head, async (fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: attestations, event: attestedEvent[0], fromBlock, toBlock, strict: true })
      for (const l of logs) await withArkivLock(() => handleAttest(l as never))
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
