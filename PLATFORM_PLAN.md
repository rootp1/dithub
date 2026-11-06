# Dithub Platform Plan: Web2 Product on a Web3 Backbone

**Status:** plan only. No implementation has started from this document.
**Relationship to `plan.md`:** `plan.md` is the protocol (Arkiv, ENSv2, L1, Git compatibility). This file is the product and infrastructure around it: the GitHub-style web app, its database, and its production infrastructure. Where the two overlap, `plan.md` wins on protocol rules.

## 0. Scope, and what "copy GitHub" can mean

1. **GitHub.com's source code is proprietary and not available.** We cannot copy it. We can copy its *product behaviour*: pages, flows, URL shapes, data model ideas, REST resource shapes.
2. **Open-source code we may reuse, with licence compliance:**
   - Gitea (MIT): reference for schema, permissions, PR/merge logic, UI flows. MIT allows copying with the licence notice kept.
   - Forgejo (GPL-3.0 since v9) and GitLab CE (MIT for the CE core): reference only. Do not paste GPL code into an MIT or proprietary codebase.
   - Libraries: `isomorphic-git` or native `git` binary, `shiki` (syntax highlighting), `diff2html` / `react-diff-view`, `markdown-it` + `rehype-sanitize`, `@octokit`-compatible response shapes for tool compatibility.
3. **Decision: build our own TypeScript platform, reusing OSS libraries, and borrow schema and flow ideas from Gitea.** Reasons: the Dithub SDK, SIWE login, ENS role gating and Arkiv sync are all TypeScript, and forking Gitea (Go) would put every web3 integration in a foreign codebase.
4. **Honest effort note.** GitHub parity is years of work. This plan targets a *collaborative-coding MVP* (Phase 1 to 3 in section 12) and lists the long tail explicitly as later phases.
5. **Web2 versus web3 split.** About 80% of the work is ordinary web2: accounts, repos, issues, PRs, search, notifications, infra. Web3 is a layer on top:
   - Wallet login (SIWE).
   - ENS role seats gating who may push.
   - Every push, commit and PR mirrored to Arkiv and anchored on L1.
   - Arkiv as the recovery source for the database.

## 1. Architecture

```
                         Caddy / Traefik (TLS, HTTP/3, rate limit)
                                       |
        +------------------------------+-------------------------------+
        |                              |                               |
     web (Next.js)                api (Hono/Fastify)             git-http (smart HTTP + SSH)
     SSR + client                REST + WebSocket                git-http-backend, pre/post-receive hooks
        |                              |                               |
        +------------+-----------------+---------------+---------------+
                     |                                 |
                 PostgreSQL 16  <----- outbox ----->  worker (BullMQ)
                 (source of truth for web2)             - web3-sync: Arkiv, L1 anchor, ENS seat mirror
                     |                                  - search indexer
                  Redis 7                               - notifications / email / webhooks
                  (queues, cache, sessions, rate)       - repo maintenance (gc, mirror, archive)
                     |
        +------------+-------------+-----------------+-------------------+
        |                          |                 |                   |
   MinIO / S3                Meilisearch         Mailpit (dev)      Anvil (dev chain)
   (git packs, LFS,          (code + issue       SMTP (prod)        Arkiv Rabdi (live)
    attachments, archives)    search)                               Sepolia (live)
```

**Principle:** PostgreSQL is the working database for the web app. Arkiv plus L1 is the verifiable ledger. The outbox pattern makes the ledger eventually consistent with the database, and the indexer can rebuild the database from Arkiv if it is lost.

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, Bun for dev and scripts | Matches the existing SDK. |
| Web | Next.js (App Router), React, Tailwind, shadcn/ui | Fast to build a GitHub-like UI. |
| API | Hono (or Fastify) with Zod schemas, OpenAPI generated | Typed, small, fast. |
| DB | Superseded: one SQLite file (WAL) as a rebuildable local index; Arkiv holds metadata and Swarm holds repo bytes (see README "Storage" and `docs/swarm-arkiv-design.md`). Originally PostgreSQL 16. | No database server to run; the index can be rebuilt from Arkiv + Swarm. |
| Cache / queue | Redis 7, BullMQ | Standard and simple. |
| Object storage | S3 API: MinIO in dev, S3 or R2 in prod | Packs, LFS, attachments, archives. |
| Search | Meilisearch (start), OpenSearch if scale demands | Easy ops. Code search via trigram indexes in Postgres for the MVP. |
| Git engine | Native `git` binary behind a service, bare repos on a volume, packs mirrored to S3 | Correctness and compatibility beat a pure-JS Git. |
| Auth | SIWE (EIP-4361) with passkeys and email magic link as optional extras | Wallet login is the product's identity. |
| Real-time | WebSocket from the API (SSE fallback) | Live PR and issue updates. |
| Observability | OpenTelemetry, Prometheus, Grafana, Loki, Sentry | Production grade. |
| Chain tooling | viem, Foundry, `@arkiv-network/sdk` | Already in use. |

