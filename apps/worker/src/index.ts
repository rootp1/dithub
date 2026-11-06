import { mkdirSync } from 'node:fs'
import { withArkivLock } from './arkiv-lock.ts'
import {
  LocalNetworkStore, anchorRef, claimName, createArkivConnection, createSwarmClient, publishDeviceKey, publishGrant, recordActivity,
  renewArkivEntities, swarmConfigFromEnv, uploadManifestToArkiv,
} from '../../../packages/sdk/src/index.ts'
import { openDb } from '../../../packages/db/src/index.ts'
import { startDeploymentMirror } from './deployments.ts'
import { createWorker, renewal, requeueStale, tick, type WorkerArkiv } from './jobs.ts'
import { networkOf } from '../../../deployments/networks.ts'

const env = process.env
const sql = openDb()   // DATABASE_PATH, the same file the API uses
const REPOS_DIR = env.REPOS_DIR ?? `${process.cwd()}/.data/repos`
const WORK_DIR = env.WORKER_DIR ?? `${process.cwd()}/.data/worker`
const NETWORK = networkOf(env.L1_NETWORK ?? env.L1_CHAIN_ID)
const L1_RPC = env.L1_RPC_URL ?? NETWORK.rpcUrl
const L1_CHAIN = NETWORK.chainId
{ // a stale L1_RPC_URL (e.g. Sepolia's) next to L1_NETWORK=base would sign for one chain and send to another
  const res = await fetch(L1_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(15_000) })
  const rpcChain = Number(((await res.json()) as { result?: string }).result)
  if (rpcChain !== L1_CHAIN) throw new Error(`L1_RPC_URL serves chain ${rpcChain}, but L1 network is ${NETWORK.label} (${L1_CHAIN}); fix infra/prod.env`)
}

const key = env.DHEET_PRIVATE_KEY as `0x${string}` | undefined
if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('DHEET_PRIVATE_KEY (relayer) is required')
const deviceKey = (env.DITHUB_DEVICE_KEY ?? '').replace(/^0x/i, '').toLowerCase()
if (deviceKey && !/^[0-9a-f]{64}$/i.test(deviceKey)) throw new Error('DITHUB_DEVICE_KEY must be 32 bytes of hex')
const conn = createArkivConnection({ privateKey: key, accessKey: env.ARKIV_ACCESS_KEY ?? '' })
mkdirSync(WORK_DIR, { recursive: true })
const store = new LocalNetworkStore(`${WORK_DIR}/network`)

const swarmConfig = swarmConfigFromEnv()
// Uploads need a postage batch. Without one the worker skips Swarm entirely: Swarm runs before Arkiv, so a node that cannot
// store anything (unfunded, no batch) would otherwise block every push from reaching Arkiv.
const swarm = swarmConfig?.postageBatchId ? createSwarmClient(swarmConfig) : null
if (swarm) console.log(`swarm: ${swarmConfig!.beeUrl} (${await swarm.health().catch(() => false) ? 'healthy' : 'not reachable yet'})`)
else if (swarmConfig) console.log('swarm: BEE_POSTAGE_BATCH_ID not set, uploads off (code still goes to Arkiv)')

const arkiv: WorkerArkiv = {
  relayer: conn.account.address,
  recordActivity: (input) => recordActivity(conn, input),
  claimName: (name, repoId) => claimName(conn, name, repoId),
  uploadManifest: (a) => uploadManifestToArkiv({ ...a, localStore: store, connection: conn }),
  publishDeviceKey: (input) => publishDeviceKey(conn, input),
  publishGrant: (grant) => publishGrant(conn, grant),
  head: () => conn.publicClient.getBlockNumber(),
  renew: (entityKeys) => renewArkivEntities({ entityKeys, connection: conn }),
}

const worker = createWorker({
  sql, arkiv, store, reposDir: REPOS_DIR, l1ChainId: L1_CHAIN,
  defaultRegistry: (env.REF_REGISTRY as `0x${string}` | undefined) || NETWORK.refRegistry,
  anchor: (a) => anchorRef({ ...a, rpcUrl: L1_RPC, chainId: L1_CHAIN, privateKey: key, force: true }),
  publishCode: env.ARKIV_PUBLISH_CODE !== '0',
  codeMaxBytes: Number(env.ARKIV_CODE_MAX_BYTES ?? 2_000_000),
  swarmMaxBytes: Number(env.SWARM_MAX_BYTES ?? 500_000_000),
  maxCommits: Number(env.MAX_COMMITS_PER_PUSH ?? 50),
  swarm, swarmPin: env.BEE_PIN === '1',
  deviceKey,
  privateIdSecret: deviceKey ? `0x${deviceKey}` : '',   // same secret as apps/api/src/keys.ts arkivRepoId()
})

console.log(`dithub worker started, relayer ${arkiv.relayer}`)
await requeueStale(sql)   // crash recovery
startDeploymentMirror({ sql, arkiv: conn, relayer: arkiv.relayer, network: NETWORK, rpcUrl: L1_RPC })   // DeployRegistry/Attestations -> SQLite + Arkiv (own loop)
let lastRenewal = 0
for (;;) {
  const worked = await tick(sql, worker.handlers, withArkivLock).catch((e) => { console.error('tick error', e); return false })
  if (Date.now() - lastRenewal > 3_600_000) { lastRenewal = Date.now(); await renewal(sql, arkiv, withArkivLock).catch((e) => console.error('renewal error', e)) }
  if (!worked) await Bun.sleep(2000)
}
