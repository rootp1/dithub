# Dithub

Dithub is a GitHub-style collaboration platform (repos, orgs and RBAC, issues, pull requests, task-scoped contractor sessions) whose history is mirrored to public
infrastructure: every commit is recorded as an Arkiv entity carrying the Ethereum Sepolia anchor transaction, repo code is published to Arkiv, and the frontend you
are served is provably the one released on-chain. It also contains the original protocol work: a Git-compatible decentralised remote (`git-remote-dithub`) with an
SDK, CLI, indexer and Solidity contracts (see `plan.md`).

Live: https://dithub.app (single Linode, Caddy TLS, Docker Compose). Licence: MIT.

## Architecture

```
 browser ── HTTPS ──> Caddy ──> api (Bun + Hono) ──┐                  ┌── worker (Bun)
   │                              │ git smart HTTP  │                  │  outbox -> L1 anchor, Arkiv, Swarm
   │ GET /build.json              ▼ + hooks         ▼                  ▼  deployment mirror, Arkiv renewal
   ▼                         bare git repos    SQLite file (WAL, one host): read index, outbox, nonces, PATs,
 apps/web (static, hashed)                     device codes, sealed repo keys   (rebuildable from Arkiv + Swarm)
                                                                       │
          ┌────────────────────────────────────────────────────────────┼──────────────────────────────┐
          ▼                                                            ▼                              ▼
 Arkiv (Rabdi): public metadata                       Swarm (Bee light node): repo bytes     L1 (Base / Sepolia)
 dheet-activity-v1, -manifest-v1 (points at Swarm),   git packs + manifests; private repos   RefRegistry: one anchor per push
 -name-v1, -devicekey-v1, -grant-v1, RBAC chain       are XChaCha20-Poly1305 ciphertext      DeployRegistry: web releases

 GitHub Actions ─ build ─ rsync ─ docker compose
        ├─ publish-release.ts ──> DeployRegistry <── CRE deploy-attestor (DON) ──> DeployAttestations
        └─ verify-site.ts  ◄── anyone can run this: site files ↔ chain ↔ attestation
 0G Private Computer (TEE inference) <── api assistant (issue summaries / Q&A inside sessions)
```

## Storage

There is no database server. Each layer has one job (contract: `docs/swarm-arkiv-design.md`):

| Layer | Holds | Role |
|---|---|---|
| Arkiv | activity (commits, pushes, issues, PRs, RBAC chain, releases), name claims, manifests that point at Swarm, device-key registrations, private-repo key grants | source of truth for public metadata |
| Swarm | git pack bytes and their manifests | source of truth for repo bytes |
| L1 (`RefRegistry`) | one ref-root anchor per push | ordering and tamper evidence |
| SQLite | `DATABASE_PATH` (default `.data/dithub.sqlite`; production `/data/db/dithub.sqlite` on the `db` volume) | local cache: pages, permission checks, the push->anchor outbox, SIWE nonces, hashed PATs, CLI device codes, the server's sealed repo keys |

API and worker open the same SQLite file (WAL, `busy_timeout=5000`), so they must run on one host. The schema is
`packages/db/schema.sql`; later changes go in `packages/db/migrations-sqlite/`; `bun apps/api/src/migrate.ts` applies both and is
safe to re-run. Browser sessions are signed tokens (`SESSION_SECRET`), not rows; "log out everywhere" bumps `users.token_version`.

**Recovery.** `dit recover owner/repo` and `dithub arkiv-clone` read the Arkiv manifest, fetch the pack from Swarm (`BEE_URL`), check
that the Swarm pack and manifest hashes match Arkiv, and fall back to Arkiv chunks for anything Swarm cannot serve.

### Private repos

Phase 1 uses a **server-is-member** model:

- Each private repo has a random 32-byte key per epoch. Packs and manifests are encrypted with XChaCha20-Poly1305 before they reach Swarm.
- Every member device registers an X25519 key, signed by its wallet (`dit keys init`, page `/settings/device-keys`). The repo key is sealed
  to each device (`dheet-grant-v1` on Arkiv) and to the server (`DITHUB_DEVICE_KEY`; the sealed copy is in the `repo_keys` table).
