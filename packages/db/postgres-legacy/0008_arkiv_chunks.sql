-- Content-addressed chunks already written to Arkiv per repo, so a push only uploads chunks that are new.
CREATE TABLE IF NOT EXISTS arkiv_chunks (
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  chunk_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, chunk_hash)
);
