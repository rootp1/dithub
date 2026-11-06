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

## 4. Move the database off Postgres (once, if the server still runs it)

This release replaces Postgres with one SQLite file on the `db` volume and adds a Bee node. Copy the data first, while the old
Postgres container is still running. The new compose file no longer defines Postgres, so its container is left running as an
orphan on the same network until you remove it.

1. Pause the `deploy` workflow (disable it in GitHub, or skip pushes to `main`) so nothing restarts the stack halfway through.
2. Add the new settings on the server:
   - In `infra/prod.env`, add `SESSION_SECRET` (`openssl rand -hex 32`), `DITHUB_DEVICE_KEY` (`openssl rand -hex 32`, keep a copy offline:
     without it the sealed private-repo keys cannot be opened) and `BEE_POSTAGE_BATCH_ID` (bought in the next bullet).
   - Copy `infra/bee.env.example` to `infra/.env.bee` and fill it in.
   - Start the node alone: `docker compose -f infra/docker-compose.prod.yml up -d bee`. Its logs print the node wallet address. Fund it on
     Gnosis Chain with xDAI (gas) and xBZZ, then buy a batch as described in README "Swarm postage". You can read the Bee API with
     `docker run --rm --network dheet-prod_default curlimages/curl:8.11.1 -s http://bee:1633/wallet`, because the api image is not
     built yet. Light nodes deploy a chequebook on first start, which takes a few minutes after funding.
   - Delete `DATABASE_URL` only after step 6. The `POSTGRES_*` values are needed until then.
3. Sync the new sources (rsync as in `deploy.yml`, or `git pull` on the server). Then stop the writers:
   `docker compose -f infra/docker-compose.prod.yml stop api worker`.
4. Build and copy. The run container joins the project network, where the old `postgres` service name still resolves:
   ```sh
   set -a; . infra/prod.env; set +a        # POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
   docker compose -f infra/docker-compose.prod.yml build api
   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps \
     -e DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB" \
     api bun scripts/pg-to-sqlite.ts
   ```
   The script applies the SQLite schema, then copies every table with these conversions: bytea to BLOB, jsonb to JSON text, arrays to
   JSON, bool to 0/1, timestamptz to ISO-8601. It skips `sessions` (users sign in again) and `ens_seats`. It prints row counts per table
   and exits 1 if any table ended up with fewer rows or a foreign key does not resolve. Re-running it is safe: rows are upserted.
5. `docker compose -f infra/docker-compose.prod.yml up -d --build`. Check `/api/health`, sign in, open a private repo, and push to a test
   repo. The worker log should show `swarm: push ... pack ...`.
6. Remove Postgres: `docker compose -f infra/docker-compose.prod.yml up -d --remove-orphans`. Keep the `dheet-prod_pgdata` volume as a
   backup until you no longer need a rollback. Remove `DATABASE_URL` and `POSTGRES_*` from `infra/prod.env`, then re-enable `deploy`.

Rollback before step 6: check out the previous release and run `up -d --build`. Postgres still has all data up to step 3.

## 5. Cut over to Base (do these together)

1. Server `infra/prod.env`: set `L1_NETWORK=base` and `L1_RPC_URL=<Base RPC>`; delete `L1_CHAIN_ID` and
   `REF_REGISTRY` (the RefRegistry now comes from `deployments/base.json`). The worker refuses to start if the RPC
   serves a different chain than `L1_NETWORK`.
2. GitHub: repo variable `L1_NETWORK=base`; secret `BASE_RPC_URL`. Make sure `DHEET_DEPLOYER_KEY` is the funded key.
3. Push to `main`. CI builds the web bundle for Base. On start the API applies the SQLite schema and migrations (`deployments`
   is keyed by `(chain_id, id)`), then restarts, publishes release #1 to the Base DeployRegistry and verifies the live site against it.
4. Check: `dit verify site` (defaults to Base), the Deployments page "Verify this site" panel, and push to a public
   repo and confirm `dit verify commit HEAD` shows a Base receipt.

Old Sepolia anchors keep their chain id, so their explorer links and `dit verify commit` receipts still resolve on Sepolia.
Orgs created on Sepolia with their own `refRegistry` fall back to the default Base RefRegistry until they register one on Base.

## Rollback

Set `L1_NETWORK=sepolia` in both places (and `L1_RPC_URL` back to a Sepolia RPC) and redeploy. Base state is untouched.
