# Friction we hit building on Arkiv

1. **Expiry cap, no permanent storage.** `ExpirationTime.max()` is about 182.5 days (7,884,000 blocks at the time of writing). We had to build a renewal worker
   (`renewArkivEntities`, `arkiv_entities.expires_at_block`, hourly check, renew when under about 30 days), set `permissionlessExtension`, and still keep a cold-archive plan. Older API docs mention a permanent `MAX_EXPIRES_AT` that the SDK rejects.
2. **No proofs on reads.** `publicClient.select(...)` returns what one RPC says. There is no inclusion/absence proof, so we hash-verify everything we can (manifest sha256, BLAKE3 chunks)
   and cannot detect a node silently omitting an entity (e.g. a missing deployment record). Our RBAC hash chain proves the log was not rewritten, not that the answer is complete.
3. **Anyone can write our schema.** Writes are unauthenticated at the schema level, so `dheet-activity-v1` and `dheet-name-v1` can be spammed or squatted. We read only entities whose `actor` is the relayer
   (see `apps/api/src/deployments.ts`) and treat name claims as first-valid-wins verified against our ledger.
4. **Query limits.** The node rejects `limit` above 100 ("Page through the results with an offset instead"). We hit this live: our first read used 500 and silently fell back to Postgres. We now query newest-first (`orderBy(desc('seq'))`, limit 100).
   There is no server-side aggregation, so "latest attestation per release" is computed client side.
5. **String attribute size.** Indexed strings must stay small, so titles/refs are clamped (120 bytes, UTF-8 aware) and the rest goes into the `content` JSON.
6. **Cost and batching: tGLM and gas.** Writes need Rabdi gas funded from a faucet-style balance; storage gas scales with size x lifetime, so a full-lifetime 120 KiB chunk is expensive. A 30M block gas limit means a 1 MiB upload cannot be a single transaction. We cap code publishing (`ARKIV_CODE_MAX_BYTES`, default 2 MB, public repos, default branch only) and one entity per commit (max 50 commits per push).
7. **SDK typing quirks.** `defineSchema` values must be wrapped (`u64(...)`, `key(...)`, `addr(...)`, `bytes`), and selected fields come back as wrapper objects (`{ value }`) rather than primitives; `bytes` may arrive as a `Uint8Array`, a hex string or a wrapper. We added `arkivBytes()` / `str()` normalisers. `exactOptionalPropertyTypes` also forces conditional spreads for optional values (`coldId`).
8. **Read-only client still needs an account shape.** `createArkivConnection` builds a wallet client, so the API uses a throwaway generated key for reads plus `ARKIV_ACCESS_KEY` from env.
9. **Testnet resets and access keys.** Rabdi is a testnet: entities may vanish on a reset and an access key is required in the chain config. Because of this Postgres stays the working store and Arkiv is a mirror plus recovery source, not the primary database.