## 3. Infrastructure

### 3.1 Containers (one repo, `infra/` directory)

| Service | Image | Notes |
|---|---|---|
| `web` | custom (multi-stage, distroless) | Next.js standalone output. |
| `api` | custom | Stateless, horizontally scalable. |
| `git` | custom (git + OpenSSH + hooks) | Smart HTTP and SSH. Volume `/data/repos`. |
| `worker` | custom | BullMQ consumers. Scaled independently. |
| `bee` | `ethersphere/bee` | Swarm node (dev mode locally, light node in prod). Replaces the planned `postgres` service. |
| `redis` | `redis:7` | AOF on, password required. |
| `minio` | `minio/minio` | Dev only. Prod uses managed S3. |
| `meilisearch` | `getmeili/meilisearch` | Master key from secrets. |
| `caddy` | `caddy:2` | Automatic TLS, rate limits, security headers. |
| `mailpit` | `axllent/mailpit` | Dev email sink. |
| `anvil` | `ghcr.io/foundry-rs/foundry` | Dev L1. |
| `otel-collector`, `prometheus`, `grafana`, `loki` | official | Observability stack. |

### 3.2 Environments

- **dev:** `docker compose up` brings everything up with seeded data and Anvil. One command: `make dev`.
- **ci:** GitHub Actions: typecheck, unit tests, integration tests against compose services, contract tests (`forge`), container build, Trivy image scan, Playwright end-to-end.
- **staging:** compose or a small Kubernetes cluster, Sepolia and Rabdi.
- **production:** Kubernetes (Helm chart) or Nomad/Fly. Managed Postgres, managed Redis, S3. Decision needed from the user (section 14).

### 3.3 Production hardening

- Secrets from a secret manager (SOPS or Vault). Never in the repo or images. Signing keys never touch the web tier.
- Non-root containers, read-only root filesystem, dropped capabilities, resource limits, health and readiness probes.
- Network policy: only `caddy` is public. The database and Redis are on a private network.
- Backups: Postgres PITR (WAL archiving to S3), nightly base backups, restore drill monthly, object-store versioning, repo volume snapshots.
- Rate limiting at the edge and per user in the API. Abuse controls on repo creation and pushes.
- Zero-downtime deploys: rolling updates, expand/contract migrations.
- Disaster recovery: the Arkiv indexer rebuilds repos, refs and activity. RPO and RTO targets are listed in section 11.

## 4. Data model (PostgreSQL)

Conventions: `bigint` identity primary keys, `uuid` public ids where exposed, `timestamptz`, soft delete via `deleted_at` where history matters, every user-facing table has `created_at` and `updated_at`.

### 4.1 Identity

```sql
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login         citext UNIQUE NOT NULL,            -- username, 1..39 chars [a-z0-9-]
  display_name  text,
  email         citext UNIQUE,                     -- optional, verified separately
  email_verified_at timestamptz,
  avatar_url    text,
  bio           text,
  is_site_admin boolean NOT NULL DEFAULT false,
  suspended_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallets (                              -- one user, many wallets
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address     bytea NOT NULL UNIQUE CHECK (length(address) = 20),
  ens_name    text,                                -- cached, verified against L1
  is_primary  boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  user_agent  text, ip inet,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE siwe_nonces (nonce text PRIMARY KEY, expires_at timestamptz NOT NULL, used_at timestamptz);

CREATE TABLE access_tokens (                        -- personal access tokens
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, token_hash bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL, last_used_at timestamptz, expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);

CREATE TABLE ssh_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL, public_key text NOT NULL, fingerprint text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
```

