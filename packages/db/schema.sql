-- Dithub local read index, SQLite dialect. Consolidated final state of postgres-legacy/0001..0011,
-- plus the swarm-arkiv contract (stateless sessions, device keys, sealed repo keys, swarm uploads).
-- Rules: bytea -> BLOB, timestamptz -> TEXT ISO-8601 UTC, jsonb and text[] -> TEXT holding JSON,
-- boolean -> INTEGER 0/1, uuid -> TEXT, citext -> TEXT COLLATE NOCASE, enums -> TEXT CHECK.
-- Dropped pg-only features: citext/pgcrypto/pg_trgm extensions, the tsvector column on issues and the
-- GIN full-text indexes on issues/commits (search uses LIKE), the `sessions` table (sessions are signed tokens now).
-- New changes go in migrations-sqlite/NNNN_name.sql, not here.

CREATE TABLE users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  login             TEXT COLLATE NOCASE UNIQUE NOT NULL,   -- username, 1..39 chars [a-z0-9-]
  display_name      TEXT,
  email             TEXT COLLATE NOCASE UNIQUE,
  email_verified_at TEXT,
  avatar_url        TEXT,
  bio               TEXT,
  is_site_admin     INTEGER NOT NULL DEFAULT 0,
  suspended_at      TEXT,
  token_version     INTEGER NOT NULL DEFAULT 0,             -- bump to revoke every session token
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE wallets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address     BLOB NOT NULL UNIQUE CHECK (length(address) = 20),
  ens_name    TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX wallets_user ON wallets (user_id);

CREATE TABLE siwe_nonces (nonce TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);

CREATE TABLE access_tokens (                               -- personal access tokens, stored hashed
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   BLOB NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '[]',                 -- JSON array of strings
  last_used_at TEXT,
  expires_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at   TEXT
);
CREATE INDEX access_tokens_user ON access_tokens (user_id);

CREATE TABLE ssh_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  public_key   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);

-- X25519 device keys registered by a wallet (mirror of dheet-devicekey-v1 on Arkiv).
CREATE TABLE device_keys (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL UNIQUE,
  signature  BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX device_keys_user ON device_keys (user_id);

CREATE TABLE orgs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  login        TEXT COLLATE NOCASE UNIQUE NOT NULL,         -- shares the namespace with users (checked by the API)
  display_name TEXT,
  description  TEXT,
  avatar_url   TEXT,
  ref_registry BLOB,                                       -- RefRegistry address (L1 anchor)
  chain_id     INTEGER,
  visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  rbac_head    BLOB,                                       -- hash of the latest rbac event
  rbac_seq     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE org_members (
  org_id  INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('owner','member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug           TEXT COLLATE NOCASE NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  parent_team_id INTEGER REFERENCES teams(id),
  UNIQUE (org_id, slug)
);
CREATE TABLE team_members (
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE rbac_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  actor_id     INTEGER REFERENCES users(id),
  actor_login  TEXT NOT NULL,
  action       TEXT NOT NULL,                              -- member.add, member.remove, team.*, collaborator.*, protection.*
  payload      TEXT NOT NULL,                              -- JSON
  prev_hash    BLOB,
  hash         BLOB NOT NULL,                              -- sha256(prev_hash || canonical json of the event)
  public       INTEGER NOT NULL,                           -- 1: mirrored to Arkiv; 0: local only
  arkiv_entity BLOB,
  arkiv_tx     BLOB,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, seq)
);
CREATE INDEX rbac_events_org ON rbac_events (org_id, seq DESC);

CREATE TABLE repos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dheet_repo_id     BLOB UNIQUE NOT NULL CHECK (length(dheet_repo_id) = 32),
  owner_kind        TEXT NOT NULL CHECK (owner_kind IN ('user','org')),
  owner_id          INTEGER NOT NULL,
  name              TEXT COLLATE NOCASE NOT NULL,
  description       TEXT,
  website           TEXT,
  topics            TEXT NOT NULL DEFAULT '[]',            -- JSON array of strings
  visibility        TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','internal')),
  default_branch    TEXT NOT NULL DEFAULT 'main',
  git_object_format TEXT NOT NULL DEFAULT 'sha1' CHECK (git_object_format IN ('sha1','sha256')),
  fork_of           INTEGER REFERENCES repos(id),
  is_archived       INTEGER NOT NULL DEFAULT 0,
  is_template       INTEGER NOT NULL DEFAULT 0,
  has_issues        INTEGER NOT NULL DEFAULT 1,
  has_wiki          INTEGER NOT NULL DEFAULT 0,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  stars_count       INTEGER NOT NULL DEFAULT 0,
  forks_count       INTEGER NOT NULL DEFAULT 0,
  pushed_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT,
  UNIQUE (owner_kind, owner_id, name)
);

