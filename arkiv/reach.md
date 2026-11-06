# Reach: who benefits and the adoption path

**Who.** (1) Open-source maintainers and DAOs who want their history and code to survive a host takedown or account ban. (2) Contractors and employers who need an auditable, tamper-evident
record of who changed what and which RBAC grants existed (hash-chained events on Arkiv, anchored hashes on Ethereum). (3) Anyone consuming releases: the deployment history is readable by any Arkiv client without trusting our API.

**Why it can spread.** The adapter is small (`packages/sdk`): any Git host can mirror commit activity with `recordActivity` and code with `uploadManifestToArkiv`, and anyone can run `dheet arkiv-clone` to recover a repository with no Dheet server.
The schemas in `arkiv/schema.md` are public and versioned (`-v1`), so third-party indexers and UIs can read them.

**Adoption path.** Today: a hosted instance plus a self-hostable `docker compose` stack. Next: (a) a GitHub Action that mirrors an existing GitHub repo's commits and releases to Arkiv, (b) an explorer
that reads Arkiv directly and shows recovery status, (c) a multi-writer model so entities are signed by maintainers rather than one relayer, (d) cold-archive replication to a second backend.

**Honest status.** One instance, testnet, one relayer wallet, no external users yet.
