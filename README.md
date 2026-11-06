# 🪵 Dithub

*Code collaboration whose history lives on public infrastructure*

Dithub is a GitHub-style collaboration platform with repositories, organisations and RBAC, issues, pull requests and
task-scoped contractor sessions. Unlike a conventional forge, its history is mirrored to public infrastructure: every
commit is recorded as an [Arkiv](https://arkiv.network) entity carrying the anchor transaction, repository code is
published to Arkiv, and the frontend you are served is provably the one that was released on-chain.

The repository contains the full stack: an API (`apps/api`), a background worker (`apps/worker`), the web app
(`apps/web`), a command-line client (`dit`), a VS Code extension, an SDK, Solidity contracts and a Chainlink CRE
workflow. It also contains the original protocol work, a Git-compatible decentralised remote (`git-remote-dithub`);
see [`plan.md`](plan.md).

Live at <https://dithub.app> (single Linode, Caddy TLS, Docker Compose).

## Features

* **Familiar collaboration.** Repos, orgs, roles, branch protection, issues and pull requests, over plain Git smart HTTP.
* **Public history.** Each push is anchored with one transaction to `RefRegistry`; per-commit activity and chunked
  packfiles are published to Arkiv. If our server disappears, `dit recover` rebuilds a repo from Arkiv alone.
* **Verifiable frontend.** Anyone can check that the files served by the site are the files released on-chain.
* **Task sessions.** Assign one issue to a contractor and give them only the files in scope, with AI assistance running
  on 0G Private Computer in private trust mode. Works from VS Code or the terminal.
* **Privacy where it matters.** Private repos and orgs are never queued for the public ledger.

## Installation

**Requirements**

* *macOS* or *Linux*
* [Bun](https://bun.sh) 1.4.x
* Git 2.30 or later
* Docker (to run the platform locally)
* [Foundry](https://getfoundry.sh) (only for the contracts)

### 🖥️ The `dit` CLI

> Requires Bun. There are no prebuilt binaries yet.

Use Git for source control and `dit` for Dithub platform operations. `dit login` installs a host-scoped Git credential
helper, so ordinary `git clone`, `fetch`, `pull` and `push` work for private repos without tokens in argv, URLs or
`.git/config`.

    bun install
    bun link --cwd packages/dit        # puts `dit` on your PATH

Or build one self-contained binary:

    bun run build:dit
    sudo cp packages/dit/dist/dit /usr/local/bin/dit

Then:

    dit login                          # prints a code; approve it in the browser
    git clone https://dithub.app/git/alice/web
    cd web && git pull && git push
    dit issue create -t "Bug" -b "details"
    dit pr create --push -t "Fix it"
    dit repo commits                   # per-commit anchor and Arkiv transactions
    dit verify site                    # does the served frontend match the release?

`dit verify rebuild` proves the on-chain release equals a fresh Docker build of the public source, and
`dit recover owner/repo` rebuilds a repo from Arkiv alone (needs an Arkiv access key).
Full reference: [docs/dit-cli.md](docs/dit-cli.md).

### 🧩 The VS Code extension

> Requires VS Code 1.90 or later.

    bun run package:vscode
    code --install-extension packages/vscode/dithub-vscode.vsix --force

Run **Dithub: Sign in**, then use **Assign with 0G** on an issue. See [docs/vscode-extension.md](docs/vscode-extension.md).
The same workflow is available in the terminal with `dit task assign|connect|edit|ask|diff|submit`.

### 📦 Running the platform from source

    bun install
    cp .env.example .env                                         # fill in values; never commit
    docker compose -f infra/docker-compose.yml up -d --wait      # Postgres, Redis, Meilisearch, Mailpit
    bun apps/api/src/migrate.ts                                  # applies packages/db/migrations/*.sql
    bun apps/web/build.ts                                        # builds apps/web/dist and build.json
    bun run api                                                  # API + web on :3000
    bun run worker                                               # outbox, L1 anchoring, Arkiv, deployment mirror

Environment variables are documented by name in `.env.example` and `infra/prod.env`. The key ones are `DATABASE_URL`,
`PUBLIC_URL`, `L1_NETWORK`, `L1_RPC_URL`, `ARKIV_ACCESS_KEY`, `DHEET_PRIVATE_KEY` (the relayer) and `ZG_API_KEY`.

## Architecture

```
 browser ── HTTPS ──> Caddy ──> api (Bun + Hono)  ──────────────> PostgreSQL 16  (users, repos, RBAC, issues, PRs, outbox, deployments)
   │                              │  git smart HTTP + hooks              ▲
   │ GET /build.json              │  /api/deployments ── reads ──┐       │ outbox / cursors
   ▼                              ▼                              ▼       │
 apps/web (static, hashed)    bare git repos            Arkiv (Rabdi) <──┴── worker (Bun)
                                                        ▲  dheet-activity-v1, -manifest-v1, -chunk-v1, -name-v1
 GitHub Actions ─ build ─ rsync ─ docker compose          │
        │                                                 └── worker also mirrors L1 logs ──┐
        ├─ publish-release.ts ──> DeployRegistry (L1) <── CRE deploy-attestor (DON) ──> DeployAttestations
        └─ verify-site.ts  ◄── anyone can run this: site files ↔ chain ↔ attestation
 0G Private Computer (TEE inference) <── api assistant (issue summaries / Q&A inside sessions)
```

## Networks

The L1 is chosen by one setting, `L1_NETWORK` (`base` or `sepolia`), read by the API, worker, web build, release
scripts and `dit` (`DIT_NETWORK`). Addresses live in `deployments/<network>.json`. Code defaults to Base; production
currently runs on **Ethereum Sepolia** until the Base contracts are deployed. See
[docs/base-mainnet.md](docs/base-mainnet.md) for the move to Base (chain 8453).

Arkiv storage stays on its testnet (Rabdi). Chainlink CRE attestations are not live on Base yet, and the verify
tooling reports that instead of failing.

| Contract (Sepolia, 11155111) | Address |
| --- | --- |
| DeployRegistry | `0x9caa2fEB7880Bb81b7A3C3324c22C3293c65655e` |
| DeployAttestations | `0x458d41E371141655c5b04618875aF22F83809BC9` |
| RefRegistry | `0x9f66f0CDc76423D26692437e3964e5CeB7F9341B` |

## Verifying the frontend

CI builds `apps/web` with `GIT_COMMIT=<sha>` and the build emits `build.json {commit, bundleHash, files}`, where
`bundleHash` is the sha256 of the sorted per-file sha256 map. `scripts/publish-release.ts` records
`(commit, bundleHash, url)` in `DeployRegistry`, and the Chainlink CRE workflow independently fetches the live site,
recomputes the hash and writes `ok` to `DeployAttestations`. Anyone can check:

    SITE=https://dithub.app bun scripts/verify-site.ts

It re-hashes every served file, compares with `latestRelease()` and the CRE attestation, prints PASS/FAIL/WARN per
check and exits 1 on any mismatch. To reproduce the build, check out the commit shown in `build.json` and run
`GIT_COMMIT=<sha> bun apps/web/build.ts` with Bun 1.4.4.

This proves "served files equal released files", not that the released source is bug-free, and a malicious server could
show different files to different clients.

## Testing

    bun run typecheck
    bun run test                       # SDK + local two-identity git flow
    bun run test:dit                   # CLI
    bun run test:vscode                # extension
    bun run test:contracts             # forge test
    bun scripts/e2e-platform.ts        # platform e2e against a local API
    SITE=https://dithub.app bun scripts/verify-site.ts

`bun run check` runs typecheck, tests, contract tests and the build in one go.

## Security and limitations

Dithub uses SIWE login, hashed PATs, per-IP auth rate limits, RBAC enforced in git `pre-receive`, containers with
`cap_drop: ALL` and `no-new-privileges`, key-only SSH, a Cloud Firewall and fail2ban. Be aware of the following:

* Contracts are tested with Foundry but **not audited**. Keys in this repo's environment are testnet keys.
* Arkiv and L1 data is public by design, and wallet addresses of public contributors are visible. Private data lives
  in our Postgres and is not encrypted on a public network.
* The web app and API are still one server we operate, with no database backups yet.
* Arkiv entities expire after about 182.5 days unless renewed (the worker renews them; the renewal drill has not been
  run end to end). Arkiv has no read proofs, so readers filter by the trusted writer address and verify hashes.
* The CRE workflow is validated by simulation and a mock forwarder; see [`SUBMISSION.md`](SUBMISSION.md).
* Wallet login is EOA-only (no EIP-1271), and the RBAC hash-chain head is not yet anchored on L1.

## Repository map

| Path | What is in it |
| --- | --- |
| `apps/api` | Bun + Hono API, git smart HTTP, RBAC |
| `apps/worker` | Outbox, L1 anchoring, Arkiv publishing and renewal, deployment mirror |
| `apps/web` | Static web app and the hashed build |
| `apps/git/hooks` | Server-side git hooks |
| `packages/dit` | The `dit` CLI |
| `packages/vscode` | VS Code extension |
| `packages/sdk` | Protocol and Arkiv SDK |
| `packages/contracts` | Solidity contracts (`RefRegistry`, `DeployRegistry`, `DeployAttestations`) |
| `packages/db/migrations` | PostgreSQL migrations |
| `cre/deploy-attestor` | Chainlink CRE workflow |
| `infra` | Compose files and Caddy config |
| `docs` | [`ci-cd.md`](docs/ci-cd.md), [`chainlink-cre.md`](docs/chainlink-cre.md), [`zerog.md`](docs/zerog.md), [`base-mainnet.md`](docs/base-mainnet.md), [`implementation-status.md`](docs/implementation-status.md) |

## Feedback

Open an issue at <https://github.com/rootp1/dithub/issues>, or file one with `dit issue create` on
<https://dithub.app>.

## Contributing

Fork the repo, branch from `main`, and make sure `bun run check` passes before opening a pull request. Start with
[`docs/implementation-status.md`](docs/implementation-status.md) and [`plan.md`](plan.md) to see what is built and
what is planned.

## License

Dithub is distributed under the terms of the MIT license. See [LICENSE](LICENSE) for details.