- Removing a member rotates the key (new epoch, new grants for the remaining members and the server). Adding a member writes one grant.
  A removed member can still decrypt everything from the epochs they held.
- On Arkiv and L1 the repo is an opaque id, `sha256('dithub-private:' + repoId + ':' + secret)`, where the secret is
  `DITHUB_DEVICE_KEY` (so that key must never change once private repos are published). Activity bodies are sealed with the repo key; ref names, oids and roots anchored on L1 are keyed hashes. Names, issues and
  PR text stay in SQLite.

The server holds the key, so it can read every private repo; this protects against the public networks, not against the operator.

**What an observer of Arkiv, Swarm and L1 still sees** for a private repo:

- a stable opaque id, so every push to the same repo is linkable, with its time and order (one L1 transaction and one Arkiv entity per push);
- ciphertext sizes on Swarm, which approximate the pack size;
- the epoch count, and how many devices hold each epoch's key;
- each grant's recipient public key. Device-key registrations are public and signed by a wallet, so **the set of wallets that can read an opaque repo is visible**, though not its name or content;
- the writer address (the relayer) of every entity.

### Swarm postage

Uploading to Swarm needs a **postage batch**. A batch is bought on **Gnosis Chain** with **xBZZ**, and the Bee node also needs a little **xDAI** for gas.
A batch has a *depth* (capacity: 2^depth chunks of 4 KiB, so depth 22 is 16 GiB in theory and noticeably less in practice) and an
*amount* (PLUR per chunk, prepaid). Its lifetime is `amount / currentPrice` blocks, at about 5 seconds per block. The cost is `amount × 2^depth`
PLUR, and 1 xBZZ = 10^16 PLUR.

- **Cost:** at the 2025 storage price (about 24,000 PLUR per chunk per block) a depth-22 batch for 30 days is about 5 xBZZ, a few
  US dollars. This is an estimate. Read the live price from `GET /chainstate` (`currentPrice`) before buying.
- **Buy:** fund the node wallet (`GET /wallet`) with xDAI and xBZZ. Then call `POST /stamps/{amount}/{depth}`. It returns `batchID`, which goes in
  `BEE_POSTAGE_BATCH_ID`. Wait until `GET /stamps/{batchID}` shows `usable: true`, usually a few minutes.
- **TTL:** `GET /stamps` shows `batchTTL` in seconds. When a batch expires, its data can be dropped from the network. Top it up before then with
  `PATCH /stamps/topup/{batchID}/{amount}`, or grow it with `PATCH /stamps/dilute/{batchID}/{newDepth}` (diluting halves the remaining TTL per
  extra depth). Monitor this the way you monitor Arkiv renewals.
- In production the Bee API is internal only. Reach it through the api container:
  `docker compose -f infra/docker-compose.prod.yml exec api curl -s http://bee:1633/stamps`.
- In development, `infra/docker-compose.yml` runs `bee dev` (in memory, free stamps): `make stamp` prints a batch id. Tests use the in-process
  mock in `packages/sdk/src/testing/mock-bee.ts`, so no Bee is needed for them.

## Setup

Requirements: Bun 1.4.x, Docker, git, Foundry (for contracts).

```sh
bun install
cp .env.example .env                     # fill in values; never commit
docker compose -f infra/docker-compose.yml up -d --wait     # Bee (dev mode), Redis, Meilisearch, Mailpit
make stamp                               # dev postage batch -> BEE_POSTAGE_BATCH_ID in .env
bun apps/api/src/migrate.ts              # creates/updates the SQLite file (DATABASE_PATH, default .data/dithub.sqlite)
bun apps/web/build.ts                    # builds apps/web/dist (+ build.json)
bun run api                              # API + web on :3000
bun run worker                           # outbox -> L1 anchor + Arkiv + Swarm, deployment mirror, Arkiv renewal
```

