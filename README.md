# Dheet

Dheet is a Git-compatible decentralised version-control protocol. The implementation is organised as a local-first vertical slice with adapters for Arkiv, ENSv2, and Ethereum contracts.

## Development

```sh
bun install
bun run check
```

Create and publish a repository to a local network directory:

```sh
git init demo && cd demo
git commit --allow-empty -m init
bun ../packages/cli/src/index.ts init demo.local --network ../network
bun ../packages/cli/src/index.ts push demo.local --network ../network
bun ../packages/cli/src/index.ts clone demo.local ../clone --network ../network
```

The local adapter is deterministic and exercises the same object, chunk, manifest, verification, process-safe compare-and-swap, and Git remote-helper boundaries used by remote adapters.

## Implemented vertical slice

- Native SHA-1 and SHA-256 Git object framing and verification.
- 120 KiB BLAKE3-verified chunks, canonical manifests, and Merkle object roots.
- Content-addressed local network adapter with atomic CAS and deduplication.
- `git-remote-dheet` smart-protocol bridge for normal `git clone` and `git push`.
- Arkiv Rabdi uploader using readonly, permissionlessly extendable entities.
- ENSv2 deployment verification and deterministic proxy salt helpers.
- Solidity `RepoFactory`, `RefRegistry`, and `DheetRepoRegistrar` contracts.
- Direct, EIP-712 relayed, EIP-1271, and unsigned Safe/hardware-wallet ref flows, tested against Anvil.
- Authenticated XChaCha20-Poly1305 private payload primitives with repository/key-epoch binding.
- EIP-712 signed PR, review, issue, comment, and release records.
- Self-verifying cold archives with complete hot-store recovery.
- SQLite indexer, static self-hosted explorer, and Arkiv expiry renewal tooling.

## Git remote

Generate a remote URL and use it with Git:

```sh
REMOTE=$(bun packages/cli/src/index.ts remote-url demo.local --network ../network)
PATH="$PWD/bin:$PATH" git clone "$REMOTE" clone
PATH="$PWD/bin:$PATH" git push "$REMOTE" main
```

## Arkiv

Fund the publishing account with Rabdi tGLM, then provide the signing key only for the command invocation:

```sh
DHEET_PRIVATE_KEY=0x... bun packages/cli/src/index.ts arkiv-publish demo.local \
  --network ../network --access-key "$ARKIV_ACCESS_KEY"
```

## L1 anchor

Deploy `RefRegistry` from `packages/contracts`, then anchor a published ref:

```sh
DHEET_PRIVATE_KEY=0x... bun packages/cli/src/index.ts anchor demo.local \
  --network ../network --rpc http://127.0.0.1:8545 --chain-id 31337 \
  --ref-registry 0x...
```

Private keys are never persisted by Dheet. Production signing should use an external wallet or unsigned transaction flow before mainnet deployment.

Generate an unsigned transaction for a Safe or hardware wallet:

```sh
bun packages/cli/src/index.ts anchor-plan demo.local --network ../network \
  --rpc http://127.0.0.1:8545 --chain-id 31337 --ref-registry 0x... --json
```

## Archives and recovery

```sh
bun packages/cli/src/index.ts archive-export demo.local demo.dheet-archive --network ../network
bun packages/cli/src/index.ts archive-import demo.dheet-archive --network ../recovered-network
bun packages/cli/src/index.ts verify demo.local --network ../recovered-network
```

## Collaboration records

```sh
DHEET_PRIVATE_KEY=0x... bun packages/cli/src/index.ts record-create demo.local \
  --network ../network --kind issue --body '{"title":"Reproduce the bug","state":"open"}'
bun packages/cli/src/index.ts records demo.local --network ../network
```

## Indexer and explorer

```sh
bun run build:web
DHEET_NETWORK=../network PORT=8787 bun run indexer
```

Open `http://localhost:8787`. The indexer is optional; repository and collaboration data remain locally verifiable.

## External-network acceptance

Local and Anvil acceptance is automated. Rabdi uploads, ENSv2 Sepolia registration, public cold-storage replication, and mainnet deployment require funded accounts and environment-specific deployment manifests; they are not simulated or reported as completed by the test suite.
