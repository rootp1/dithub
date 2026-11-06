# Chainlink CRE: deploy-attestor

A Chainlink Runtime Environment (CRE) workflow, written in TypeScript, that proves the live website
matches what CI published, and writes the verdict on-chain as a DON-signed report.

Code lives in `cre/` (deliberately not under `apps/` or `packages/`, so it is not a root workspace).

## How it works

1. Triggers (both run the same logic):
   - HTTP trigger: CI calls it right after a deploy.
   - Cron trigger: every 15 minutes (`0 */15 * * * *`).
2. EVMClient read: `DeployRegistry.latestRelease()` returns `(id, commit, bundleHash, url, publishedAt, publisher)`.
3. HTTPClient (consensus across DON nodes, `consensusIdenticalAggregation`): fetch `${siteUrl}/build.json`, then every file it lists
   (`app.js`, `index.html`, `style.css`). Each node hashes the bytes it received.
4. Hashing inside the workflow with `@noble/hashes` (pure JS, works in the QuickJS/WASM runtime). The bundle hash replicates
   `apps/web/build.ts` exactly: `files = {name: "0x"+sha256hex}`, keys sorted ascending, `bundleHash = "0x"+sha256(JSON.stringify(files))` (no spaces).
5. Verdict: `ok` = recomputed bundleHash equals the registry bundleHash (the authoritative check) and a fetch/parse succeeded.
   Also logged (not part of `ok`): whether served bytes match build.json's per-file hashes, whether build.json is self-consistent,
   and whether `build.json.commit` matches the registry commit (hex sha left/right aligned in bytes32, or utf8 label).
   Any mismatch, 404, or unparsable build.json yields `ok=false`; the report is still written.
6. Report: `abi.encode(uint256 releaseId, bytes32 commit, bytes32 bundleHash, bool ok, uint64 observedAt)` (viem), then
   `runtime.report(...)` and `EVMClient.writeReport(...)` to `DeployAttestations`. `commit`/`bundleHash` in the report are the
   registry's values because `DeployAttestations.onReport` rejects reports that do not match the registry (`ReleaseMismatch`);
   `ok` carries the verdict.

## Files

- `cre/project.yaml`, `cre/secrets.yaml`: CRE project config (Sepolia RPC target).
- `cre/deploy-attestor/main.ts`, `workflow.ts`: workflow entry and logic.
- `cre/deploy-attestor/verify.ts`: pure hashing/verdict logic; `verify.test.ts` tests it against the real `apps/web/dist/build.json`.
- `cre/deploy-attestor/config.staging.json` / `config.production.json`: siteUrl, addresses, chain, gas limit, optional `httpAuthorizedAddresses`.
- `cre/.env`: git-ignored; holds `CRE_ETH_PRIVATE_KEY` (64 hex chars, no `0x`) and `SEPOLIA_RPC_URL`. Never commit.

## On-chain (Ethereum Sepolia, `deployments/sepolia.json`)

| Item | Address |
| --- | --- |
| DeployRegistry | `0x9caa2fEB7880Bb81b7A3C3324c22C3293c65655e` |
| DeployAttestations | `0x458d41E371141655c5b04618875aF22F83809BC9` |
| Forwarder (MockKeystoneForwarder, for simulation) | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |

Note: when forwarding through the mock forwarder, give the transaction at least ~500k gas (workflow `gasLimit` is 500000);
with the default estimate the forwarder swallowed an out-of-gas in `onReport` and recorded a failed delivery.
For a production deployment the consumer's forwarder must be switched to the real Sepolia KeystoneForwarder (`DeployAttestations.setForwarder`).

## Running

```bash
# install CLI (official installer), then restart the shell or add ~/.cre/bin to PATH
curl -sSL https://app.chain.link/cre/install.sh | bash
export PATH=$HOME/.cre/bin:$PATH

cd cre/deploy-attestor && bun install && bun test && bunx tsc --noEmit && cd ..

# REQUIRED once: the CLI refuses simulate/init without an account
cre login            # interactive browser login; or: export CRE_API_KEY=<key from app.chain.link>

# cron path (trigger index 1), dry run: report is built, write is simulated
cre workflow simulate deploy-attestor --target staging-settings --trigger-index 1
# HTTP path (trigger index 0)
cre workflow simulate deploy-attestor --target staging-settings --trigger-index 0 --http-payload '{}'
# really send the report through the mock forwarder on Sepolia
cre workflow simulate deploy-attestor --target staging-settings --trigger-index 1 --broadcast
```

Verify afterwards:

```bash
cast call 0x458d41E371141655c5b04618875aF22F83809BC9 'latestAttestation()(uint256,bool,uint64)' --rpc-url "$SEPOLIA_RPC_URL"
```

The workflow compiles to WASM (`bunx cre-compile main.ts out.wasm` inside `cre/deploy-attestor`).

## What needs an account

- `cre login` / `CRE_API_KEY`: required for `cre workflow simulate` (and `cre init`) in CLI v1.39.0. Not possible non-interactively without an API key.
- `cre workflow deploy` (running on a real DON, so cron and HTTP triggers go live) additionally needs deploy access
  (`cre account access`) and a real forwarder address in the consumer. The HTTP trigger then needs `httpAuthorizedAddresses`
  set to the CI signer address.

## Known gap

The live site (`https://dithub.app`) does not yet serve `/build.json` (it returns the SPA index page), so until
the web server ships `build.json` the workflow will correctly attest `ok=false` for the live site. The served `app.js`,
`index.html`, `style.css` already hash identically to local `apps/web/dist` (bundleHash `0xe30e835b...604b`, registry release #2).

## Verified run (2026-11-06, Ethereum Sepolia)

`cre login` (browser) then `cre workflow simulate deploy-attestor --target staging-settings --non-interactive --trigger-index 1 --broadcast`:

- Registry release #3 (commit `e01bc3fd36d2…`, bundleHash `0xafa0d9a5…3587`, published by tx `0x7192f325…ec4f`) was read at the **latest** block.
- The workflow fetched `/build.json` and every listed file from the live site, recomputed all hashes inside the workflow and got `ok=true` (bundle, files, build.json self-consistency and commit all match).
- CRE wrote the report through the MockKeystoneForwarder; `DeployAttestations.attestation(3)` returned `exists=true, ok=true, count=1`. Tx `0x50e4c5d3b18901581fffde9081a2aaa5c9c6449756ae96972b98c9fef687995c`.
- The Arkiv mirror then picked up the attestation and `GET /api/deployments/latest` on production reports release 3 as attested (source: arkiv).

Two things we learned the hard way:

1. **Gas.** `onReport` needs about 390k gas. With a 500k limit the forwarder's inner call ran out of gas and the forwarder swallowed the failure (the outer transaction still shows `status 1`; the forwarder event's data word is `0`). The workflow now uses `gasLimit: 1000000`. Always check `attestation(id)` on-chain, not just the transaction status.
2. **Block tag.** Reading the registry at the *finalized* block lags about 13 minutes, which attests the previous release right after a deploy. The workflow reads at the latest block; `DeployAttestations` re-checks commit and bundleHash against the registry when the report lands, so this is safe.
