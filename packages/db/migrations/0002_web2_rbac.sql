-- Remove the ENSv2 seat feature; RBAC is plain web2. Public orgs get a hash-chained, Arkiv-mirrored change log.
DROP TABLE IF EXISTS ens_seats;
ALTER TABLE orgs DROP COLUMN IF EXISTS ens_name, DROP COLUMN IF EXISTS ens_registry;
ALTER TABLE org_members DROP COLUMN IF EXISTS seat_status, DROP COLUMN IF EXISTS seat_tx;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS rbac_head bytea;                 -- hash of the latest rbac event
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS rbac_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rbac_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  actor_id bigint REFERENCES users(id),
  actor_login text NOT NULL,
  action text NOT NULL,                       -- member.add, member.remove, member.role, team.*, collaborator.*, protection.*
  payload jsonb NOT NULL,
  prev_hash bytea,
  hash bytea NOT NULL,                        -- sha256(prev_hash || canonical json of the event)
  public boolean NOT NULL,                    -- true: mirrored to Arkiv (verifiable); false: Postgres only
  arkiv_entity bytea, arkiv_tx bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, seq)
);
CREATE INDEX IF NOT EXISTS rbac_events_org ON rbac_events (org_id, seq DESC);
