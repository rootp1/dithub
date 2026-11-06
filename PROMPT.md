ROLE: Principal protocol engineer + distributed-systems architect.

TASK: Write a single file `./plan.md`: a complete, implementation-ready plan for
"dheet", a full-fledged decentralised, blockchain-based version control system
(git-compatible semantics, no central server) built on Arkiv (data layer) and
ENSv2 (naming, identity, permissions). Write only plan.md; no code yet.

STEP 0 — READ LOCAL SOURCES FIRST (authoritative; cite file paths in an appendix)
 Arkiv:  docs/arkiv/arkiv-node/docs/{api-spec,query-language-conformance,
         genesis-spec,tokenomics_v1}.md, README.md,
         docs/arkiv/sites/docs.arkiv.network/, hub.arkiv.network/
         (networks, access-keys, faucet).
 ENSv2:  every file in docs/ensv2/ (overview, registry-hierarchy,
         permissioned-registry, enhanced-access-control, permissioned-resolver,
         subnames, verifiable-factory, mutable-token-ids, universal-resolver-v2,
         reverse-resolution, indexing, eth-registrar, migration, ensip-25/26,
         tutorials, ens-cli README).
 Env:    ensv2-env/ens-cli (src/commands, src/lib/contracts.ts, e2e harness),
         ensv2-env/app, ensv2-env/simple-subname-registrar.
 Web (only to fill gaps/verify freshness): git object model & packfiles,
 git remote-helper protocol, prior art (Radicle, git-ssb, Gitopia, Pijul).
 Where docs conflict (e.g. Arkiv "permanent entities", ENS resolver resource
 derivation, two Sepolia address sets) state the conflict and pick a safe default.

HARD CONSTRAINTS THE DESIGN MUST RESPECT
 Arkiv: no EVM (all logic in separate L1 contracts or client); writes via
  execute() at 0x4400…0044 with ops CREATE/PATCH/EXTEND/TRANSFER/DELETE, atomic
  batches, predictEntityKeys; ≤32 attrs, str ≤128 B, bytes ≤128 KiB per attr and
  per op (chunk objects); bytes not indexed (put oids in bytes32 attrs); max
  lifetime ~182.5 days and NO permanent storage (design renewal + permissionless
  pinners + cold archive); no expiry events; latest-state reads only, no history
  queries, no cursors, limit ≤100, keyset-page on $key, one ORDER BY, no !=/NOT
  (live), own `seq` attr for ordering; reads are trust-the-RPC (proofs not
  served yet); finality/reorg undocumented; testnet Rabdi (chain 7794095), state
  does not survive network replacement; TS SDK @arkiv-network/sdk only.
 ENSv2: L1 only (no Namechain); one registry per org/repo via VerifiableFactory +
  UserRegistry; EAC roles/bitmaps and role+admin revocation for locking; key by
  labelhash/resource never tokenId; PermissionedResolver argument-scoped roles
  are per-instance (use resolver-per-repo); names expire + renewal; gas costs on
  L1 → minimise on-chain writes (anchor/batch), keep bulk data on Arkiv.