-- Private repo content keys, sealed to the server's device key, one row per epoch.
CREATE TABLE repo_keys (
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  epoch      INTEGER NOT NULL,
  sealed     BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (repo_id, epoch)
);

CREATE TABLE repo_counters (                               -- per-repo number shared by issues and PRs
  repo_id     INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE repo_collaborators (
  repo_id    INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read','triage','write','maintain','admin')),
  PRIMARY KEY (repo_id, user_id)
);
CREATE TABLE repo_team_access (
  repo_id    INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (repo_id, team_id)
);

CREATE TABLE stars (
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  repo_id    INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, repo_id)
);
CREATE TABLE watches (
  user_id INTEGER,
  repo_id INTEGER,
  level   TEXT NOT NULL DEFAULT 'participating',
  PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE branch_protections (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id                INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pattern                TEXT NOT NULL,
  require_pr             INTEGER NOT NULL DEFAULT 1,
  required_approvals     INTEGER NOT NULL DEFAULT 1,
  require_status_checks  TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  allow_force_push       INTEGER NOT NULL DEFAULT 0,
  allow_deletions        INTEGER NOT NULL DEFAULT 0,
  require_signed_commits INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo_id, pattern)
);

CREATE TABLE repo_storage (
  repo_id        INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  disk_path      TEXT NOT NULL,
  s3_prefix      TEXT NOT NULL,
  last_gc_at     TEXT,
  last_mirror_at TEXT
);

CREATE TABLE git_refs (
  repo_id    INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  oid        BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE commits (
  repo_id          INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  oid              BLOB NOT NULL,
  dheet_oid        BLOB,
  tree_oid         BLOB NOT NULL,
  parent_oids      TEXT NOT NULL DEFAULT '[]',             -- JSON array of hex strings (was bytea[])
  author_name      TEXT,
  author_email     TEXT,
  author_user_id   INTEGER REFERENCES users(id),
  authored_at      TEXT NOT NULL,
  committed_at     TEXT NOT NULL,
  message          TEXT NOT NULL,
  subject          TEXT NOT NULL,
  signature_status TEXT,                                   -- none | valid | invalid
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX commits_repo_committed ON commits (repo_id, committed_at DESC);
-- (pg GIN to_tsvector index on subject dropped; search with LIKE)

CREATE TABLE pushes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pusher_id     INTEGER REFERENCES users(id),
  pusher_wallet BLOB,
  ref_name      TEXT NOT NULL,
  old_oid       BLOB,
  new_oid       BLOB,
  forced        INTEGER NOT NULL DEFAULT 0,
  manifest_hash BLOB,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pushes_repo ON pushes (repo_id, id DESC);

CREATE TABLE commit_anchors (
  repo_id      INTEGER NOT NULL,
  commit_oid   BLOB NOT NULL,
  push_id      INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  ref_name     TEXT NOT NULL,
  l1_chain_id  INTEGER,
  l1_tx        BLOB,
  l1_block     INTEGER,
  ref_sequence INTEGER,
  arkiv_tx     BLOB,
  arkiv_entity BLOB,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','arkiv_done','anchored','failed','done_private')),
  PRIMARY KEY (repo_id, commit_oid, ref_name),
  FOREIGN KEY (repo_id, commit_oid) REFERENCES commits(repo_id, oid) ON DELETE CASCADE
);
CREATE INDEX commit_anchors_push ON commit_anchors (push_id);

-- Every Swarm upload (pack, manifest) made for a push; references are 64 hex chars (128 when encrypted by Bee).
CREATE TABLE swarm_uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  push_id    INTEGER REFERENCES pushes(id) ON DELETE SET NULL,
  kind       TEXT,                                         -- pack | manifest | ...
  reference  TEXT NOT NULL,
  bytes      INTEGER,
  encrypted  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX swarm_uploads_repo ON swarm_uploads (repo_id, created_at);
CREATE INDEX swarm_uploads_push ON swarm_uploads (push_id);

CREATE TABLE issues (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  author_id      INTEGER REFERENCES users(id),
  title          TEXT NOT NULL,
  body           TEXT,
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  state_reason   TEXT CHECK (state_reason IN ('completed','not_planned','reopened')),
  milestone_id   INTEGER,
  locked         INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  closed_at      TEXT,
  closed_by      INTEGER REFERENCES users(id),
  source         TEXT,                                     -- JSON import metadata (e.g. GitHub URL)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (repo_id, number)
);
-- (pg tsvector `search` column + GIN index dropped; search title/body with LIKE)
CREATE INDEX issues_repo_state ON issues (repo_id, state, updated_at DESC);

CREATE TABLE issue_assignees (
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id  INTEGER REFERENCES users(id),
  PRIMARY KEY (issue_id, user_id)
);
CREATE TABLE labels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL CHECK (length(color) = 6),
  description TEXT,
  UNIQUE (repo_id, name)
);
CREATE TABLE issue_labels (
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE TABLE milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  due_on      TEXT,
  state       TEXT NOT NULL DEFAULT 'open',
  UNIQUE (repo_id, title)
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id  INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX comments_issue ON comments (issue_id, created_at);

CREATE TABLE reactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  content      TEXT NOT NULL,
  UNIQUE (user_id, subject_type, subject_id, content)
);

CREATE TABLE issue_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id),
  event      TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',                   -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX issue_events_issue ON issue_events (issue_id, created_at);

