# Dithub without Postgres: Swarm + Arkiv + a local SQLite cache

Status: being implemented on branch `swarm-arkiv`. This file is the contract every part of the change follows.

## Roles

| Layer | Holds | Authority |
|---|---|---|
| Arkiv | public metadata: activity (commits, pushes, issues, PRs, comments, RBAC chain, releases), name claims, manifests that point at Swarm, device-key registrations, private-repo key grants | source of truth for public metadata |
| Swarm (Bee) | git pack bytes and manifests (public: plaintext; private: XChaCha20-Poly1305 ciphertext) | source of truth for repo bytes |
| L1 (Base, `RefRegistry`) | one ref-root anchor per push | ordering and tamper evidence |
| SQLite (one file, WAL) | a rebuildable read index for pages and permission checks, the push->anchor job outbox, SIWE nonces, PATs, CLI device codes, the server's sealed repo keys | local cache only; `packages/indexer` rebuilds it from Arkiv + Swarm |

No database server. API and worker share one SQLite file on one host (WAL mode, `busy_timeout=5000`).

## Interfaces (fixed; build against these)

### `packages/db` (owner: db-core)
- `packages/db/schema.sql`: the full schema, SQLite dialect, consolidated from the old Postgres migrations 0001-0011.
  New migrations go in `packages/db/migrations-sqlite/NNNN_name.sql`; the old Postgres migrations move to `packages/db/postgres-legacy/` (read only by the data-migration script).
- `packages/db/src/index.ts` exports:
  - `openDb(path = process.env.DATABASE_PATH ?? '<repo>/.data/dithub.sqlite'): SQL` — Bun `SQL` over `sqlite://`, sets `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
  - `migrate(sql: SQL): Promise<void>` — applies schema.sql on an empty DB, then pending `migrations-sqlite/*`.
  - `hex(v: string): Buffer`, `toHex(v): string | null`, `now(): string` (ISO-8601 UTC with ms), `json(v): string`, `parseJson<T>(v): T`, `bool(v): boolean`.
  - `newId(): string` (uuid v4 via `crypto.randomUUID()`).
- `apps/api/src/db.ts` keeps exporting `sql`, `hex`, `toHex` (re-exported from `packages/db`).

### SQLite dialect rules (everyone writing SQL)
- `bytea` -> `BLOB`; `timestamptz` -> `TEXT` ISO-8601 UTC; defaults use `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`. In queries replace `now()` with that expression or with a bound `${now()}` value; `now() + interval '10 minutes'` -> bound value computed in JS.
- `jsonb` -> `TEXT` holding JSON; write with `json(v)`, read with `parseJson`. `->>` becomes `json_extract(col, '$.key')`.
- `boolean` -> `INTEGER` 0/1. Rows come back as numbers: never compare with `=== true`; use `bool()`.
- `uuid` / `gen_random_uuid()` -> `TEXT` from `newId()`. `bigserial` -> `INTEGER PRIMARY KEY AUTOINCREMENT`.
- `::casts` removed; `encode(x,'hex')` -> `lower(hex(x))`; `GREATEST/LEAST` -> `max/min`; `ILIKE` -> `LIKE` (case-insensitive for ASCII); `= ANY(${arr})` -> `IN ${sql(arr)}`; `FOR UPDATE SKIP LOCKED` -> claim rows inside `sql.begin` with an `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`; `DISTINCT ON` -> window function or `GROUP BY` with `max()`; full-text `to_tsvector` -> `LIKE` (FTS5 optional).
- `RETURNING` is supported. Integer columns can come back as `number` or `bigint`; wrap with `Number()`.

### Sessions (owner: auth)
- Browser/API sessions are stateless: `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`, payload `{uid, ver, exp}`, secret `SESSION_SECRET` (>= 32 bytes, required in prod). `users.token_version INTEGER NOT NULL DEFAULT 0`; logout-everywhere increments it. The `sessions` table is gone.
- `siwe_nonces`, `access_tokens` (PATs, stored hashed), `cli_device_codes` stay as SQLite tables.

### Swarm (owner: swarm) — `packages/sdk/src/swarm.ts`
- `createSwarmClient({ beeUrl, postageBatchId, fetch? })` -> `{ uploadBytes(data, { encrypt?: boolean, pin?: boolean }): Promise<{ reference: string }>, downloadBytes(reference): Promise<Uint8Array>, health(): Promise<boolean> }`. Bee HTTP API: `POST /bytes` with `swarm-postage-batch-id` (+ `swarm-encrypt: true`, `swarm-pin`), `GET /bytes/{ref}`. References are 64 hex chars (128 when Bee-encrypted).
- `swarmConfigFromEnv()` reads `BEE_URL`, `BEE_POSTAGE_BATCH_ID`; returns `null` when unset (Swarm disabled; callers log and skip).
- `packages/sdk/src/testing/mock-bee.ts`: `startMockBee(): Promise<{ url: string; stop(): void; stored: Map<string, Uint8Array> }>` — in-process Bun.serve that implements the two endpoints with content addressing (sha256 is fine for the mock). All tests use this; no real Bee needed.
- `publishPackToSwarm(client, { repoId, packBytes, manifest, encryptWith?: { key, keyEpoch } })` -> `{ packRef, manifestRef }`, and `fetchPackFromSwarm(client, manifestRef, key?)`. The Arkiv manifest entity (`dheet-manifest-v1`) gains `swarmPackRef` / `swarmManifestRef` in its content so recovery = Arkiv manifest -> Swarm bytes.

### Private repos (owner: crypto) — `packages/sdk/src/keys.ts`
- One random 32-byte key per private repo per epoch. Content is encrypted with `encryptPrivateChunk` (fix: drop `plaintextHash` from the envelope; it leaks known-plaintext guesses. Integrity comes from the AEAD tag).
- Device keys: X25519 (`@noble/curves/ed25519` x25519). `generateDeviceKey()`, `deviceKeyStatement(wallet, publicKeyHex)` (text the wallet signs with personal_sign), `verifyDeviceKey({ wallet, publicKey, signature })`.
- Grants: `sealRepoKey(repoKey, recipientPublicKey)` -> bytes (ephemeral X25519 + HKDF-SHA256 + XChaCha20-Poly1305), `openRepoKey(sealed, devicePrivateKey)`.
- Arkiv schemas `dheet-devicekey-v1` (wallet, publicKey, signature) and `dheet-grant-v1` (opaque repo id, epoch, recipient publicKey, sealed key) with `publishDeviceKey`, `publishGrant`, `listGrants` helpers.
- Server is a member (phase 1): server device key from `DITHUB_DEVICE_KEY` (hex X25519 private). SQLite `repo_keys(repo_id, epoch, sealed BLOB, created_at)` keeps the key sealed to the server; `device_keys(user_id, public_key, signature, created_at)` mirrors registrations.
- Membership change on a private repo: removing a member rotates (new epoch, grants for remaining members + server); adding one writes one grant for the current epoch.
- Private repos on Arkiv use an opaque id `sha256('dithub-private:' + repoId + ':' + serverSecret)` and encrypted activity bodies; names never leave SQLite.

## File ownership
Stage 1 (parallel): db-core, auth, swarm, crypto. Stage 2 (parallel): api-a, api-b, worker, infra. Stage 3: integration + fixes.
Only edit files you own (listed in your task). If you need a change in someone else's file, write it under "Requests" in your final report instead.