Environment variable names (see `.env.example`, `infra/prod.env` and, for the Bee node, `infra/bee.env.example`): `ARKIV_ACCESS_KEY`, `DHEET_PRIVATE_KEY` (relayer), `DHEET_SEAT_KEY`, `DHEET_STRANGER_KEY`,
`DHEET_DEPLOYER_KEY`, `CRE_ETH_PRIVATE_KEY`, `SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY`, `ZG_API_KEY`, `ZG_PRIVATE_KEY`, `ZG_PRIVY_APP_ID`, `DHEET_LINODE_API_KEY`;
app runtime: `DATABASE_PATH`, `SESSION_SECRET` (>= 32 bytes, required in production), `DITHUB_DEVICE_KEY` (server X25519 key, 32-byte hex),
`BEE_URL`, `BEE_POSTAGE_BATCH_ID`, `INTERNAL_TOKEN`, `PORT`, `PUBLIC_URL`, `REF_REGISTRY`, `L1_RPC_URL`, `L1_CHAIN_ID`, `COOKIE_SECURE`, `SITE_HOST`.

## Commands and tests

```sh
bun run typecheck
bun test packages/sdk/test packages/db/test packages/e2e/local-flow.test.ts   # SDK (Swarm via mock Bee), SQLite schema, local git flow
bun test --isolate apps/api apps/worker                      # API/worker against temp SQLite files
bun run test:contracts                                       # forge test --root packages/contracts
bun scripts/e2e-platform.ts                                  # platform e2e against a local API
BASE_URL=https://dithub.app bun scripts/smoke-prod.ts
SITE=https://dithub.app bun scripts/verify-site.ts
```

## CROPS

**Censorship resistance.** Repository bytes (git packs) go to Swarm; the manifest pointing at them and per-commit activity are published to Arkiv, and each push is anchored
by one transaction to `RefRegistry` on L1. If our server disappears, `arkiv-clone` rebuilds a repo from Arkiv + Swarm (falling back to Arkiv chunks), verifying the manifest
hash and every BLAKE3 chunk. The SQLite file is only an index and can be rebuilt from Arkiv + Swarm.
Public-org RBAC changes are a hash chain mirrored to Arkiv. Limits: the web app and API are still one server we operate; Arkiv entities expire after about 182.5 days unless renewed (the worker renews them).

**Open source.** MIT licence; the whole stack (API, worker, web, SDK, contracts, CRE workflow, CI) is in this repo and runs from `docker compose`.

