// Shared helpers for publish-release.ts and verify-site.ts: contract ABIs, address resolution, chain client.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { base, sepolia } from 'viem/chains'
import { networkOf } from '../deployments/networks.ts'

export const ROOT = resolve(import.meta.dir, '..')
/** L1_NETWORK (base | sepolia) or L1_CHAIN_ID picks the chain; Base mainnet when neither is set. */
export const NETWORK = networkOf(process.env.L1_NETWORK ?? process.env.L1_CHAIN_ID)
export const CHAIN = NETWORK.name === 'base' ? base : sepolia
export const RPC_URL = process.env.L1_RPC_URL || (NETWORK.name === 'sepolia' && process.env.SEPOLIA_RPC_URL) || NETWORK.rpcUrl

export const registryAbi = parseAbi([
  'function publish(bytes32 commit, bytes32 bundleHash, string url) returns (uint256 id)',
  'function latestRelease() view returns (uint256 id, bytes32 commit, bytes32 bundleHash, string url, uint64 publishedAt, address publisher)',
  'function releaseCount() view returns (uint256)',
  'event ReleasePublished(uint256 indexed id, bytes32 indexed commit, bytes32 bundleHash, string url, address indexed publisher)',
])
export const attestationsAbi = parseAbi([
  'event Attested(uint256 indexed releaseId, bytes32 indexed bundleHash, bool ok, uint64 observedAt)',
  'function attestation(uint256 releaseId) view returns (bool exists, bool ok, uint64 observedAt, uint256 count)',
  'function latestAttestation() view returns (uint256 releaseId, bool ok, uint64 observedAt)',
])

type Json = Record<string, unknown>
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
/** Find a key anywhere in the (possibly nested) JSON, case-insensitively. */
function find(obj: unknown, name: string, depth = 0): unknown {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined
  for (const [k, v] of Object.entries(obj as Json)) if (k.toLowerCase() === name.toLowerCase()) return v
  for (const v of Object.values(obj as Json)) { const r = find(v, name, depth + 1); if (r !== undefined) return r }
  return undefined
}

export interface DeployAddresses { registry?: Address; attestations?: Address; startBlock: bigint; chainId: number }
/** Env overrides (DEPLOY_REGISTRY, DEPLOY_ATTESTATIONS, DEPLOY_START_BLOCK) win; otherwise deployments/<network>.json. Never hard-coded. */
export function loadDeployAddresses(file = process.env.DEPLOYMENTS_FILE ?? resolve(ROOT, `deployments/${NETWORK.name}.json`)): DeployAddresses {
  const json: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const reg = find(json, 'DeployRegistry'), att = find(json, 'DeployAttestations')
  const start = process.env.DEPLOY_START_BLOCK
    ? BigInt(process.env.DEPLOY_START_BLOCK)
    : numOf(reg) ?? numOf(find(json, 'deployBlock')) ?? numOf(find(json, 'startBlock')) ?? 0n
  const result: DeployAddresses = { startBlock: start, chainId: Number(find(json, 'chainId') ?? NETWORK.chainId) }
  const r = (process.env.DEPLOY_REGISTRY as Address | undefined) ?? addrOf(reg)
  const a = (process.env.DEPLOY_ATTESTATIONS as Address | undefined) ?? addrOf(att)
  if (r) result.registry = r
  if (a) result.attestations = a
  return result
}

export const publicClient = () => createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })

export const gitCommitToBytes32 = (sha: string): `0x${string}` => {
  const clean = sha.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(clean) && !/^[0-9a-f]{1,64}$/.test(clean)) throw new Error('commit must be hex (git sha1)')
  return `0x${clean.padStart(64, '0')}`
}
