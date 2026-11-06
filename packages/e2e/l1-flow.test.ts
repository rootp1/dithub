import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anchorRef, anchorRefBySignature, prepareRefAnchor } from '../sdk/src/l1.ts'

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const SECOND_ANVIL_KEY = '0x59c6995e998f97a5a0044976f7adf6fdaf33707e8db41f77a596f2d59866a045' as Hex
const processes: Bun.Subprocess[] = []

afterEach(() => {
  for (const process of processes.splice(0)) process.kill()
})

async function waitForRpc(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (response.ok) return
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error('Anvil did not start')
}

describe('L1 ref authority', () => {
  test('deploys RefRegistry and anchors a ref idempotently', async () => {
    const build = Bun.spawnSync(['forge', 'build', '--root', 'packages/contracts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString())
    const port = 18545 + Math.floor(Math.random() * 1000)
    const rpcUrl = `http://127.0.0.1:${port}`
    const anvil = Bun.spawn(['anvil', '--port', String(port), '--silent'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    processes.push(anvil)
    await waitForRpc(rpcUrl)

    const artifact = JSON.parse(
      readFileSync('packages/contracts/out/RefRegistry.sol/RefRegistry.json', 'utf8'),
    ) as { abi: unknown[]; bytecode: { object: Hex } }
    const chain = defineChain({
      id: 31337,
      name: 'Anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    })
    const account = privateKeyToAccount(ANVIL_KEY)
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
    const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account })
    const deployHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [account.address],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
    const registry = receipt.contractAddress as Address
    expect(registry).toBeTruthy()

    const planned = await prepareRefAnchor({
      rpcUrl,
      chainId: 31337,
      refRegistry: registry,
      refName: 'refs/heads/main',
      gitOid: 'ce013625030ba8dba906f756967f9e9ca394464a',
      manifestRoot: `0x${'11'.repeat(32)}`,
    })
    expect(planned.transaction.to).toBe(registry)
    expect(planned.expectedSequence).toBe(0n)

    const first = await anchorRef({
      rpcUrl,
      chainId: 31337,
      privateKey: ANVIL_KEY,
      refRegistry: registry,
      refName: 'refs/heads/main',
      gitOid: 'ce013625030ba8dba906f756967f9e9ca394464a',
      manifestRoot: `0x${'11'.repeat(32)}`,
    })
    expect(first.sequence).toBe(1n)
    expect(first.alreadyAnchored).toBe(false)

    const second = await anchorRef({
      rpcUrl,
      chainId: 31337,
      privateKey: ANVIL_KEY,
      refRegistry: registry,
      refName: 'refs/heads/main',
      gitOid: 'ce013625030ba8dba906f756967f9e9ca394464a',
      manifestRoot: `0x${'11'.repeat(32)}`,
    })
    expect(second.sequence).toBe(1n)
    expect(second.alreadyAnchored).toBe(true)

    const writer = privateKeyToAccount(SECOND_ANVIL_KEY)
    const writerRole = await publicClient.readContract({
      address: registry,
      abi: parseAbi(['function WRITER_ROLE() view returns (bytes32)']),
      functionName: 'WRITER_ROLE',
    })
    const roleHash = await walletClient.writeContract({
      address: registry,
      abi: parseAbi(['function setRole(bytes32 role, address account, bool enabled)']),
      functionName: 'setRole',
      args: [writerRole, writer.address, true],
    })
    await publicClient.waitForTransactionReceipt({ hash: roleHash })
    const signed = await anchorRefBySignature({
      rpcUrl,
      chainId: 31337,
      signerPrivateKey: SECOND_ANVIL_KEY,
      relayerPrivateKey: ANVIL_KEY,
      refRegistry: registry,
      refName: 'refs/heads/feature',
      gitOid: 'ce013625030ba8dba906f756967f9e9ca394464a',
      manifestRoot: `0x${'22'.repeat(32)}`,
    })
    expect(signed.sequence).toBe(2n)
    expect(signed.alreadyAnchored).toBe(false)
  }, 30_000)
})
