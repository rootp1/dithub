-- VS Code flow: 0G scope suggestions for issues (one row per call, also failed calls so the rate limit counts them).
CREATE TABLE IF NOT EXISTS scope_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id),
  model text,
  zg_request_id text,
  paths jsonb,                 -- validated [{path, kind, reason}]; NULL when the call failed
  error text,                  -- short failure reason (never the prompt or issue text)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scope_suggestions_user ON scope_suggestions (user_id, created_at);
CREATE INDEX IF NOT EXISTS scope_suggestions_issue ON scope_suggestions (issue_id, created_at);
