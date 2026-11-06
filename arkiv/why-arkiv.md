# Why Arkiv rather than a database or IPFS

**What we need.** A public, queryable, attribute-indexed record that a third party can read when our server is down, plus a place to put code bytes that is not our disk.

- **Versus our own database.** A database we run is exactly what a takedown or an operator can rewrite. Arkiv gives an independent store with indexed attributes (`repo`, `kind`, `seq`, `actor`, `l1Tx`), so "show all activity for repo X in order" is a query, not a file crawl. Postgres stays our working store; Arkiv is the mirror and recovery source (`arkiv-clone`).
- **Versus IPFS.** IPFS gives content addressing but no query layer and no built-in persistence: data lives only while someone pins it, and discovery of "the entities for this repo" needs a separate index. Arkiv stores bytes and indexed attributes together with a lifecycle (expiry/extension) that anyone can extend (`permissionlessExtension`).
- **Versus calldata / an L1 contract.** Putting commit records in Ethereum events is permanent but expensive and unindexed by attribute; we use L1 only for the small, authoritative part (one ref anchor per push, release hash, attestation) and Arkiv for the bulk.

**Trade-offs, honestly.** Entities expire (about 182.5 days) so we run a renewal worker; reads have no proofs; anyone can write our schema; the node caps queries at 100 rows; the network is a testnet. IPFS or a pinning service
would be cheaper for large blobs, and a plain database is simpler and faster. We chose Arkiv because the product claim, a verifiable activity log and recoverable code, needs an independent, indexed, queryable store, and because the combination (L1 anchor hash + Arkiv entity that carries that tx hash) lets a reader cross-check the two. See `friction.md`.
