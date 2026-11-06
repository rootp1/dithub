// The L1 this build anchors to. build.ts replaces process.env.DITHUB_NETWORK at bundle time (base | sepolia), so the
// "Verify this site" panel reads the chain without trusting the API. Unset (tests, dev) means Base mainnet.
import { NETWORKS, networkOf, type Network } from '../../../deployments/networks.ts'

export const NETWORK: Network = networkOf(process.env.DITHUB_NETWORK)
/** Explorer link for a tx on any known chain (old Sepolia anchors keep linking to Sepolia after the move to Base). */
export const explorerTxFor = (chainId: number | null | undefined, tx: string) => {
  const n = Object.values(NETWORKS).find((x) => x.chainId === chainId)
  return n ? `${n.explorer}/tx/${encodeURIComponent(tx)}` : '#'
}
