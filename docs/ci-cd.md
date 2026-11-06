# CI/CD and the deployment mirror

## Pipeline

```
push/PR ──> ci.yml: typecheck, bun tests, build, forge test, deterministic web build
push to main, ci green ──> deploy.yml
    1. checkout the commit that passed ci, build apps/web with GIT_COMMIT=<sha>
    2. rsync sources to the Linode server (excludes infra/prod.env, node_modules, .data, dist)
    3. ssh: GIT_COMMIT=<sha> docker compose -f infra/docker-compose.prod.yml up -d --build
       (Dockerfile ARG GIT_COMMIT -> dist/build.json carries the commit)
    4. wait until https://dithub.app/build.json reports that commit
    5. scripts/publish-release.ts   -> DeployRegistry.publish(commit, bundleHash, url) on Sepolia (idempotent)
    6. POST CRE_TRIGGER_URL (skipped when the secret is absent) -> Chainlink CRE deploy-attestor
    7. scripts/verify-site.ts       -> PASS/FAIL table, exit 1 on mismatch
worker (always running) ──> polls ReleasePublished / Attested logs ──> SQLite `deployments` ──> Arkiv (dheet-activity-v1 kinds deploy/attest)
api    GET /api/deployments  ──> reads the history back from Arkiv (local SQLite only if Arkiv is unreachable)
```

The bundle hash is published from the `build.json` the **server actually serves** (`BUILD_FROM_SITE=1`), because the Docker build is the artefact users receive.
Builds are deterministic for a given Bun version and source tree; the Docker base image is `oven/bun:1-debian` (floating tag), so pin it if you need bit-for-bit
reproduction on a different day. CI pins Bun 1.4.4.

## GitHub configuration

Secrets (Settings > Secrets and variables > Actions > Secrets), referenced by name only in the workflows:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_SSH_KEY` | private key (key-only SSH) authorised on the server |
| `DEPLOY_HOST` | server hostname or IP |
| `DHEET_DEPLOYER_KEY` | Sepolia key of the DeployRegistry owner/publisher (0xe5F2...A16b) |
| `SEPOLIA_RPC_URL` | Sepolia RPC (optional in practice: scripts fall back to publicnode) |
| `CRE_TRIGGER_URL` | optional CRE HTTP trigger endpoint; the step is skipped if unset |

Variables (optional): `DEPLOY_USER` (default `root`), `DEPLOY_PATH` (default `/opt/dheet`). Confirm these match the server layout before the first run.

## Wiring the API route (one line, done by the lead)

`apps/api/src/deployments.ts` exports a Hono sub-app `deployments`. In `apps/api/src/index.ts`:

```ts
import { deployments } from './deployments.ts'
app.route('/api', deployments)      // GET /api/deployments, GET /api/deployments/latest
```

The worker already starts the mirror (`startDeploymentMirror` in `apps/worker/src/index.ts`). Run migrations (`bun apps/api/src/migrate.ts`; the `deployments` table is in `packages/db/schema.sql`) before the new worker/API start;
the prod `api` container does this on boot (`bun apps/api/src/migrate.ts`).

## Mirror configuration

Addresses and start block come from `deployments/sepolia.json` (copied into the image). Overrides: `DEPLOY_REGISTRY`, `DEPLOY_ATTESTATIONS`, `DEPLOY_START_BLOCK`,
`DEPLOYMENTS_FILE`. Poll interval `DEPLOY_POLL_MS` (default 30000). `getLogs` window `DEPLOY_LOG_CHUNK` (default 2000 blocks; publicnode accepts it, some
free-tier RPCs such as Alchemy free reject it, so set 10 there or leave `SEPOLIA_RPC_URL` unset for the worker). Cursors live in `chain_cursors`;
the mirror is idempotent (a full rescan creates no duplicate Arkiv entities) and backs off exponentially on errors. Log lines strip RPC URLs because they can embed keys.

## Local checks

```sh
bun run typecheck && bun test packages/sdk/test packages/e2e/local-flow.test.ts && bun run build
forge test --root packages/contracts
actionlint .github/workflows/*.yml
GIT_COMMIT=$(git rev-parse HEAD) bun apps/web/build.ts
DRY_RUN=1 bun scripts/publish-release.ts
SITE=https://dithub.app bun scripts/verify-site.ts     # add REQUIRE_ATTESTATION=1 to fail when CRE has not attested
```