REQUIRED SECTIONS OF plan.md
 1  Vision, goals, non-goals, personas (solo dev, maintainer, DAO/org, auditor)
 2  Requirements (functional + non-functional: integrity, availability,
    censorship resistance, cost/push, latency, offline-first)
 3  Layered architecture (mermaid): CLI/git-remote-helper → local object store →
    sync engine → Arkiv storage → ENSv2 identity/registry → L1 anchor contracts
    → cold archive (IPFS/Arweave/Filecoin/Swarm)
 4  Arkiv data model: exact entity schemas (commit, tree, blob-chunk, tag, ref,
    pack-manifest, PR, review, issue, comment, renewal-receipt): attribute names
    & types & indexed flags, content encoding, chunking for 128 KiB, oid scheme
    (sha256/BLAKE3 + git-sha1 compat), dedup, compression, delta/pack mapping,
    readonly flag usage, per-op batch layout, concrete arkiv_query strings and
    keyset-pagination recipes, cost per push computed with tokenomics formulas
 5  ENSv2 design: namespace (org.eth → repo → branch/tag/fork subnames), per-repo
    UserRegistry + PermissionedResolver deployment sequence with real calls,
    role map (owner, maintainer, writer, release-signer, reader) onto EAC
    bitmaps + argument-scoped resolver roles, record keys (git.head, git.manifest,
    contenthash, agent-context per ENSIP-26), registrar contract for subnames
    (based on tutorial-contract-developers), transfer/lock/immutable-release via
    role+admin revocation, expiry/renewal policy, reverse resolution for authors,
    indexing plan (events list from indexing.mdx)
 6  Identity & signing: ENS name ↔ wallet ↔ commit signatures (EIP-712 /
    EIP-1271), key rotation/revocation, org multisig, offline verification
 7  Consistency & concurrency: ref-update CAS (where it lives given Arkiv has no
    contracts — e.g. L1 RefRegistry anchor vs Arkiv owner-gated patch), forks,
    force-push, merge/conflict semantics, reorg & finality handling
 8  Durability: TTL renewal service (who pays/when/how), permissionlessExtension
    pinners, incentives, tiering (hot Arkiv / L1 anchored root / cold archive),
    expired-data recovery, GC, cost model with worked numbers (1 MB push, 1 GB
    repo-year, ENS renewal fees)
 9  Smart contracts (L1): RepoFactory, RefRegistry/anchor, renewal escrow,
    funding/bounty, ENS access adapter; Solidity signatures, events, upgrade
    strategy, audit surface (Foundry layout)
 10 Client: CLI (init/clone/push/pull/fork/pr/review/merge/renew/whois),
    git-remote-dheet, local cache/index, sync daemon, TS SDK; reuse ens-cli for
    calldata generation; unsigned-tx signing flow
 11 Collaboration layer: PRs, reviews, issues, releases, stars/forks,
    notifications → entities + ENS records
 12 Web UI: static explorer reading Arkiv + ENS (ensjs ≥5.2.5, viem, wagmi)
 13 Privacy: public vs private repos, client-side encryption, key sharing,
    metadata leakage
 14 Threat model (STRIDE table): entity flooding, malicious objects, ENS
    takeover/expiry, signer compromise, lying RPC, TTL griefing, front-running
    refs, sequencer centralisation; mitigation + residual risk
 15 Scalability: indexer design, caching, shallow/partial clone, lazy blobs,
    parallel upload, rate limits & access-key quotas
 16 Interop: git import/export, GitHub mirror/bridge, CI hooks
 17 Tech stack & monorepo layout (packages/cli, sdk, contracts, indexer, web,
    docs), pinned versions, local dev env (Arkiv kurtosis devnet / Rabdi + ENS
    anvil fork harness from ens-cli/e2e), fixing the ensv2-env scaffold
 18 Phased roadmap with exit criteria: P0 spike (store+fetch one commit on
    Rabdi; register repo name on Sepolia) → P1 single-user push/pull → P2 ENS
    identity+roles → P3 multi-user refs/forks → P4 PRs/issues → P5 durability →
    P6 web UI → P7 audit/mainnet
 19 Testing: unit, property-based DAG integrity, Foundry contract tests, e2e
    two-identity clone→push→fetch, chaos (TTL expiry, RPC failure), per-phase
    acceptance tests
 20 Risks register, governance/licensing, ADR-style decision log (choice,
    rejected alternative, why)
 21 Appendices: glossary, sample entity JSON, sample ENS record set, sequence
    diagrams (push, clone, PR merge, renewal), source file paths, open questions

QUALITY BAR: concrete (real schemas, queries, signatures, CLI transcripts);
state what Arkiv/ENSv2 cannot do and the workaround; mermaid diagrams; tables
for schemas/threats; end with "First 10 tasks to start tomorrow".
OUTPUT: write ./plan.md, then reply with a 5-line summary only.