### 4.2 Organisations and teams

```sql
CREATE TABLE orgs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login citext UNIQUE NOT NULL,                    -- shares the namespace with users (enforced by trigger)
  display_name text, description text, avatar_url text,
  ens_name text,                                   -- e.g. dithuborg2644.eth, the org's seat registry name
  ens_registry bytea,                              -- UserRegistry address (seats)
  ref_registry bytea,                              -- RefRegistry address (L1 anchor)
  chain_id integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id bigint REFERENCES orgs(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','member')),
  seat_status text NOT NULL DEFAULT 'none'
    CHECK (seat_status IN ('none','pending','granted','revoked')),   -- mirrors the ENS role on L1
  seat_tx bytea,                                   -- L1 transaction that granted the seat
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE teams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug citext NOT NULL, name text NOT NULL, description text,
  parent_team_id bigint REFERENCES teams(id),
  UNIQUE (org_id, slug)
);
CREATE TABLE team_members (team_id bigint REFERENCES teams(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, user_id));
```

### 4.3 Repositories

```sql
CREATE TYPE owner_kind AS ENUM ('user','org');
CREATE TYPE visibility AS ENUM ('public','private','internal');

CREATE TABLE repos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dheet_repo_id bytea UNIQUE NOT NULL CHECK (length(dheet_repo_id) = 32),   -- protocol repoId
  owner_kind owner_kind NOT NULL, owner_id bigint NOT NULL,
  name citext NOT NULL,                                                      -- human name, mapped to repoId
  description text, website text, topics text[] NOT NULL DEFAULT '{}',
  visibility visibility NOT NULL DEFAULT 'public',
  default_branch text NOT NULL DEFAULT 'main',
  git_object_format text NOT NULL DEFAULT 'sha1' CHECK (git_object_format IN ('sha1','sha256')),
  fork_of bigint REFERENCES repos(id),
  is_archived boolean NOT NULL DEFAULT false, is_template boolean NOT NULL DEFAULT false,
  has_issues boolean NOT NULL DEFAULT true, has_wiki boolean NOT NULL DEFAULT false,
  size_bytes bigint NOT NULL DEFAULT 0,
  stars_count integer NOT NULL DEFAULT 0, forks_count integer NOT NULL DEFAULT 0,
  pushed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (owner_kind, owner_id, name)
);

CREATE TABLE repo_collaborators (
  repo_id bigint REFERENCES repos(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read','triage','write','maintain','admin')),
  PRIMARY KEY (repo_id, user_id)
);
CREATE TABLE repo_team_access (repo_id bigint REFERENCES repos(id) ON DELETE CASCADE,
  team_id bigint REFERENCES teams(id) ON DELETE CASCADE,
  permission text NOT NULL, PRIMARY KEY (repo_id, team_id));

CREATE TABLE stars (user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  repo_id bigint REFERENCES repos(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_id));
CREATE TABLE watches (user_id bigint, repo_id bigint, level text NOT NULL DEFAULT 'participating',
  PRIMARY KEY (user_id, repo_id));

CREATE TABLE branch_protections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pattern text NOT NULL, require_pr boolean NOT NULL DEFAULT true,
  required_approvals smallint NOT NULL DEFAULT 1, require_status_checks text[] NOT NULL DEFAULT '{}',
  allow_force_push boolean NOT NULL DEFAULT false, allow_deletions boolean NOT NULL DEFAULT false,
  require_signed_commits boolean NOT NULL DEFAULT false, UNIQUE (repo_id, pattern)
);

CREATE TABLE repo_storage (                                   -- where the bytes live
  repo_id bigint PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  disk_path text NOT NULL, s3_prefix text NOT NULL,
  last_gc_at timestamptz, last_mirror_at timestamptz
);
```

### 4.4 Git metadata cache (derived, rebuildable from the bare repo)

