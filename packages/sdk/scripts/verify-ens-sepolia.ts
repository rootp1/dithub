import { sepolia } from 'viem/chains'
import { verifyEnsV2Deployment } from '../src/ens.ts'
const d = await verifyEnsV2Deployment({
  chain: sepolia,
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  registrar: '0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3',
})
console.log(d)
