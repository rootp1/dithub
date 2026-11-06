-- Payloads were stored as JSON string scalars; unwrap them into real objects.
UPDATE rbac_events SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
UPDATE outbox SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
UPDATE activity SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
