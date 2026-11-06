export const VERSION = '0.1.0'
export const DEFAULT_HOST = 'https://dithub.app'

import { NETWORKS, networkOf, type Network } from '../../../deployments/networks.ts'

/** The chain `dit verify` / `dit rebuild` read: DIT_NETWORK (base | sepolia), default Base mainnet. Read per call so tests can switch. */
export const l1 = (): Network => networkOf(process.env.DIT_NETWORK)
/** DIT_RPC_URL only overrides the selected network; other chains (an old Sepolia anchor) use their public RPC. */
export const rpcUrlFor = (n: Network = l1()) => (n.chainId === l1().chainId && process.env.DIT_RPC_URL) || n.rpcUrl
export const networkByChainId = (id: number | null | undefined) => Object.values(NETWORKS).find((n) => n.chainId === id)
export const needRegistry = (n: Network = l1()) => {
  if (!n.registry) throw new Error(`no DeployRegistry on ${n.label} yet (deployments/${n.name}.json is empty)`)
  return n.registry
}

export const SEL = {
  selLatestRelease: '0x7be0ca5e',      // latestRelease()
  selLatestAttestation: '0x24b6d96a',  // latestAttestation()
  selGetRelease: '0x79af2b9a',         // getRelease(uint256)
  selReleaseCount: '0xb8d08db2',       // releaseCount()
} as const

export const EXIT = { ok: 0, error: 1, usage: 2 } as const

export const SOURCE_REPO = 'https://github.com/rootp1/dithub.git'
