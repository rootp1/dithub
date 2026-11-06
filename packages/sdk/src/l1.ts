import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex as ViemHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { toBytes32GitOid } from './hash.ts'
import type { Hex } from './types.ts'

export const refRegistryAbi = parseAbi([
  'function state(bytes32 refKey) view returns ((bytes32 oid, bytes32 manifestRoot, uint64 sequence, uint32 flags))',
  'function updateRef(bytes32 refKey, bytes32 expectedOld, bytes32 newOid, bytes32 manifestRoot, uint64 expectedSequence, uint32 flags) returns (uint64 newSequence, bytes32 newRefRoot)',
  'function refRoot() view returns (bytes32)',
  'function nonces(address signer) view returns (uint256)',
  'function updateRefBySig((bytes32 refKey, bytes32 expectedOld, bytes32 newOid, bytes32 manifestRoot, uint64 expectedSequence, uint32 flags, uint256 nonce, uint64 deadline) request, address signer, bytes signature) returns (uint64 newSequence, bytes32 newRefRoot)',
  'event RefUpdated(bytes32 indexed refKey, bytes32 indexed oldOid, bytes32 indexed newOid, bytes32 manifestRoot, uint64 sequence, uint32 flags, address writer, bytes32 refRoot)',
])

export interface RefAnchorResult {
  transactionHash: ViemHex | null
  sequence: bigint
  refRoot: ViemHex
  oid: ViemHex
  alreadyAnchored: boolean
}

export interface UnsignedTransaction {
  to: Address
  data: ViemHex
  value: bigint
  chainId: number
}

const refUpdateTypes = {
  RefUpdate: [
    { name: 'refKey', type: 'bytes32' },
    { name: 'expectedOld', type: 'bytes32' },
    { name: 'newOid', type: 'bytes32' },
    { name: 'manifestRoot', type: 'bytes32' },
    { name: 'expectedSequence', type: 'uint64' },
    { name: 'flags', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export async function prepareRefAnchor(args: {
  rpcUrl: string
  chainId: number
  refRegistry: Address
  refName: string
  gitOid: string
  manifestRoot: Hex
  force?: boolean
}): Promise<{ transaction: UnsignedTransaction; expectedSequence: bigint; expectedOld: ViemHex }> {
  const chain = defineChain({
    id: args.chainId,
    name: `Dithub L1 ${args.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [args.rpcUrl] } },
  })
  const publicClient = createPublicClient({ chain, transport: http(args.rpcUrl) })
  const refKey = keccak256(stringToHex(args.refName))
  const current = await publicClient.readContract({
    address: args.refRegistry,
    abi: refRegistryAbi,
    functionName: 'state',
    args: [refKey],
  })
  return {
    transaction: {
      to: args.refRegistry,
      chainId: args.chainId,
      value: 0n,
      data: encodeFunctionData({
        abi: refRegistryAbi,
        functionName: 'updateRef',
        args: [
          refKey,
          current.oid,
          toBytes32GitOid(args.gitOid) as ViemHex,
          args.manifestRoot as ViemHex,
          current.sequence,
          args.force ? 1 : 0,
        ],
      }),
    },
    expectedSequence: current.sequence,
    expectedOld: current.oid,
  }
}

export async function anchorRef(args: {
  rpcUrl: string
  chainId: number
  privateKey: ViemHex
  refRegistry: Address
  refName: string
  gitOid: string
  manifestRoot: Hex
  force?: boolean
}): Promise<RefAnchorResult> {
  const chain = defineChain({
    id: args.chainId,
    name: `Dithub L1 ${args.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [args.rpcUrl] } },
  })
  const account = privateKeyToAccount(args.privateKey)
  const transport = http(args.rpcUrl)
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ chain, transport, account })
  const refKey = keccak256(stringToHex(args.refName))
  const newOid = toBytes32GitOid(args.gitOid) as ViemHex
  const current = await publicClient.readContract({
    address: args.refRegistry,
    abi: refRegistryAbi,
    functionName: 'state',
    args: [refKey],
  })
  if (current.oid.toLowerCase() === newOid.toLowerCase() && current.manifestRoot === args.manifestRoot) {
    return {
      transactionHash: null,
      sequence: current.sequence,
      refRoot: await publicClient.readContract({
        address: args.refRegistry,
        abi: refRegistryAbi,
        functionName: 'refRoot',
      }),
      oid: current.oid,
      alreadyAnchored: true,
    }
  }
  const hash = await walletClient.writeContract({
    address: args.refRegistry,
    abi: refRegistryAbi,
    functionName: 'updateRef',
    args: [
      refKey,
      current.oid,
      newOid,
      args.manifestRoot as ViemHex,
      current.sequence,
      args.force ? 1 : 0,
    ],
  })
  await publicClient.waitForTransactionReceipt({ hash })
  const updated = await publicClient.readContract({
    address: args.refRegistry,
    abi: refRegistryAbi,
    functionName: 'state',
    args: [refKey],
  })
  return {
    transactionHash: hash,
    sequence: updated.sequence,
    refRoot: await publicClient.readContract({
      address: args.refRegistry,
      abi: refRegistryAbi,
      functionName: 'refRoot',
    }),
    oid: updated.oid,
    alreadyAnchored: false,
  }
}

