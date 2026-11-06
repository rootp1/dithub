-- Independent of the anchoring outbox: a slow bulk upload cannot block commit records.
-- A pointer rediscovered after a crash may have no locally recorded transaction hash.
ALTER TABLE arkiv_entities ALTER COLUMN tx_hash DROP NOT NULL;
CREATE TABLE recovery_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  push_id bigint NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed','skipped')),
  stage text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, leased_until timestamptz,
  last_error text,
  manifest jsonb,
  pointer jsonb,
  entity_key bytea,
  arkiv_tx bytea,
  expires_at_block bigint,
  verified_at timestamptz,
  postage_checked_at timestamptz,
  postage_error text,
  postage_expires_estimate timestamptz,
  batch_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_snapshots_queue ON recovery_snapshots(next_attempt_at) WHERE status IN ('pending','processing');
CREATE INDEX recovery_snapshots_repo ON recovery_snapshots(repo_id, id DESC);
CREATE UNIQUE INDEX recovery_snapshots_active_push ON recovery_snapshots(push_id) WHERE status IN ('pending','processing');
CREATE UNIQUE INDEX recovery_snapshots_processing_repo ON recovery_snapshots(repo_id) WHERE status='processing';
