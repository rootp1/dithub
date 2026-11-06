// Single source of truth for which L1 Dithub anchors to. Dependency-free so the browser bundle and the dit binary can use it.
// Addresses come from deployments/<name>.json (written after `forge script ... Deploy.s.sol`); never hard-code them elsewhere.
import baseJson from './base.json'
import sepoliaJson from './sepolia.json'

export interface Network {
  name: 'base' | 'sepolia'
  label: string
  chainId: number
  rpcUrl: string
  explorer: string
  registry?: `0x${string}`
  attestations?: `0x${string}`
  refRegistry?: `0x${string}`
  startBlock: bigint
}

interface DeploymentFile { contracts?: Record<string, { address?: string; deployBlock?: number }> }
const addr = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined)
function withAddresses(n: Omit<Network, 'registry' | 'attestations' | 'refRegistry' | 'startBlock'>, d: DeploymentFile): Network {
  const c = d.contracts ?? {}
  const out: Network = { ...n, startBlock: BigInt(c.DeployRegistry?.deployBlock ?? 0) }
  const r = addr(c.DeployRegistry?.address), a = addr(c.DeployAttestations?.address), f = addr(c.RefRegistry?.address)
  if (r) out.registry = r
  if (a) out.attestations = a
  if (f) out.refRegistry = f
  return out
}

export const NETWORKS = {
  base: withAddresses({ name: 'base', label: 'Base', chainId: 8453, rpcUrl: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org' }, baseJson),
  sepolia: withAddresses({ name: 'sepolia', label: 'Sepolia', chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' }, sepoliaJson),
} as const satisfies Record<string, Network>

export const DEFAULT_NETWORK: Network = NETWORKS.sepolia

/** Look up by name or chain id. Unknown values throw so a typo never silently picks a live network. */
export function networkOf(v: string | number | undefined | null): Network {
  if (v === undefined || v === null || v === '') return DEFAULT_NETWORK
  const s = String(v).trim().toLowerCase()
  const n = Object.values(NETWORKS).find((x) => x.name === s || String(x.chainId) === s)
  if (!n) throw new Error(`unknown network "${v}" (expected sepolia or base)`)
  return n
}

/**
 * Namespace for per-chain state (Arkiv deployment history, block cursors). Release ids restart at 1 on every DeployRegistry, so on Sepolia,
 * where the registry is redeployed, the scope includes the registry address prefix; a new registry then starts a clean history.
 */
export const chainScoped = (n: Network, name: string) =>
  n.name === 'sepolia' ? `${name}:${(n.registry ?? '0x').slice(2, 10).toLowerCase() || 'none'}` : `${name}:${n.chainId}`

export const explorerTx = (n: Network, tx: string) => `${n.explorer}/tx/${encodeURIComponent(tx)}`
export const explorerAddress = (n: Network, a: string) => `${n.explorer}/address/${encodeURIComponent(a)}`
