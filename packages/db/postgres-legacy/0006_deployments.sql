-- On-chain deployment mirror: DeployRegistry releases + DeployAttestations, mirrored to Arkiv by the worker.
CREATE TABLE IF NOT EXISTS chain_cursors (
  name text PRIMARY KEY,
  last_block bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id bigint PRIMARY KEY,                 -- release id from DeployRegistry
  commit bytea NOT NULL,
  bundle_hash bytea NOT NULL,
  url text NOT NULL,
  published_at timestamptz,
  publisher bytea,
  publish_tx bytea,
  attested boolean NOT NULL DEFAULT false,
  attested_ok boolean,
  attested_at timestamptz,
  attest_tx bytea,
  arkiv_entity bytea,                    -- dheet-activity-v1 entity (kind 'deploy')
  arkiv_tx bytea
);
CREATE INDEX IF NOT EXISTS deployments_published_at_idx ON deployments (published_at DESC);
