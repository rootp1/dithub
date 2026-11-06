import { networkOf } from '../../../deployments/networks.ts'

const env = process.env
const network = networkOf(env.L1_NETWORK ?? env.L1_CHAIN_ID)
const root = new URL('../../..', import.meta.url).pathname

export const config = {
  port: Number(env.PORT ?? 3000),
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`,
  databaseUrl: env.DATABASE_URL ?? '',
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
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
  if (config.internalToken.length < 24) throw new Error('INTERNAL_TOKEN (>= 24 chars) is required')
}
