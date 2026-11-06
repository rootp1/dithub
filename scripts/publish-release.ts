// Publish the current web build (apps/web/dist/build.json) to DeployRegistry on Sepolia. Idempotent.
// Env: DHEET_DEPLOYER_KEY (required), SEPOLIA_RPC_URL (optional), GIT_COMMIT (optional), SITE_URL (default production URL),
//      BUILD_FROM_SITE=1 (use ${SITE_URL}/build.json instead of the local file), DRY_RUN=1 to stop before sending.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { RPC_URL, ROOT, gitCommitToBytes32, loadDeployAddresses, publicClient, registryAbi } from './deploy-lib.ts'

const SITE_URL = process.env.SITE_URL ?? 'https://dithub.app'
const buildFile = process.env.BUILD_JSON ?? resolve(ROOT, 'apps/web/dist/build.json')
// BUILD_FROM_SITE=1: publish the build.json the deployed server actually serves (the Docker build is the artefact users get).
const build = (process.env.BUILD_FROM_SITE === '1'
  ? await (await fetch(`${SITE_URL}/build.json`)).json()
  : JSON.parse(readFileSync(buildFile, 'utf8'))) as { commit: string; bundleHash: `0x${string}` }
const sha = process.env.GIT_COMMIT || (build.commit !== 'dev' ? build.commit : Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim())
const commit = gitCommitToBytes32(sha)
const { registry } = loadDeployAddresses()
if (!registry) throw new Error('DeployRegistry address not found (deployments/sepolia.json or DEPLOY_REGISTRY)')

const pc = publicClient()
const count = await pc.readContract({ address: registry, abi: registryAbi, functionName: 'releaseCount' })
if (count > 0n) {
  const latest = await pc.readContract({ address: registry, abi: registryAbi, functionName: 'latestRelease' })
  // A release is (commit, bundleHash): the same bundle shipped from a new commit is a new release.
  if (latest[2].toLowerCase() === build.bundleHash.toLowerCase() && latest[1].toLowerCase() === commit.toLowerCase()) {
    console.log(`skip: release #${latest[0]} already has commit ${commit} and bundleHash ${build.bundleHash}`)
    process.exit(0)
  }
}
console.log(`publishing commit ${commit} bundleHash ${build.bundleHash} url ${SITE_URL} to ${registry}`)
if (process.env.DRY_RUN === '1') process.exit(0)

const pk = process.env.DHEET_DEPLOYER_KEY as `0x${string}` | undefined
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('DHEET_DEPLOYER_KEY is required')
const account = privateKeyToAccount(pk)
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) })
const { request, result } = await pc.simulateContract({ address: registry, abi: registryAbi, functionName: 'publish', args: [commit, build.bundleHash, SITE_URL], account })
const hash = await wallet.writeContract(request)
const receipt = await pc.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error(`publish reverted: ${hash}`)
console.log(`tx ${hash}`)
console.log(`release id ${result}`)
