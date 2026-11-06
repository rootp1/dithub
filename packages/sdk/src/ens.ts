import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  parseAbi,
  stringToHex,
  type Address,
  type Chain,
  type Hex as ViemHex,
} from 'viem'

const universalResolverAbi = parseAbi([
  'function isENSv2() view returns (bool)',
  'function ROOT_REGISTRY() view returns (address)',
])

const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
])

const registrarAbi = parseAbi([
  'function ETH_REGISTRY() view returns (address)',
])

export interface EnsV2Deployment {
  universalResolver: Address
  registrar: Address
  rootRegistry: Address
  ethRegistry: Address
}

export async function verifyEnsV2Deployment(args: {
  chain: Chain
  rpcUrl: string
  universalResolver: Address
  registrar: Address
}): Promise<EnsV2Deployment> {
  const client = createPublicClient({ chain: args.chain, transport: http(args.rpcUrl) })
  const active = await client.readContract({
    address: args.universalResolver,
    abi: universalResolverAbi,
    functionName: 'isENSv2',
  })
  if (!active) throw new Error('Universal Resolver does not report ENSv2')
  const rootRegistry = await client.readContract({
    address: args.universalResolver,
    abi: universalResolverAbi,
    functionName: 'ROOT_REGISTRY',
  })
  const ethRegistry = await client.readContract({
    address: rootRegistry,
    abi: registryAbi,
    functionName: 'getSubregistry',
    args: ['eth'],
  })
  const registrarRegistry = await client.readContract({
    address: args.registrar,
    abi: registrarAbi,
    functionName: 'ETH_REGISTRY',
  })
  if (ethRegistry.toLowerCase() !== registrarRegistry.toLowerCase()) {
    throw new Error('ENSv2 registrar and hierarchy disagree on the .eth registry')
  }
  return { universalResolver: args.universalResolver, registrar: args.registrar, rootRegistry, ethRegistry }
}

export function ownedResolverSalt(owner: Address, version = 0n): bigint {
  const protocolDomain = keccak256(stringToHex('OwnedResolver'))
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [protocolDomain, owner, version],
      ),
    ),
  )
}

export function userRegistrySalt(name: string, version = 0n): bigint {
  const protocolDomain = keccak256(stringToHex('UserRegistry'))
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [protocolDomain, namehash(name), version],
      ),
    ),
  )
}

export function setRepositoryTextCall(name: ViemHex, key: string, value: string): ViemHex {
  const resolverAbi = parseAbi(['function setText(bytes name, string key, string value)'])
  return encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [name, key, value] })
}
