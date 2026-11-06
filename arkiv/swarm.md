# Swarm repository recovery

Public repositories can back up Git history to Swarm while Arkiv provides discovery. Ordinary clone, push and file browsing use the existing Git server. A separate queue streams bundles to Swarm; commit anchoring does not wait for those uploads. Large release attachments and Git LFS object storage are not implemented in this version.

## Storage format and trust

- Swarm `/bytes` stores a self-contained Git bundle of branches and tags and a JSON snapshot manifest. Internal/session refs are excluded. The manifest records the repository ID, actual captured refs, default branch, Git object format, bundle reference, SHA-256, byte size and creation time.
- Arkiv `dheet-snapshot-v2` stores the repository ID, queue sequence, creation time, manifest SHA-256, manifest reference (`reference`) and manifest size. The compact pointer fits in one entity regardless of repository size. Pointer writes are readonly and permit permissionless extension; the existing renewal worker tracks them.
- Arkiv commit/name/activity records and L1 anchoring continue to serve their existing purposes. The existing L1 anchor commits to commit OIDs; it does **not** directly authenticate the v2 manifest. Discovery filters the actual Arkiv `$creator` against the trusted relayer, then recovery verifies manifest and bundle hashes, advertised refs and `git fsck`. Self-hosted clients must set `--writer` or `DHEET_RECOVERY_WRITER` to their relayer.
- With Swarm enabled, new code backups use v2 for small and large repositories alike. Without the complete Swarm configuration, the existing small-repository Arkiv publication path stays enabled. Legacy v1 backups remain readable.

The upload path uses the Bee HTTP API directly to stream disk files without buffering the full bundle in memory. It sets `swarm-deferred-upload: false` and pins locally. Before publishing the Arkiv pointer, it downloads and verifies the **entire bundle and manifest** through `SWARM_READ_URL`. Use an independent reader: reading through the uploading Bee node alone does not establish network availability. A successful check records evidence at that moment, not a permanence guarantee.

## Enable and use

1. Provision a Bee upload node connected to the intended Swarm network and buy a funded, usable postage batch. Configure API and worker with `SWARM_BEE_URL`, `SWARM_BATCH_ID` (64 hex characters without `0x`), and `SWARM_READ_URL` (an independent Bee API or compatible gateway with `/bytes`). Keep the upload node private. The implementation does not buy batches or send top-up transactions.
2. Run `bun apps/api/src/migrate.ts`, then restart API and worker. In production, `infra/docker-compose.prod.yml` already loads both services from `infra/prod.env`; add these settings there. No extra process or shared Git write access is required.
3. Push a public repo normally. Branch/tag updates enqueue a backup in the same database transaction as the push record. Existing public repos can use **Back up now** in the repository Code or Ledger tab. The API and worker must agree on configuration.
4. Watch **Repository recovery**: preparing, uploading, verifying, publishing, ready, or retrying. The page compares all current branches/tags against the captured snapshot, separately from commit anchoring. A new upload retains the last completed backup. Failed jobs retry up to eight times; **Back up now** starts a fresh attempt. Empty/private/deleted repos are skipped.
5. Recover with `dit recover owner/repo [directory] --arkiv-only --access-key KEY`. Set `--writer ADDRESS` for a self-hosted relayer and optionally `--bee-url URL` for a reader. `--arkiv-only` skips the Dheet API; Swarm-backed content still downloads from Swarm. The default reader is Dithub's read-only proxy `https://dithub.app/swarm` (Sepolia has no public Swarm gateway; `api.gateway.ethswarm.org` is mainnet only). Any Bee node on the Sepolia testnet works as `--bee-url`, which removes the dependency on Dithub.
6. Download recovery instructions from the page and keep them elsewhere. `dit recover owner/repo [directory] --recovery-file dheet-recovery.json --bee-url URL` uses the saved repository ID and pointer without contacting Dheet or Arkiv and needs no Arkiv access key. Treat this downloaded file as trusted configuration. Moving/renaming a repository does not change the saved ID; the ID form of the command continues to work.