export async function anchorRefBySignature(args: {
  rpcUrl: string
  chainId: number
  signerPrivateKey: ViemHex
  relayerPrivateKey: ViemHex
  refRegistry: Address
  refName: string
  gitOid: string
  manifestRoot: Hex
  deadline?: bigint
  force?: boolean
}): Promise<RefAnchorResult> {
  const chain = defineChain({
    id: args.chainId,
    name: `Dithub L1 ${args.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [args.rpcUrl] } },
  })
  const signer = privateKeyToAccount(args.signerPrivateKey)
  const relayer = privateKeyToAccount(args.relayerPrivateKey)
  const transport = http(args.rpcUrl)
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ chain, transport, account: relayer })
  const refKey = keccak256(stringToHex(args.refName))
  const newOid = toBytes32GitOid(args.gitOid) as ViemHex
  const [current, nonce] = await Promise.all([
    publicClient.readContract({
      address: args.refRegistry,
      abi: refRegistryAbi,
      functionName: 'state',
      args: [refKey],
    }),
    publicClient.readContract({
      address: args.refRegistry,
      abi: refRegistryAbi,
      functionName: 'nonces',
      args: [signer.address],
    }),
  ])
  const request = {
    refKey,
    expectedOld: current.oid,
    newOid,
    manifestRoot: args.manifestRoot as ViemHex,
    expectedSequence: current.sequence,
    flags: args.force ? 1 : 0,
    nonce,
    deadline: args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
  } as const
  const signature = await signer.signTypedData({
    domain: {
      name: 'DheetRefRegistry',
      version: '1',
      chainId: args.chainId,
      verifyingContract: args.refRegistry,
    },
    types: refUpdateTypes,
    primaryType: 'RefUpdate',
    message: request,
  })
  const hash = await walletClient.writeContract({
    address: args.refRegistry,
    abi: refRegistryAbi,
    functionName: 'updateRefBySig',
    args: [request, signer.address, signature],
  })
  await publicClient.waitForTransactionReceipt({ hash })
  const updated = await publicClient.readContract({
    address: args.refRegistry,
    abi: refRegistryAbi,
    functionName: 'state',
    args: [refKey],
  })
  return {
    transactionHash: hash,
    sequence: updated.sequence,
    refRoot: await publicClient.readContract({
      address: args.refRegistry,
      abi: refRegistryAbi,
      functionName: 'refRoot',
    }),
    oid: updated.oid,
    alreadyAnchored: false,
  }
}
