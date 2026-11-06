-- Dheet platform schema v1 (generated from PLATFORM_PLAN.md section 4)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

CREATE TABLE orgs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login citext UNIQUE NOT NULL,                    -- shares the namespace with users (enforced by trigger)
  display_name text, description text, avatar_url text,
  ens_name text,                                   -- e.g. dheetorg2644.eth, the org's seat registry name
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

CREATE TABLE git_refs (
  repo_id bigint REFERENCES repos(id) ON DELETE CASCADE,
  name text NOT NULL,                                        -- refs/heads/main
  oid bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE commits (
  repo_id bigint REFERENCES repos(id) ON DELETE CASCADE,
  oid bytea NOT NULL,                                        -- git OID (20 or 32 bytes)
  dheet_oid bytea,                                           -- SHA-256 Dheet OID
  tree_oid bytea NOT NULL, parent_oids bytea[] NOT NULL,
  author_name text, author_email text, author_user_id bigint REFERENCES users(id),
  authored_at timestamptz NOT NULL, committed_at timestamptz NOT NULL,
  message text NOT NULL, subject text NOT NULL,              -- first line, indexed
  signature_status text,                                     -- none | valid | invalid
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX ON commits (repo_id, committed_at DESC);
CREATE INDEX ON commits USING gin (to_tsvector('simple', subject));

CREATE TABLE pushes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pusher_id bigint REFERENCES users(id), pusher_wallet bytea,
  ref_name text NOT NULL, old_oid bytea, new_oid bytea, forced boolean NOT NULL DEFAULT false,
  manifest_hash bytea, created_at timestamptz NOT NULL DEFAULT now()
);

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