Uploads and recovery downloads have a default 10 GiB cap and a 30-minute request timeout. Operators can change `SWARM_MAX_BYTES` on the worker; recovery clients can use `--max-bytes` or the same environment variable. Retries restart the failed transfer; byte-range resume is not implemented. Temporary mirrors, original bundles and verification copies require disk space beyond the repository size. Worker leases recover interrupted jobs, one upload per repository runs at a time, and completed snapshots coalesce already queued pushes.

## Retention and privacy

Arkiv pointers need renewal and Swarm batches need ongoing funding. The existing Arkiv renewal loop extends tracked pointers. An hourly Swarm batch check records estimated funding coverage and shows an attention message if the batch is low, expired, stale or unavailable. Operators must top up batches before expiry using Bee/Swarm tooling; this release neither charges users nor automatically spends the node's funds. Postage TTL depends on network storage pricing and is an estimate. Local pinning alone does not preserve network availability.

Snapshots cover Git branches/tags and reachable Git objects, not database issues, reviews, credentials, submodule repositories or external Git LFS objects. They do not provide decentralized per-file browsing. Public data may remain retrievable after deletion or a later visibility change. Private/internal repositories are never intentionally uploaded; do not use this public backup feature for content that must later become secret. Encrypted Swarm references contain keys and are rejected by this public pointer format.

## Reproduce verification

`bun run test:recovery` runs streaming transfer, corruption, size validation, a repository over 2 MB, branch/tag restoration and recovery-file tests against a local Bee protocol fixture. Fixture hashes are SHA-256 stand-ins, not Swarm BMT references. UI tests check readiness, older snapshots, retry and funding messaging.

For the PostgreSQL integration test, create an **isolated** test database, apply migrations with `DATABASE_URL=... bun apps/api/src/migrate.ts`, then run `SWARM_TEST_DATABASE_URL=... bun test apps/worker/test/snapshots.test.ts`. It tests real push recording, queue retry, saved-pointer resume, lease recovery, Arkiv tracking (using a simulated Arkiv client), recovery HTTP endpoints and private-repo exclusion. It never sends live blockchain transactions.

Live Swarm/Arkiv verification needs configured infrastructure and credentials. No live entity key, batch ID, purchaser wallet or network reference is claimed by these local tests. After a live push, obtain the entity key and manifest reference from `GET /api/repos/OWNER/REPO/recovery`, save the instructions, then recover on another machine using an independent reader. Record the actual Bee service, batch purchaser, batch ID and retrieval results for an operational deployment.

Protocol references: [Bee API](https://docs.ethswarm.org/api/), [postage batches](https://docs.ethswarm.org/docs/develop/tools-and-features/buy-a-stamp-batch/), [Arkiv limits](https://stage.docs.arkiv.network/reference/limits/).

## Live deployment (dithub.app, Sepolia Swarm testnet)

`infra/docker-compose.prod.yml` runs two Bee 2.8.3 nodes beside the API: `bee` (light node, swap enabled, uploads and holds the postage batch) and
`bee-reader` (ultra-light, no tokens, independent network reads used for the full-download check and for the public `GET /swarm/bytes/<ref>` route in Caddy).
Neither Bee API port is published; only the p2p ports (1634, 1635) are. Secrets live in `infra/bee.env` on the server (excluded from git and from the deploy rsync):
`BEE_PASSWORD` and `BEE_BLOCKCHAIN_RPC_ENDPOINT`. The RPC must serve historical `eth_getLogs` in 5,000-block pages for postage sync (publicnode is pruned and
Alchemy's free tier allows 10 blocks; `https://sepolia.gateway.tenderly.co` works). `infra/prod.env` sets `SWARM_BEE_URL=http://bee:1633`,
`SWARM_READ_URL=http://bee-reader:1633` and `SWARM_BATCH_ID`.

Check the node from the server: `docker exec dheet-prod-api-1 curl -s http://bee:1633/stamps`. Top up before `batchTTL` runs low:
`curl -X PATCH http://bee:1633/stamps/topup/<batchID>/<amount>` (cost = amount x 2^depth PLUR; 1 sBZZ = 10^16 PLUR). sBZZ comes from the Swarm Discord faucet.
