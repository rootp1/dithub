# Moving production to Base mainnet (chain 8453)

The L1 is chosen by one setting, `L1_NETWORK` (`base` | `sepolia`), read by the API, the worker, the web build
(`apps/web/build.ts` bakes it into the bundle, so it is covered by `bundleHash`), the release scripts and `dit`
(`DIT_NETWORK`). Addresses live in `deployments/<network>.json`; `deployments/networks.ts` is the only place that
knows chain ids, RPCs and explorers. Code defaults to Base; CI and the server stay on Sepolia until you flip them.

What moves: ref anchoring (`RefRegistry`) and frontend releases (`DeployRegistry`).
What does not: Arkiv storage stays on its testnet (Rabdi; there is no Arkiv mainnet). Chainlink CRE attestations
(`DeployAttestations`) are not deployed on Base until the CRE account can deploy mainnet workflows; the verify
panel and `dit verify site` report them as "not live on Base yet" instead of failing.

## 1. Fund the wallets (real ETH on Base)

| Wallet | Pays for | Suggested float |
|---|---|---|
| Deployer (`DHEET_DEPLOYER_KEY`) | contract deploy (about 1.95M gas) and one `publish` per production deploy | 0.002 ETH |
| Relayer (`DHEET_PRIVATE_KEY`, the worker) | one `updateRef` per public push | 0.01 ETH, top up as usage grows |

Base gas is usually well under 0.01 gwei, so a deploy costs cents. Bridge with the official bridge or withdraw from
an exchange straight to Base. Keep the deployer key off the server.

## 2. Deploy the contracts

```sh
cd packages/contracts
export DHEET_DEPLOYER_KEY=0x...            # funded on Base
export RELAYER=0x...                       # address of the worker's DHEET_PRIVATE_KEY (gets WRITER + FORCE_PUSH)
export L1_RPC_URL=https://base-rpc.publicnode.com   # or a keyed provider
# FORWARDER deliberately unset: DeployAttestations is skipped
forge script script/Deploy.s.sol:Deploy --rpc-url $L1_RPC_URL            # simulate first, read the output
forge script script/Deploy.s.sol:Deploy --rpc-url $L1_RPC_URL --broadcast
```

(The `--root packages/contracts` form fails with current Foundry; run it from inside the directory.)

Verify on Basescan (an Etherscan v2 key covers Base):

```sh
forge verify-contract --chain 8453 <DeployRegistry> src/DeployRegistry.sol:DeployRegistry --constructor-args $(cast abi-encode "c(address)" <deployer>) --etherscan-api-key $ETHERSCAN_API_KEY
forge verify-contract --chain 8453 <RefRegistry>    src/RefRegistry.sol:RefRegistry       --constructor-args $(cast abi-encode "c(address)" <deployer>) --etherscan-api-key $ETHERSCAN_API_KEY
```

## 3. Record the addresses

Fill `deployments/base.json` from `broadcast/Deploy.s.sol/8453/run-latest.json`, then commit it (and the broadcast file):

```json
{
  "chainId": 8453,
  "deployedAt": "YYYY-MM-DD",
  "owner": "0x<deployer>",
  "contracts": {
    "DeployRegistry": { "address": "0x...", "txHash": "0x...", "deployBlock": 0 },
    "RefRegistry":    { "address": "0x...", "txHash": "0x...", "deployBlock": 0 }
  }
}
```

`deployBlock` is where the worker's deployment mirror starts scanning; use the DeployRegistry receipt's block.

## 4. Cut over (do these together)

1. Server `infra/prod.env`: set `L1_NETWORK=base` and `L1_RPC_URL=<Base RPC>`; delete `L1_CHAIN_ID` and
   `REF_REGISTRY` (the RefRegistry now comes from `deployments/base.json`). The worker refuses to start if the RPC
   serves a different chain than `L1_NETWORK`.
2. GitHub: repo variable `L1_NETWORK=base`; secret `BASE_RPC_URL`. Make sure `DHEET_DEPLOYER_KEY` is the funded key.
3. Push to `main`. CI builds the web bundle for Base, runs migrations (`0011_deployments_chain.sql` keys the deployment
   mirror by chain), restarts, publishes release #1 to the Base DeployRegistry and verifies the live site against it.
4. Check: `dit verify site` (defaults to Base), the Deployments page "Verify this site" panel, and push to a public
   repo and confirm `dit verify commit HEAD` shows a Base receipt.

Old Sepolia anchors keep their chain id, so their explorer links and `dit verify commit` receipts still resolve on Sepolia.
Orgs created on Sepolia with their own `refRegistry` fall back to the default Base RefRegistry until they register one on Base.

## Rollback

Set `L1_NETWORK=sepolia` in both places (and `L1_RPC_URL` back to a Sepolia RPC) and redeploy. Base state is untouched.
