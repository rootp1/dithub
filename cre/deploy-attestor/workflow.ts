import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  type CronPayload,
  type HTTPPayload,
  type HTTPSendRequester,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbiParameters, zeroAddress } from 'viem'
import { z } from 'zod'
import { isSafeFileName, judge, sha256Hex, type Observation } from './verify'

export const configSchema = z.object({
  schedule: z.string(),
  siteUrl: z.string(),
  chainSelectorName: z.string(),
  registryAddress: z.string(),
  attestationsAddress: z.string(),
  gasLimit: z.string().default('1000000'),
  // Optional: EVM addresses allowed to call the HTTP trigger once deployed (CI signer). Not needed for simulation.
  httpAuthorizedAddresses: z.array(z.string()).default([]),
})
export type Config = z.infer<typeof configSchema>

const RegistryABI = [
  {
    type: 'function',
    name: 'latestRelease',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'commit', type: 'bytes32' },
      { name: 'bundleHash', type: 'bytes32' },
      { name: 'url', type: 'string' },
      { name: 'publishedAt', type: 'uint64' },
      { name: 'publisher', type: 'address' },
    ],
  },
] as const

const MAX_FILES = 16

// Runs on every node; each node fetches + hashes, then nodes reach consensus on the (small, string-only) observation.
const fetchAndHash = (sender: HTTPSendRequester, siteUrl: string): Observation => {
  try {
    return fetchAndHashInner(sender, siteUrl)
  } catch (e) {
    return { commit: '', claimedBundleHash: '', listed: [], computed: {}, claimed: {}, error: String((e as Error)?.message ?? e).slice(0, 200) }
  }
}

const fetchAndHashInner = (sender: HTTPSendRequester, siteUrl: string): Observation => {
  const base = siteUrl.replace(/\/+$/, '')
  const get = (path: string) => {
    const r = sender.sendRequest({ method: 'GET', url: `${base}/${path}` }).result()
    if (r.statusCode !== 200) throw new Error(`GET ${path} -> HTTP ${r.statusCode}`)
    return r.body
  }
  const bj = JSON.parse(Buffer.from(get('build.json')).toString('utf-8'))
  if (!bj || typeof bj.files !== 'object' || bj.files === null) throw new Error('build.json has no files map')
  const claimed: Record<string, string> = {}
  for (const [k, v] of Object.entries(bj.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    claimed[k] = String(v).toLowerCase()
  }
  const listed = Object.keys(claimed).sort()
  if (listed.length > MAX_FILES) throw new Error('build.json lists too many files')
  const computed: Record<string, string> = {}
  for (const name of listed) {
    if (!isSafeFileName(name)) throw new Error(`unsafe file name in build.json: ${name}`)
    computed[name] = sha256Hex(get(name))
  }
  return { commit: String(bj.commit ?? ''), claimedBundleHash: String(bj.bundleHash ?? '').toLowerCase(), listed, computed, claimed }
}

const attest = (runtime: Runtime<Config>, trigger: string): string => {
  const cfg = runtime.config
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`Network not found: ${cfg.chainSelectorName}`)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // (a) registry read
  const callData = encodeFunctionData({ abi: RegistryABI, functionName: 'latestRelease' })
  const res = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: cfg.registryAddress as Address, data: callData }),
      // Latest, not finalized: finality lags ~13 min, which would attest the previous release right after every deploy.
      // Safe because DeployAttestations re-checks commit/bundleHash against the registry when the report lands.
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result()
  const [id, commit, bundleHash, url, publishedAt, publisher] = decodeFunctionResult({
    abi: RegistryABI,
    functionName: 'latestRelease',
    data: bytesToHex(res.data),
  })
  if (id === 0n) throw new Error('DeployRegistry has no release yet')
  runtime.log(`[${trigger}] registry release #${id} commit=${commit} bundleHash=${bundleHash} url=${url} publishedAt=${publishedAt} publisher=${publisher}`)

  // (b)+(c) fetch the live site with consensus, hashing inside the workflow
  const http = new cre.capabilities.HTTPClient()
  const obs = http.sendRequest(runtime, fetchAndHash, consensusIdenticalAggregation<Observation>())(cfg.siteUrl).result()
  const v = judge(obs, { commit, bundleHash })
  runtime.log(`[${trigger}] live files=${JSON.stringify(obs.computed)} recomputed bundleHash=${v.recomputedBundleHash}`)
  runtime.log(
    `[${trigger}] ok=${v.ok} bundleMatchesRegistry=${v.bundleMatchesRegistry} filesMatchBuildJson=${v.filesMatchBuildJson} buildJsonSelfConsistent=${v.buildJsonSelfConsistent} commitMatches=${v.commitMatches} (build.json commit=${obs.commit})`,
  )
  for (const m of v.mismatches) runtime.log(`[${trigger}] MISMATCH: ${m}`)

  // (d)+(e) report. commit/bundleHash are the registry's values (the consumer checks them); ok carries the verdict.
  const observedAt = BigInt(Math.floor(runtime.now().getTime() / 1000))
  const report = encodeAbiParameters(
    parseAbiParameters('uint256 releaseId, bytes32 commit, bytes32 bundleHash, bool ok, uint64 observedAt'),
    [id, commit, bundleHash, v.ok, observedAt],
  )
  const signed = runtime.report(prepareReportRequest(report)).result()
  const w = evm
    .writeReport(runtime, { receiver: cfg.attestationsAddress, report: signed, gasConfig: { gasLimit: cfg.gasLimit } })
    .result()
  if (w.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed: ${w.errorMessage || w.txStatus}`)
  const tx = bytesToHex(w.txHash || new Uint8Array(32))
  runtime.log(`[${trigger}] attestation written: release=${id} ok=${v.ok} tx=${tx}`)
  return JSON.stringify({ releaseId: id.toString(), ok: v.ok, commitMatches: v.commitMatches, bundleHash: v.recomputedBundleHash, tx })
}

export const onCron = (runtime: Runtime<Config>, _p: CronPayload): string => attest(runtime, 'cron')
export const onHttp = (runtime: Runtime<Config>, _p: HTTPPayload): string => attest(runtime, 'http')

export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability()
  const http = new cre.capabilities.HTTPCapability()
  const authorizedKeys = config.httpAuthorizedAddresses.map((publicKey) => ({
    type: 'KEY_TYPE_ECDSA_EVM' as const,
    publicKey,
  }))
  return [
    cre.handler(http.trigger({ authorizedKeys }), onHttp),
    cre.handler(cron.trigger({ schedule: config.schedule }), onCron),
  ]
}