```sql
CREATE TABLE git_refs (
  repo_id bigint REFERENCES repos(id) ON DELETE CASCADE,
  name text NOT NULL,                                        -- refs/heads/main
  oid bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE commits (
  repo_id bigint REFERENCES repos(id) ON DELETE CASCADE,
  oid bytea NOT NULL,                                        -- git OID (20 or 32 bytes)
  dheet_oid bytea,                                           -- SHA-256 Dithub OID
  tree_oid bytea NOT NULL, parent_oids bytea[] NOT NULL,
  author_name text, author_email text, author_user_id bigint REFERENCES users(id),
  authored_at timestamptz NOT NULL, committed_at timestamptz NOT NULL,
  message text NOT NULL, subject text NOT NULL,              -- first line, indexed
  signature_status text,                                     -- none | valid | invalid
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX ON commits (repo_id, committed_at DESC);
CREATE INDEX ON commits USING gin (to_tsvector('simple', subject));

CREATE TABLE commit_anchors (                                -- the "commit <-> transaction" mapping
  repo_id bigint NOT NULL, commit_oid bytea NOT NULL,
  push_id bigint NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  ref_name text NOT NULL,
  l1_chain_id integer, l1_tx bytea, l1_block bigint, ref_sequence bigint,
  arkiv_tx bytea, arkiv_entity bytea,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','arkiv_done','anchored','failed')),
  PRIMARY KEY (repo_id, commit_oid, ref_name),
  FOREIGN KEY (repo_id, commit_oid) REFERENCES commits(repo_id, oid) ON DELETE CASCADE
);

CREATE TABLE pushes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pusher_id bigint REFERENCES users(id), pusher_wallet bytea,
  ref_name text NOT NULL, old_oid bytea, new_oid bytea, forced boolean NOT NULL DEFAULT false,
  manifest_hash bytea, created_at timestamptz NOT NULL DEFAULT now()
);
```

Files are not rows. File content is served from the Git object store (bare repo plus S3 packs). A small `tree_entries_cache` (Redis, keyed by tree oid) accelerates the code browser.

### 4.5 Issues, labels, milestones

```sql
CREATE TABLE issues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number integer NOT NULL,                                  -- per-repo sequence, shared with PRs
  author_id bigint REFERENCES users(id), title text NOT NULL, body text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  state_reason text CHECK (state_reason IN ('completed','not_planned','reopened')),
  milestone_id bigint, locked boolean NOT NULL DEFAULT false,
  comments_count integer NOT NULL DEFAULT 0,
  closed_at timestamptz, closed_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'')||' '||coalesce(body,''))) STORED,
  UNIQUE (repo_id, number)
);
CREATE INDEX ON issues USING gin (search);
CREATE INDEX ON issues (repo_id, state, updated_at DESC);

CREATE TABLE issue_assignees (issue_id bigint REFERENCES issues(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id), PRIMARY KEY (issue_id, user_id));
CREATE TABLE labels (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name text NOT NULL, color char(6) NOT NULL, description text, UNIQUE (repo_id, name));
CREATE TABLE issue_labels (issue_id bigint REFERENCES issues(id) ON DELETE CASCADE,
  label_id bigint REFERENCES labels(id) ON DELETE CASCADE, PRIMARY KEY (issue_id, label_id));
CREATE TABLE milestones (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE, title text NOT NULL,
  description text, due_on timestamptz, state text NOT NULL DEFAULT 'open', UNIQUE (repo_id, title));

CREATE TABLE comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,   -- issue or PR thread
  author_id bigint REFERENCES users(id), body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE reactions (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id), subject_type text NOT NULL, subject_id bigint NOT NULL,
  content text NOT NULL, UNIQUE (user_id, subject_type, subject_id, content));
CREATE TABLE issue_events (                                        -- timeline: labeled, assigned, closed, referenced...
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id bigint REFERENCES users(id), event text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 4.6 Pull requests and reviews

```sql
CREATE TABLE pull_requests (
  issue_id bigint PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,   -- shares number/comments/labels
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  head_repo_id bigint REFERENCES repos(id), head_ref text NOT NULL, head_oid bytea NOT NULL,
  base_ref text NOT NULL, base_oid bytea NOT NULL, merge_base_oid bytea,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
  draft boolean NOT NULL DEFAULT false, mergeable text CHECK (mergeable IN ('clean','conflict','unknown')),
  merge_method text CHECK (merge_method IN ('merge','squash','rebase')),
  merged_by bigint REFERENCES users(id), merged_at timestamptz, merge_commit_oid bytea,
  additions integer, deletions integer, changed_files integer
);
CREATE TABLE reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pr_issue_id bigint NOT NULL REFERENCES pull_requests(issue_id) ON DELETE CASCADE,
  author_id bigint NOT NULL REFERENCES users(id), commit_oid bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','commented','approved','changes_requested','dismissed')),
  body text, signature bytea,                                  -- EIP-712 signed review (web3 evidence)
  submitted_at timestamptz
);
CREATE TABLE review_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id bigint REFERENCES reviews(id) ON DELETE CASCADE,
  pr_issue_id bigint NOT NULL, author_id bigint NOT NULL, commit_oid bytea NOT NULL,
  path text NOT NULL, side text CHECK (side IN ('LEFT','RIGHT')), line integer, start_line integer,
  in_reply_to bigint REFERENCES review_comments(id), body text NOT NULL, resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE review_requests (pr_issue_id bigint REFERENCES pull_requests(issue_id) ON DELETE CASCADE,
  user_id bigint, team_id bigint, requested_by bigint, PRIMARY KEY (pr_issue_id, user_id));
