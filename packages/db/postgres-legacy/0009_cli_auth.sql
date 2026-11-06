-- Device-code login for the `dit` CLI. Only sha256 hashes of the device code and the user code are stored.
CREATE TABLE cli_device_codes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_hash   bytea NOT NULL UNIQUE,
  user_hash     bytea NOT NULL UNIQUE,
  client_name   text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
  user_id       bigint REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash     bytea,            -- one-time value embedded in the approval page
  csrf_session  bytea,            -- sha256 of the session cookie the csrf value was issued to
  last_poll_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz
);
CREATE INDEX cli_device_codes_expires ON cli_device_codes (expires_at);
