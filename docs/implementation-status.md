# Implementation status

This repository implements the local-first Dithub protocol slice and deterministic acceptance tests. It does not claim a production mainnet deployment.

## Automated acceptance

- Canonical SHA-1/SHA-256 Git framing, Dithub SHA-256 OIDs, BLAKE3 chunks, manifests, and Merkle roots.
- Two-identity Git clone, edit, push, fresh clone, and strict `git fsck` through `git-remote-dithub`.
- Process-safe compare-and-swap and deterministic concurrent-writer rejection.
- Local Anvil deployment with direct ref anchoring, unsigned transaction generation, EIP-712 relaying, and EIP-1271 verification.
- Private payload authentication and key-epoch separation.
- Signed collaboration records and SQLite indexing.
- Complete archive export, hot-store loss, restore, clone, and strict Git verification.
- Static explorer build and indexer health/API smoke check.

## Environment-gated acceptance

These require external funding, credentials, or governance decisions and must pass before a production release:

- Rabdi create/query/keyset/extend and measured storage/gas report.
- ENSv2 Sepolia canonical registry/factory verification and repository registration.
- Two independent public cold-archive backends and a three-pinner expiry drill.
- Independent smart-contract and Git-parser audits, bug bounty, deployment multisig/timelock, and mainnet emergency drill.

No test substitutes mocked success for these external acceptance gates.

## Sepolia acceptance (2026-11-06)

Run against the live ENSv2 Sepolia deployment (Universal Resolver `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`, `isENSv2() == true`; `.eth` registry matches the registrar via `packages/sdk/scripts/verify-ens-sepolia.ts`).

- Org name: `dithuborg2644.eth`, registered through the ENSv2 registrar (commit/reveal, test USDC).
- Org `UserRegistry` (seats): `0xCcc41fC934b5e1C2bC2E28DDD298CF4d2EECaf37`, attached as the name's subregistry.
- `RefRegistry` (ENS-gated): `0x9f66f0CDc76423D26692437e3964e5CeB7F9341B`, `setEnsGate` points at the `UserRegistry`.
- Seat = `ROLE_REGISTRAR` on the `UserRegistry` ROOT_RESOURCE (reused ENS role; ENS has no custom role slot).
- Result: an ENS-seated wallet anchored `refs/heads/master` (tx `0x373ad3e3…713a`); an unseated wallet's push reverted with `Unauthorized`.
- Arkiv Rabdi: manifest entity `0x02d062ca…5d70` published and cloned back from an empty store (`arkiv-clone`).

Not yet done: Arkiv mirror of ENS seats, cold-archive replication, renewal drill, mainnet deployment.

## Platform phases 1-2 and Linode deployment (2026-11-06)

Built: `apps/api` (Hono: SIWE login, PATs, orgs, repos, name->repoId, git smart HTTP, code browser, commits with tx hashes, ledger), `apps/git/hooks` (pre-receive policy incl. ENSv2 seat check on L1, post-receive recording), `apps/worker` (outbox -> one L1 anchor per ref update, one Arkiv activity entity per commit carrying the L1 tx, name claims, code manifest upload, Arkiv renewal), `apps/web` (wallet login, create repo, file browser, commits with chips, ledger), SQLite schema (`packages/db/schema.sql`, consolidated from the Postgres migrations now in `packages/db/postgres-legacy/`).

Verified: `scripts/e2e-platform.ts` (16 checks, local) and `scripts/smoke-prod.ts` (8 checks, production).

Production: one Linode 4 GB (`ap-west`, Cloud Firewall 22/80/443, key-only SSH, fail2ban, unattended upgrades) running Caddy (automatic TLS), API, worker (sharing one SQLite file) and a Bee light node via `infra/docker-compose.prod.yml`. Cost about $24/month against the $100 promotional credit (expires 2027-02-01).

Known gaps: no backups yet (add `pg_dump` to Object Storage or enable Linode Backups, +$5/month), no Redis/search in production (not used by the apps yet), the relayer key is a testnet-only key stored in `infra/prod.env` (mode 600) on the server, EOA-only wallet login (no EIP-1271 yet), phase 3 (issues, PRs, reviews, merge) not started.

## ENS removed; web2 RBAC (2026-11-06)

ENSv2 seat gating was removed from the platform (migration `0002`: dropped `ens_seats`, `orgs.ens_*`, seat columns). The Solidity contracts keep their optional `setEnsGate` but the apps no longer use it.

RBAC is a web2 feature: org owners/members, teams, per-repo collaborators (read/triage/write/maintain/admin), team repo access and branch protection, all managed through `/api` (see `apps/api/src/rbac.ts`) and enforced at git `pre-receive`.

- **Public orgs:** every RBAC change is appended to a hash chain (`rbac_events`, `hash = sha256(prev || canonical(event))`) and the worker mirrors each event to Arkiv. Anyone can recompute the chain from the log and compare to the head. This proves the log was not rewritten; it does not prove which Arkiv RPC answers are complete.
- **Private orgs:** same RBAC, recorded in the local SQLite index (`rbac_events`, `audit_log`) only; nothing is queued or sent on-chain; repos in a private org are forced private; non-members get 404.
- The chain head is not yet anchored on L1 (planned with the manifest-hash anchoring and Arkiv+Swarm-to-SQLite rebuild).
- Fixed along the way: JSON payloads were stored as JSON strings (migration `0003` repairs them); fast-forward detection moved into the `pre-receive` hook because the API cannot see git's quarantined objects.

Verified: `scripts/e2e-platform.ts` 27/27 locally; `scripts/smoke-prod.ts` 8/8 on production.