CREATE TABLE pull_requests (
  issue_id         INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  repo_id          INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  head_repo_id     INTEGER REFERENCES repos(id),
  head_ref         TEXT NOT NULL,
  head_oid         BLOB NOT NULL,
  base_ref         TEXT NOT NULL,
  base_oid         BLOB NOT NULL,
  merge_base_oid   BLOB,
  state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
  draft            INTEGER NOT NULL DEFAULT 0,
  mergeable        TEXT CHECK (mergeable IN ('clean','conflict','unknown')),
  merge_method     TEXT CHECK (merge_method IN ('merge','squash','rebase')),
  merged_by        INTEGER REFERENCES users(id),
  merged_at        TEXT,
  merge_commit_oid BLOB,
  additions        INTEGER,
  deletions        INTEGER,
  changed_files    INTEGER,
  session_id       TEXT                                    -- task_sessions.id when opened from a scoped session
);
CREATE INDEX pull_requests_repo_state ON pull_requests (repo_id, state);

CREATE TABLE reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_issue_id  INTEGER NOT NULL REFERENCES pull_requests(issue_id) ON DELETE CASCADE,
  author_id    INTEGER NOT NULL REFERENCES users(id),
  commit_oid   BLOB NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','commented','approved','changes_requested','dismissed')),
  body         TEXT,
  signature    BLOB,                                       -- EIP-712 signed review
  submitted_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX reviews_pr ON reviews (pr_issue_id, author_id);

CREATE TABLE review_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  pr_issue_id INTEGER NOT NULL,
  author_id   INTEGER NOT NULL,
  commit_oid  BLOB NOT NULL,
  path        TEXT NOT NULL,
  side        TEXT CHECK (side IN ('LEFT','RIGHT')),
  line        INTEGER,
  start_line  INTEGER,
  in_reply_to INTEGER REFERENCES review_comments(id),
  body        TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE review_requests (
  pr_issue_id  INTEGER REFERENCES pull_requests(issue_id) ON DELETE CASCADE,
  user_id      INTEGER,
  team_id      INTEGER,
  requested_by INTEGER,
  PRIMARY KEY (pr_issue_id, user_id)
);
CREATE TABLE check_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL,
  head_oid     BLOB NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL,
  conclusion   TEXT,
  details_url  TEXT,
  output       TEXT,                                       -- JSON
  started_at   TEXT,
  completed_at TEXT
);

CREATE TABLE releases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tag_name     TEXT NOT NULL,
  target_oid   BLOB NOT NULL,
  name         TEXT,
  body         TEXT,
  draft        INTEGER DEFAULT 0,
  prerelease   INTEGER DEFAULT 0,
  author_id    INTEGER REFERENCES users(id),
  published_at TEXT,
  UNIQUE (repo_id, tag_name)
);
CREATE TABLE release_assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id   INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  s3_key       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT,
  sha256       BLOB NOT NULL
);

CREATE TABLE webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER,
  org_id      INTEGER,
  url         TEXT NOT NULL,
  secret_hash BLOB NOT NULL,
  events      TEXT NOT NULL DEFAULT '[]',                  -- JSON array of strings
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE webhook_deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  payload      TEXT NOT NULL,                              -- JSON
  status_code  INTEGER,
  response_ms  INTEGER,
  attempt      INTEGER NOT NULL DEFAULT 1,
  delivered_at TEXT
);

CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id      INTEGER,
  reason       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  unread       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at      TEXT
);
CREATE INDEX notifications_user ON notifications (user_id, unread, created_at DESC);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER,
  actor_wallet BLOB,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    INTEGER,
  ip           TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',                 -- JSON
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE activity (                                    -- feed, one row per user-visible event
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER,
  actor_id   INTEGER,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,                                -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX activity_repo ON activity (repo_id, id DESC);

CREATE TABLE outbox (                                      -- transactional outbox, written in the same txn as the change
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    INTEGER NOT NULL,
  kind            TEXT NOT NULL,                           -- push | commit | pr | review | issue | comment | release | name_claim ...
  payload         TEXT NOT NULL,                           -- JSON
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at         TEXT
);
CREATE INDEX outbox_status_next ON outbox (status, next_attempt_at);

CREATE TABLE arkiv_entities (                              -- every entity we wrote, for renewal and rebuild
  entity_key       BLOB PRIMARY KEY,
  schema           TEXT NOT NULL,
  repo_id          INTEGER,
  outbox_id        INTEGER REFERENCES outbox(id),
  tx_hash          BLOB NOT NULL,
  expires_at_block INTEGER NOT NULL,
  last_extended_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX arkiv_entities_expires ON arkiv_entities (expires_at_block);

CREATE TABLE arkiv_chunks (                                -- content-addressed chunks already written per repo
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  chunk_hash BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (repo_id, chunk_hash)
);

CREATE TABLE chain_anchors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL REFERENCES repos(id),
  ref_name     TEXT NOT NULL,
  chain_id     INTEGER NOT NULL,
  contract     BLOB NOT NULL,
  tx_hash      BLOB NOT NULL,
  block_number INTEGER,
  ref_sequence INTEGER NOT NULL,
  ref_root     BLOB NOT NULL,
  writer       BLOB NOT NULL,
  finalized    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE name_claims (
  name          TEXT COLLATE NOCASE PRIMARY KEY,
  dheet_repo_id BLOB NOT NULL,
  claimant      BLOB NOT NULL,
  arkiv_entity  BLOB,
  claimed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Task-scoped, time-boxed, need-to-know access.
CREATE TABLE task_sessions (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL CHECK (role IN ('contractor','employee','maintainer')),
  allowed_paths TEXT NOT NULL DEFAULT '[]',                -- JSON array of path prefixes / simple globs
  ref           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','expired')),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT,
  ended_by      INTEGER REFERENCES users(id),
  end_reason    TEXT
);
CREATE UNIQUE INDEX task_sessions_one_active ON task_sessions (user_id, issue_id) WHERE status = 'active';
CREATE INDEX task_sessions_repo ON task_sessions (repo_id, status);
CREATE INDEX task_sessions_user ON task_sessions (user_id, status);

CREATE TABLE session_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id),
  kind       TEXT NOT NULL,                                -- create, tree, blob, commits, export, proposal, denied, end, revoke ...
  detail     TEXT NOT NULL DEFAULT '{}',                   -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX session_events_session ON session_events (session_id, id);

-- 0G assistant audit trail. Prompts are never stored, only their sha256.
CREATE TABLE assistant_calls (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  session_id     TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('summarize','ask')),
  model          TEXT,
  zg_request_id  TEXT,
  prompt_hash    BLOB,
  refused        INTEGER NOT NULL DEFAULT 0,
  refusal_reason TEXT,
  sealed         INTEGER,
  tee_verified   INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  latency_ms     INTEGER,
  question       TEXT,
  answer         TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX assistant_calls_session_idx ON assistant_calls (session_id, created_at DESC);
CREATE INDEX assistant_calls_user_idx ON assistant_calls (user_id, created_at DESC);
CREATE INDEX assistant_calls_reqid_idx ON assistant_calls (zg_request_id) WHERE zg_request_id IS NOT NULL;

-- 0G scope suggestions for issues (one row per call, failed calls too so the rate limit counts them).
CREATE TABLE scope_suggestions (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  model         TEXT,
  zg_request_id TEXT,
  paths         TEXT,                                      -- JSON [{path, kind, reason}]; NULL when the call failed
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX scope_suggestions_user ON scope_suggestions (user_id, created_at);
CREATE INDEX scope_suggestions_issue ON scope_suggestions (issue_id, created_at);

-- Device-code login for the `dit` CLI. Only sha256 hashes of the codes are stored.
CREATE TABLE cli_device_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_hash  BLOB NOT NULL UNIQUE,
  user_hash    BLOB NOT NULL UNIQUE,
  client_name  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash    BLOB,
  csrf_session BLOB,                                       -- sha256 of the session token the csrf value was issued to
  last_poll_at TEXT,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at  TEXT
);
CREATE INDEX cli_device_codes_expires ON cli_device_codes (expires_at);

-- On-chain deployment mirror (DeployRegistry releases + attestations). Release ids restart per chain.
CREATE TABLE chain_cursors (
  name       TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL
);

CREATE TABLE deployments (
  chain_id     INTEGER NOT NULL,
  id           INTEGER NOT NULL,                           -- release id from DeployRegistry
  "commit"     BLOB NOT NULL,
  bundle_hash  BLOB NOT NULL,
  url          TEXT NOT NULL,
  published_at TEXT,
  publisher    BLOB,
  publish_tx   BLOB,
  attested     INTEGER NOT NULL DEFAULT 0,
  attested_ok  INTEGER,
  attested_at  TEXT,
  attest_tx    BLOB,
  arkiv_entity BLOB,
  arkiv_tx     BLOB,
  PRIMARY KEY (chain_id, id)
);
CREATE INDEX deployments_published_at_idx ON deployments (published_at DESC);