CREATE TABLE check_runs (                                      -- CI and bots
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL, head_oid bytea NOT NULL, name text NOT NULL,
  status text NOT NULL, conclusion text, details_url text, output jsonb,
  started_at timestamptz, completed_at timestamptz
);
```

### 4.7 Releases, webhooks, notifications, audit, search

```sql
CREATE TABLE releases (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE, tag_name text NOT NULL,
  target_oid bytea NOT NULL, name text, body text, draft boolean DEFAULT false, prerelease boolean DEFAULT false,
  author_id bigint REFERENCES users(id), published_at timestamptz, UNIQUE (repo_id, tag_name));
CREATE TABLE release_assets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id bigint NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  name text NOT NULL, s3_key text NOT NULL, size_bytes bigint NOT NULL, content_type text, sha256 bytea NOT NULL);

CREATE TABLE webhooks (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint, org_id bigint, url text NOT NULL, secret_hash bytea NOT NULL,
  events text[] NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE webhook_deliveries (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id bigint NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event text NOT NULL,
  payload jsonb NOT NULL, status_code integer, response_ms integer, attempt smallint NOT NULL DEFAULT 1,
  delivered_at timestamptz);

CREATE TABLE notifications (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, repo_id bigint,
  reason text NOT NULL, subject_type text NOT NULL, subject_id bigint NOT NULL,
  unread boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz);
CREATE INDEX ON notifications (user_id, unread, created_at DESC);

CREATE TABLE audit_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id bigint, actor_wallet bytea, action text NOT NULL, target_type text, target_id bigint,
  ip inet, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE activity (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,      -- feed, one row per user-visible event
  repo_id bigint, actor_id bigint, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
```

### 4.8 Web3 sync tables (the bridge)

```sql
CREATE TABLE outbox (                                                -- transactional outbox, written in the same txn as the change
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL, aggregate_id bigint NOT NULL,
  kind text NOT NULL,            -- push | commit | pr | review | issue | comment | release | name_claim | seat_grant | seat_revoke
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','dead')),
  attempts smallint NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text, created_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz
);
CREATE INDEX ON outbox (status, next_attempt_at);

CREATE TABLE arkiv_entities (                                        -- every entity we wrote, for renewal and rebuild
  entity_key bytea PRIMARY KEY, schema text NOT NULL, repo_id bigint, outbox_id bigint REFERENCES outbox(id),
  tx_hash bytea NOT NULL, expires_at_block bigint NOT NULL, last_extended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON arkiv_entities (expires_at_block);                   -- drives the renewal worker

CREATE TABLE chain_anchors (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id), ref_name text NOT NULL, chain_id integer NOT NULL,
  contract bytea NOT NULL, tx_hash bytea NOT NULL, block_number bigint, ref_sequence bigint NOT NULL,
  ref_root bytea NOT NULL, writer bytea NOT NULL, finalized boolean NOT NULL DEFAULT false);

CREATE TABLE ens_seats (org_id bigint REFERENCES orgs(id), address bytea NOT NULL,
  role_bitmap numeric NOT NULL, block_number bigint NOT NULL, tx_hash bytea NOT NULL,
  PRIMARY KEY (org_id, address));                                    -- mirror of ENS EAC events, verified against L1 before use
CREATE TABLE name_claims (name citext PRIMARY KEY, dheet_repo_id bytea NOT NULL,
  claimant bytea NOT NULL, arkiv_entity bytea, claimed_at timestamptz NOT NULL DEFAULT now());
```

### 4.9 Arkiv data model (the ledger, mirrors the database)

| Arkiv schema | Key attributes (indexed) | Purpose |
|---|---|---|
| `dheet-manifest-v1` | repo, seq, oid, packHash, objectRoot | Already built. Pack manifests. |
| `dheet-chunk-v1` | repo, oid, chunkHash | Already built. Content chunks (code files live here). |
| `dheet-activity-v1` | repo, kind, seq, actor, commitOid, refName, l1Tx, manifestHash, title | One entity per push, commit, PR, review, issue, comment, release. Carries the commit subject and the transaction hashes. |
| `dheet-name-v1` | name, repo, owner, ctime | `repo name -> repoId`. First valid claim wins. Clients verify the owner against L1. |
| `dheet-seat-v1` | org, account, roleBitmap, block | Mirror of ENS seats (hint only). |

**Trust rule:** anything read from Arkiv is a hint until verified. Content is hash-checked. Permissions and the latest ref are verified against L1.

## 5. Git layer

- One bare repo per repository at `/data/repos/<shard>/<repoId>.git`. Packs are mirrored to S3 after push and gc.
- **Smart HTTP** via `git http-backend` behind the `git` service, authenticated with PATs or a SIWE-signed token. **SSH** via a managed `sshd` with `AuthorizedKeysCommand` hitting the API.
- **Hooks (the key integration points):**
  - `pre-receive`: asks the API "may this identity update this ref?". The API checks repo permission, branch protection, and, for orgs with an ENS gate, the on-chain ENS seat. Rejects with a clear message.
  - `post-receive`: writes the `pushes`, `commits` and `commit_anchors` rows plus an outbox entry, in one transaction. The push returns immediately and the chain work happens asynchronously.
- **Per-commit transaction mapping:** each pushed commit gets one `commit_anchors` row. The worker publishes an `activity` entity per commit to Arkiv (subject, author, ref, commit oid) and anchors the ref on L1. When both transactions land, the row records `arkiv_tx` and `l1_tx`. The UI shows the transaction hashes beside every commit.
- **Pull and clone are reads, not transactions.** There is nothing to anchor. Optional signed "pull receipts" can be logged as activity for audit, off by default (high volume, low value).
- **Merge engine:** run `git merge-tree` / `git merge` in a temporary worktree for the three strategies (merge, squash, rebase). Conflict detection runs in the worker and sets `mergeable`.
- **Code browser:** `git ls-tree`, `git cat-file`, `git log`, `git diff` through a pooled `git cat-file --batch` process, with a Redis cache keyed by oid. Syntax highlighting with Shiki. Binary and large-file guards.
- **LFS:** S3-backed LFS server (Phase 4).

## 6. Authentication and authorisation

- **Login:** SIWE (EIP-4361) with a server-issued nonce (`siwe_nonces`), domain binding, expiry and replay protection. Supports EOAs and EIP-1271 contract wallets. Result: an httpOnly, SameSite session cookie plus CSRF token.
- **Account model:** a user may link several wallets. ENS reverse resolution fills `ens_name` and is verified, never trusted blindly.
- **Optional:** passkeys (WebAuthn) and email magic links for non-crypto collaborators who push over HTTPS with PATs.
- **Authorisation order:** site admin, then owner, then org role, then team grant, then collaborator grant, then visibility. Org repos with an ENS gate also require an on-chain seat for **ref updates**. Web2 permissions control everything else (issues, comments, reviews).
- **Signing:** PR reviews and releases can carry an EIP-712 signature (reusing the existing collaboration record format) for tamper-evident evidence.

## 7. API surface (REST, OpenAPI generated)

Shapes follow the GitHub REST API where practical, so existing tooling mostly works.

- Auth: `POST /auth/siwe/nonce`, `POST /auth/siwe/verify`, `POST /auth/logout`, `GET /user`
- Users and orgs: `/users/:login`, `/orgs/:org`, `/orgs/:org/members`, `/orgs/:org/teams`
- Repos: `POST /user/repos`, `POST /orgs/:org/repos`, `GET/PATCH/DELETE /repos/:owner/:repo`, forks, stars, collaborators, topics
- Git data: `/repos/:o/:r/branches`, `/commits`, `/commits/:ref`, `/contents/*path`, `/compare/:base...:head`, `/git/trees`, `/tarball`, `/zipball`
- Issues: CRUD, comments, labels, milestones, assignees, reactions, timeline
- Pulls: CRUD, `/files`, `/commits`, `/merge`, `/reviews`, `/comments`, `/requested_reviewers`
- Releases, webhooks, notifications, search (`/search/repositories|code|issues|users`)
- Web3: `GET /repos/:o/:r/commits/:sha/anchors`, `GET /repos/:o/:r/activity`, `GET /names/:name`, `POST /orgs/:org/seats`
- Real-time: WebSocket channel per repo and per user for PR, issue and notification events.

## 8. Web app (pages)

Home and feed, explore, search, sign-in with wallet, user profile, org page and teams, new repo, repo overview (README, file tree, branches, tags), file viewer and blame, commit list and commit detail (with transaction hashes), compare, issues list and detail, PR list, PR detail (conversation, commits, files changed, checks), merge box, settings (repo, org, branch protection, webhooks, collaborators, ENS seats), notifications, releases, activity ledger page (the on-chain view), and a "verify this repo" page that clones from Arkiv and checks hashes in the browser.

## 9. Web3 sync worker (outbox consumer)

1. Claim a batch of `outbox` rows with `FOR UPDATE SKIP LOCKED`.
2. Build the entity: activity, name claim, seat mirror, manifest and chunks (pushes only).
3. Write to Arkiv (idempotent: the predicted entity key is derived from the outbox id, so retries do not duplicate), record in `arkiv_entities`.
4. For ref updates on org repos: submit the L1 `updateRef` transaction, wait for confirmations, record in `chain_anchors`. Writes use a relayer account holding the `WRITER` seat, or the user's own wallet for direct flows.
5. Update `commit_anchors.status`.
6. Backoff with jitter on failure, dead-letter after N attempts, alert on queue age.
7. **Renewal worker:** scans `arkiv_entities` by `expires_at_block` and extends with permissionless extension before the 182.5-day cap.
8. **Rebuild tool:** replays Arkiv into an empty Postgres to prove the ledger is sufficient for recovery. It is run in CI against a seeded dataset.

## 10. Security

- OWASP ASVS L2 checklist; strict CSP, HSTS, SameSite cookies, CSRF tokens, output sanitisation on all Markdown (`rehype-sanitize`), no inline HTML from users.
- Git-specific: path traversal checks, symlink handling, object-size and push-size limits, protection against zip bombs and pathological diffs, per-repo resource quotas, sandbox for any server-side git processing (read-only, no network, seccomp).
- Secrets and keys: relayer key in a KMS or HSM-backed signer with spend limits. The web tier never sees it.
- Rate limits and abuse controls; email and wallet verification; spam detection hooks.
- Supply chain: pinned dependencies, lockfiles, SBOM, Trivy and `bun audit` in CI, signed images.
- Smart contracts: independent audit before mainnet (already a gate in `docs/implementation-status.md`).
- Privacy: private repos are encrypted before they reach Arkiv (existing XChaCha20-Poly1305 primitives). Private repo metadata is not mirrored to the public ledger.

## 11. Reliability targets and testing

- **SLOs:** API p95 under 300 ms, git clone start under 2 s, availability 99.9%. **RPO:** 5 minutes (WAL archiving). **RTO:** 1 hour from backup, 4 hours rebuild from Arkiv.
- **Tests:** unit (Bun), API integration against real Postgres/Redis in compose, contract tests (Foundry), Playwright end-to-end for the core flows (login, create repo, push, PR, merge), a git-compatibility suite (clone, fetch, push, large repos, force push), load tests (k6) for clone and API, chaos tests (kill worker, drop RPC) to prove the outbox recovers.

## 12. Phases and milestones

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Infra: monorepo layout, `docker compose`, CI, migrations, observability skeleton | `make dev` gives a healthy empty stack in one command; CI green. |
| 1 | Accounts and repos: SIWE login, users, orgs, create repo, name -> repoId map, git smart HTTP, `pre/post-receive`, code browser, commit views | Push and clone over HTTPS with a wallet-issued token; files browsable. |
| 2 | Web3 bridge: outbox worker, per-commit Arkiv activity and L1 anchor, ENS seat gate at `pre-receive`, ledger page showing tx hashes, renewal worker | Every pushed commit shows its Arkiv and L1 transaction; unseated pushers are rejected. |
| 3 | Collaboration: issues, labels, milestones, comments, reactions, PRs with diff, reviews, merge (3 strategies), branch protection, notifications, search | A full issue-to-merged-PR flow in the browser. |
| 4 | Ecosystem: webhooks, releases and assets, forks, LFS, CI check API, API tokens, import from GitHub | Third-party CI can report checks. |
| 5 | Hardening and launch: audit, load tests, DR drill, rebuild-from-Arkiv drill, docs | All SLO and DR targets demonstrated. |

**Parity long tail, explicitly not in scope until after Phase 5:** Actions-style CI runner, Packages registry, Pages, Projects boards, Discussions, Codespaces, Dependabot-style bots, code scanning, wiki, SAML SSO.

## 13. Repository layout

```
apps/web         Next.js app
apps/api         Hono API
apps/git         git service (http-backend, sshd, hooks)
apps/worker      BullMQ workers (web3 sync, search, notifications, webhooks, maintenance)
packages/db      Drizzle schema, migrations, seeds
packages/sdk     existing Dithub protocol SDK (kept)
packages/contracts  existing Solidity (kept)
packages/shared  zod schemas, types, permission logic
infra/           docker, compose, Caddyfile, Helm chart, Grafana dashboards, backup scripts
docs/            ADRs, runbooks, API reference
```

The existing `packages/cli`, `remote-helper`, `indexer` and `web` stay for the protocol-level tooling. The new `apps/*` become the product.

## 14. Decisions needed from you before implementation

1. **Production target:** Kubernetes (Helm), or a simpler compose-on-VM deployment to start? My default: compose on one VM for staging, Helm for production.
2. **Cloud:** which provider and region for managed Postgres, Redis and S3?
3. **Domain and email provider** for TLS and transactional mail.
4. **Who pays on-chain gas for pushes?** Default: a relayer account paid by the platform, with users able to sign their own transactions instead.
5. **Public versus private repos on Arkiv:** default is public code on Arkiv and private repos encrypted, with metadata kept off the public ledger.
6. **Chain for production anchoring:** Sepolia is used now. The production chain is an open decision, and the ENS seat gate requires the chain that runs ENSv2.
7. **Scope check:** accept Phases 0 to 3 as the first release, with Phase 4 and later after launch.

## 15. Risks

- **Scale of the build.** The GitHub surface is huge. Mitigation: strict phases, reuse of OSS libraries, and Gitea as a behavioural reference.
- **Arkiv is a testnet with no permanent storage.** Mitigation: Postgres plus S3 is the primary store, Arkiv is the verifiable mirror, renewal worker, cold archives.
- **Chain cost and latency on every commit.** Mitigation: batch anchoring per push (one L1 transaction per ref update, not per commit), per-commit Arkiv entities batched into one `execute()` call.
- **Eventual consistency between database and ledger.** Mitigation: outbox, idempotent writes, visible "pending/anchored" state in the UI.
- **Permission drift between ENS seats and web2 roles.** Mitigation: L1 is authoritative for ref updates, the database mirror is a hint, and a reconciliation job flags mismatches.
