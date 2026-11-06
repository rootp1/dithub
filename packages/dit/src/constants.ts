export const VERSION = '0.1.0'
export const DEFAULT_HOST = 'https://172-105-43-184.sslip.io'

/** Sepolia contracts (kept in step with deployments/sepolia.json; a unit test checks it). */
export const SEPOLIA = {
  chainId: 11155111,
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  registry: '0x9caa2fEB7880Bb81b7A3C3324c22C3293c65655e',
  attestations: '0x458d41E371141655c5b04618875aF22F83809BC9',
  selLatestRelease: '0x7be0ca5e',      // latestRelease()
  selLatestAttestation: '0x24b6d96a',  // latestAttestation()
} as const

export const EXIT = { ok: 0, error: 1, usage: 2 } as const
