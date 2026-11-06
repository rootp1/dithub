# Dithub

Dithub is a GitHub-style collaboration platform (repos, orgs and RBAC, issues, pull requests, task-scoped contractor sessions) whose history is mirrored to public
infrastructure: every commit is recorded as an Arkiv entity carrying the Ethereum Sepolia anchor transaction, repo code is published to Arkiv, and the frontend you
are served is provably the one released on-chain. It also contains the original protocol work: a Git-compatible decentralised remote (`git-remote-dithub`) with an
SDK, CLI, indexer and Solidity contracts (see `plan.md`).

Live: https://172-105-43-184.sslip.io (single Linode, Caddy TLS, Docker Compose). Licence: MIT.

## Architecture

```
 browser ── HTTPS ──> Caddy ──> api (Bun + Hono)  ──────────────> PostgreSQL 16  (users, repos, RBAC, issues, PRs, outbox, deployments)
   │                              │  git smart HTTP + hooks              ▲
   │ GET /build.json              │  /api/deployments ── reads ──┐       │ outbox / cursors
   ▼                              ▼                              ▼       │
 apps/web (static, hashed)    bare git repos            Arkiv (Rabdi) <──┴── worker (Bun)
                                                         ▲  dheet-activity-v1, -manifest-v1, -chunk-v1, -name-v1
 GitHub Actions ─ build ─ rsync ─ docker compose          │  
        │                                                 └── worker also mirrors Sepolia logs ──┐
        ├─ publish-release.ts ──> DeployRegistry (Sepolia) <── CRE deploy-attestor (DON) ──> DeployAttestations
        └─ verify-site.ts  ◄── anyone can run this: site files ↔ chain ↔ attestation
 0G Private Computer (TEE inference) <── api assistant (issue summaries / Q&A inside sessions)
```

## Setup

Requirements: Bun 1.4.x, Docker, git, Foundry (for contracts).

```sh
bun install
cp .env.example .env                     # fill in values; never commit
docker compose -f infra/docker-compose.yml up -d --wait     # Postgres, Redis, Meilisearch, Mailpit
bun apps/api/src/migrate.ts              # applies packages/db/migrations/*.sql
bun apps/web/build.ts                    # builds apps/web/dist (+ build.json)
bun run api                              # API + web on :3000
bun run worker                           # outbox -> L1 anchor + Arkiv, deployment mirror, Arkiv renewal
```

Environment variable names (see `.env.example` and `infra/prod.env`): `ARKIV_ACCESS_KEY`, `DHEET_PRIVATE_KEY` (relayer), `DHEET_SEAT_KEY`, `DHEET_STRANGER_KEY`,
`DHEET_DEPLOYER_KEY`, `CRE_ETH_PRIVATE_KEY`, `SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY`, `ZG_API_KEY`, `ZG_PRIVATE_KEY`, `ZG_PRIVY_APP_ID`, `DHEET_LINODE_API_KEY`;
app runtime: `DATABASE_URL`, `INTERNAL_TOKEN`, `PORT`, `PUBLIC_URL`, `REF_REGISTRY`, `L1_RPC_URL`, `L1_CHAIN_ID`, `COOKIE_SECURE`, `SITE_HOST`.

## Commands and tests

```sh
bun run typecheck
bun test packages/sdk/test packages/e2e/local-flow.test.ts   # SDK + local two-identity git flow
bun run test:contracts                                       # forge test --root packages/contracts
bun scripts/e2e-platform.ts                                  # platform e2e against a local API
BASE_URL=https://172-105-43-184.sslip.io bun scripts/smoke-prod.ts
SITE=https://172-105-43-184.sslip.io bun scripts/verify-site.ts
```

## CROPS

**Censorship resistance.** Repository code (chunked packfiles + manifest) and per-commit activity are published to Arkiv, and each push is anchored by one transaction to
`RefRegistry` on Ethereum Sepolia. If our server disappears, `arkiv-clone` rebuilds a repo from Arkiv alone, verifying the manifest hash and every BLAKE3 chunk.
Public-org RBAC changes are a hash chain mirrored to Arkiv. Limits: the web app and API are still one server we operate; Arkiv entities expire after about 182.5 days unless renewed (the worker renews them).

**Open source.** MIT licence; the whole stack (API, worker, web, SDK, contracts, CRE workflow, CI) is in this repo and runs from `docker compose`.

**Privacy.** Private repos and private orgs are never queued for the public ledger (the worker marks their anchors `done_private`; private orgs get 404 for non-members).
Task sessions use the 0G Private Computer router in private trust mode so in-scope code is not shown to an ordinary model provider (`docs/zerog.md`).
Limits: Arkiv and Sepolia data is public by design; wallet addresses of public contributors are visible; private data lives in our Postgres, not encrypted on a public network.

**Security.** SIWE login, hashed PATs, per-IP rate limits on auth, RBAC enforced in git `pre-receive`, containers with `cap_drop: ALL` and `no-new-privileges`, key-only SSH,
Cloud Firewall (22/80/443), fail2ban. Contracts are tested with Foundry but **not audited**; keys in this repo's environment are testnet keys.

**Verifiable frontend (the demo).** CI builds `apps/web` with `GIT_COMMIT=<sha>`; the build emits `build.json {commit, bundleHash, files}` where
`bundleHash = sha256(JSON.stringify({file: "0x"+sha256(bytes)}) with keys sorted)`. `scripts/publish-release.ts` records `(commit, bundleHash, url)` in `DeployRegistry`,
and the Chainlink CRE workflow independently fetches the live site, recomputes the hash and writes `ok` on-chain to `DeployAttestations`. Anyone can check:

```sh
SITE=https://172-105-43-184.sslip.io bun scripts/verify-site.ts
```

It re-hashes every served file, recomputes the bundle hash, compares with `latestRelease()` and the CRE attestation, prints PASS/FAIL/WARN per check and exits 1 on any mismatch
(tampering with a served file was tested and yields FAIL). To reproduce the build from source: check out the commit shown in `build.json`, run
`GIT_COMMIT=<sha> bun apps/web/build.ts` with Bun 1.4.4 and compare `bundleHash`. Caveat: reproducibility depends on the same Bun version and lockfile; the production Docker base image tag is floating (`oven/bun:1-debian`).
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

`apps/api`, `apps/worker`, `apps/web`, `apps/git/hooks`, `packages/sdk` (protocol + Arkiv), `packages/contracts`, `packages/db/migrations`, `cre/deploy-attestor`,
`infra/` (prod compose, Caddy), `scripts/`, `arkiv/` (Arkiv track documents), `docs/` (`ci-cd.md`, `chainlink-cre.md`, `zerog.md`, `api-phase3.md`, `implementation-status.md`), `SUBMISSION.md`.

## Honest limitations

- Testnets only (Sepolia, Arkiv Rabdi); no mainnet deployment, no audit.
- One server; no database backups yet; the relayer key is a testnet key in `infra/prod.env`.
- Arkiv has no read proofs and anyone can write entities of our schema, so readers filter by the trusted writer address and verify hashes where possible; see `arkiv/friction.md`.
- Arkiv entities need renewal (about 182.5 days max per purchase); a renewal drill has not been run end to end.
- The CRE workflow is validated by simulation and a mock forwarder in `deployments/sepolia.json`; check `SUBMISSION.md` for whether a live DON deployment exists.
- Wallet login is EOA-only (no EIP-1271); the chain head of the RBAC hash chain is not yet anchored on L1.
- The project began before the hackathon (see `SUBMISSION.md`).
