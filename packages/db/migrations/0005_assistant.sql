-- 0G Private Computer assistant audit trail. One row per model call (or server-side refusal).
-- No FK to sessions: that table comes from a separate migration. Prompts are never stored, only their sha256.
CREATE TABLE assistant_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL,
  user_id        bigint NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('summarize','ask')),
  model          text,
  zg_request_id  text,                 -- 0G Router request id (x_0g_trace.request_id)
  prompt_hash    bytea,               -- sha256 of the final prompt sent to 0G; null when refused before the call
  refused        boolean NOT NULL DEFAULT false,
  refusal_reason text,
  sealed         boolean,              -- gateway reported sealed (TEE-only) execution
  tee_verified   boolean,
  tokens_in      integer,
  tokens_out     integer,
  latency_ms     integer,
  question       text,                 -- the developer's own question, capped
  answer         text,                 -- the developer's own answer, capped at 4000 chars
  error          text,                 -- scrubbed failure summary when 0G was unreachable
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_calls_session_idx ON assistant_calls (session_id, created_at DESC);
CREATE INDEX assistant_calls_user_idx ON assistant_calls (user_id, created_at DESC);
CREATE INDEX assistant_calls_reqid_idx ON assistant_calls (zg_request_id) WHERE zg_request_id IS NOT NULL;