**Privacy.** Private repos are encrypted per epoch before they leave the server and appear on Arkiv/L1 only under an opaque id (see [Private repos](#private-repos)
for what is still visible). Private orgs get 404 for non-members and their RBAC log stays in SQLite.
Task sessions use the 0G Private Computer router in private trust mode so in-scope code is not shown to an ordinary model provider (`docs/zerog.md`).

The VS Code task workflow also runs from the terminal: `dit task assign 12 @dev -R owner/repo`, then
`dit task connect`, `edit`, `ask`, `diff` and `submit`. See [the task CLI guide](docs/dit-cli.md#0g-task-workflow-in-the-terminal).
Limits: Arkiv, Swarm and L1 data is public by design; wallet addresses of public contributors are visible; the server is a member of every private repo and can read it.

**Security.** SIWE login, hashed PATs, per-IP rate limits on auth, RBAC enforced in git `pre-receive`, containers with `cap_drop: ALL` and `no-new-privileges`, key-only SSH,
Cloud Firewall (22/80/443), fail2ban. Contracts are tested with Foundry but **not audited**; keys in this repo's environment are testnet keys.

**Verifiable frontend (the demo).** CI builds `apps/web` with `GIT_COMMIT=<sha>`; the build emits `build.json {commit, bundleHash, files}` where
`bundleHash = sha256(JSON.stringify({file: "0x"+sha256(bytes)}) with keys sorted)`. `scripts/publish-release.ts` records `(commit, bundleHash, url)` in `DeployRegistry`,
and the Chainlink CRE workflow independently fetches the live site, recomputes the hash and writes `ok` on-chain to `DeployAttestations`. Anyone can check:

```sh
SITE=https://dithub.app bun scripts/verify-site.ts
```

It re-hashes every served file, recomputes the bundle hash, compares with `latestRelease()` and the CRE attestation, prints PASS/FAIL/WARN per check and exits 1 on any mismatch
(tampering with a served file was tested and yields FAIL). To reproduce the build from source: check out the commit shown in `build.json`, run
`GIT_COMMIT=<sha> bun apps/web/build.ts` with Bun 1.4.4 and compare `bundleHash`. Caveat: reproducibility depends on the same Bun version and lockfile; the production Docker image is pinned to `oven/bun:1.4.4-debian`.
Another caveat: the check proves "served files == released files", not that the released source is free of bugs, and a malicious server could serve different files to
different clients (the CRE nodes and your own run sample the same URL).

## Contract addresses

Ethereum Sepolia (chain 11155111). Deploy addresses are read from `deployments/sepolia.json`:

| Contract | Address |
| --- | --- |
| DeployRegistry | `0x9caa2fEB7880Bb81b7A3C3324c22C3293c65655e` (deploy block 12073825) |
| DeployAttestations | `0x458d41E371141655c5b04618875aF22F83809BC9` (deploy block 12073828) |
| RefRegistry | `0x9f66f0CDc76423D26692437e3964e5CeB7F9341B` |
| Forwarder (in `deployments/sepolia.json`) | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`, a MockKeystoneForwarder (CRE simulation) |

Wallets (public addresses): relayer / Arkiv writer `0x7e290CA88091C8635cC78fE58bB1f6e1361b097c`; deployer / registry owner `0xe5F2164bD59ba9F19fC76F1Aa1E55199a159A16b`;
CRE wallet `0xB8Fc5e8C8B58a96b02980438Ed72EfE983100742`.

## Repository map

`apps/api`, `apps/worker`, `apps/web`, `apps/git/hooks`, `packages/sdk` (protocol, Arkiv, Swarm, keys), `packages/contracts`, `packages/db` (SQLite schema, `postgres-legacy/` old migrations), `cre/deploy-attestor`,
`infra/` (dev/prod compose with Bee, Caddy), `scripts/` (incl. `pg-to-sqlite.ts`), `arkiv/` (Arkiv track documents), `docs/` (`ci-cd.md`, `chainlink-cre.md`, `zerog.md`, `api-phase3.md`, `implementation-status.md`), `SUBMISSION.md`.

## Honest limitations

- Arkiv is a testnet (Rabdi) and the L1 defaults to Base but production stays on Sepolia until cut over (`docs/base-mainnet.md`); no audit.
- Swarm runs on mainnet: postage costs real xBZZ on Gnosis Chain.
- One server; API and worker share one SQLite file, so they cannot be split across hosts. Back up the `db` and `beedata` volumes (`sqlite3 dithub.sqlite ".backup out.sqlite"` is safe while running); the relayer key is a testnet key in `infra/prod.env`.
- Swarm data lives only as long as its postage batch is topped up; Bee has no read proofs either.
- Arkiv has no read proofs and anyone can write entities of our schema, so readers filter by the trusted writer address and verify hashes where possible; see `arkiv/friction.md`.
- Arkiv entities need renewal (about 182.5 days max per purchase); a renewal drill has not been run end to end.
- The CRE workflow is validated by simulation and a mock forwarder in `deployments/sepolia.json`; check `SUBMISSION.md` for whether a live DON deployment exists.
- Wallet login is EOA-only (no EIP-1271); the chain head of the RBAC hash chain is not yet anchored on L1.
- The project began before the hackathon (see `SUBMISSION.md`).

## dit CLI

Use Git for source control and `dit` for Dithub platform operations. `dit login` configures a host-scoped Git
credential helper, so ordinary `git clone`, `fetch`, `pull` and `push` work for private repositories without putting
tokens in argv, URLs or `.git/config`. Issues, pull requests, orgs, branch protection, task-scoped sessions and
on-chain verification are handled by `dit`.

```sh
bun link --cwd packages/dit      # or: bun run build:dit && cp packages/dit/dist/dit /usr/local/bin/
dit login && git clone https://dithub.app/git/alice/web
cd web && git status && git pull && git push
dit repo commits && dit verify site
```

`dit verify rebuild` proves the on-chain release equals a fresh Docker build of the public source; `dit recover owner/repo` rebuilds a repo from Arkiv alone (needs an Arkiv access key). Also: `repo ls|cat|commits|ledger`, `label`, `name resolve`, `deployments`, `token create`.

Full reference: [docs/dit-cli.md](docs/dit-cli.md). Tests: `bun run test:dit`, `bun scripts/e2e-dit.ts`.
