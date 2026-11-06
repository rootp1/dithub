import { networkOf } from '../../../deployments/networks.ts'

const env = process.env
const network = networkOf(env.L1_NETWORK ?? env.L1_CHAIN_ID)
const root = new URL('../../..', import.meta.url).pathname

export const config = {
  port: Number(env.PORT ?? 3000),
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`,
  databasePath: env.DATABASE_PATH || `${root}.data/dithub.sqlite`,   // one SQLite file shared with the worker
  sessionSecret: env.SESSION_SECRET ?? '',                            // HMAC key for stateless session tokens
  deviceKey: env.DITHUB_DEVICE_KEY ?? '',                             // hex X25519 private key of the server member
  reposDir: env.REPOS_DIR ?? `${root}.data/repos`,
  internalToken: env.INTERNAL_TOKEN ?? '',
  webDir: env.WEB_DIR ?? `${root}apps/web/dist`,
  hooksDir: env.HOOKS_DIR ?? `${root}apps/git/hooks`,
  l1: {
    network,
    rpcUrl: env.L1_RPC_URL ?? network.rpcUrl,
    chainId: network.chainId,
  },
  cookieSecure: env.COOKIE_SECURE === '1',
}

export function requireConfig(): void {
  if (config.internalToken.length < 24) throw new Error('INTERNAL_TOKEN (>= 24 chars) is required')
  if (env.NODE_ENV === 'production' && Buffer.byteLength(config.sessionSecret) < 32) throw new Error('SESSION_SECRET (>= 32 bytes) is required in production')
  if (config.deviceKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(config.deviceKey)) throw new Error('DITHUB_DEVICE_KEY must be 32 bytes of hex')
}
