-- Release ids restart at 1 on every chain, so the deployment mirror is keyed by (chain_id, id). Existing rows are Sepolia.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT 11155111;
ALTER TABLE deployments ALTER COLUMN chain_id DROP DEFAULT;
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_pkey;
ALTER TABLE deployments ADD PRIMARY KEY (chain_id, id);
