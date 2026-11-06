-- Phase 3: issues/PR numbering, task-scoped sessions.

-- Per-repo number shared by issues and pull requests, allocated atomically (INSERT .. ON CONFLICT DO UPDATE takes a row lock).
CREATE TABLE IF NOT EXISTS repo_counters (repo_id bigint PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, last_number integer NOT NULL DEFAULT 0);
INSERT INTO repo_counters (repo_id, last_number) SELECT repo_id, max(number) FROM issues GROUP BY repo_id ON CONFLICT DO NOTHING;

ALTER TABLE issues ADD COLUMN IF NOT EXISTS source jsonb;                       -- import metadata (e.g. GitHub URL)
ALTER TABLE pull_requests ADD COLUMN IF NOT EXISTS session_id uuid;             -- set when opened from a scoped session proposal
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS pull_requests_repo_state ON pull_requests (repo_id, state);
CREATE INDEX IF NOT EXISTS reviews_pr ON reviews (pr_issue_id, author_id);
CREATE INDEX IF NOT EXISTS comments_issue ON comments (issue_id, created_at);
CREATE INDEX IF NOT EXISTS issue_events_issue ON issue_events (issue_id, created_at);

-- Task-scoped, time-boxed, need-to-know access. (Not `sessions`: that table already holds login sessions.)
CREATE TABLE IF NOT EXISTS task_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id),             -- the developer
  created_by bigint NOT NULL REFERENCES users(id),          -- the maintainer
  role text NOT NULL CHECK (role IN ('contractor','employee','maintainer')),
  allowed_paths text[] NOT NULL DEFAULT '{}',               -- normalised path prefixes / simple globs
  ref text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz, ended_by bigint REFERENCES users(id), end_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS task_sessions_one_active ON task_sessions (user_id, issue_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS task_sessions_repo ON task_sessions (repo_id, status);
CREATE INDEX IF NOT EXISTS task_sessions_user ON task_sessions (user_id, status);

CREATE TABLE IF NOT EXISTS session_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  actor_id bigint REFERENCES users(id),
  kind text NOT NULL,                                       -- create, tree, blob, commits, export, proposal, denied, clone_denied, end, revoke ...
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_events_session ON session_events (session_id, id);
