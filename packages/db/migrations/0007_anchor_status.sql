-- The worker marks pushes to private repos as 'done_private' (nothing is mirrored on-chain); allow that status.
ALTER TABLE commit_anchors DROP CONSTRAINT IF EXISTS commit_anchors_status_check;
ALTER TABLE commit_anchors ADD CONSTRAINT commit_anchors_status_check
  CHECK (status IN ('pending','arkiv_done','anchored','failed','done_private'));
