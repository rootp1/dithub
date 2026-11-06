# Chainlink CRE contracts (Ethereum Sepolia, chain 11155111)

| Contract | Address | Etherscan |
| --- | --- | --- |
| DeployRegistry | `0x9caa2fEB7880Bb81b7A3C3324c22C3293c65655e` | verified |
| DeployAttestations | `0x458d41E371141655c5b04618875aF22F83809BC9` | verified |

Tx hashes and deploy blocks: `deployments/sepolia.json`. Sources: `packages/contracts/src/Deploy*.sol`, tests in `packages/contracts/test/Deploy*.t.sol`.

## DeployRegistry
Append-only list of releases. The owner manages a publisher allowlist (`setPublisher(address,bool)`); only publishers may call `publish(bytes32 commit, bytes32 bundleHash, string url)`, which returns an id starting at 1 and emits `ReleasePublished(id, commit, bundleHash, url, publisher)`. Reads: `latestRelease()` (id 0 if empty), `getRelease(id)` (reverts on unknown id), `releaseCount()`. Owner and initial publisher: the deployer `0xe5F2164bD59ba9F19fC76F1Aa1E55199a159A16b`. Release 1 is a smoke-test entry.

## DeployAttestations (CRE consumer)
Implements `IReceiver` (ERC165 reports IReceiver `0x805f2132` and ERC165). `onReport(bytes metadata, bytes report)` is callable only by the configured forwarder; forwarder can never be the zero address (constructor and `setForwarder`, owner only).

Report encoding:

```
abi.encode(uint256 releaseId, bytes32 commit, bytes32 bundleHash, bool ok, uint64 observedAt)
```

The release must exist in the registry and `commit` / `bundleHash` must match it, otherwise the report reverts (`UnknownRelease`, `ReleaseMismatch`). Per release it stores `ok`, `observedAt`, attestation count and keccak of the last metadata. Repeated or replayed reports are accepted: they overwrite ok/observedAt and increment the count. Emits `Attested(releaseId, bundleHash, ok, observedAt)`. Reads: `attestation(id)` -> (exists, ok, observedAt, count), `latestAttestation()` -> highest attested release id.

## Forwarders (Ethereum Sepolia)
- `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` - MockKeystoneForwarder, used for `cre workflow simulate --broadcast`. **Currently configured.**
- `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` - production-style KeystoneForwarder for deployed workflows (per the CRE "Building Consumer Contracts" guide). Switch with `setForwarder` (owner) when moving from simulation to a deployed workflow.

Note: the task brief had a typo (an extra `8`) in the mock address; the 42-char address above is the one in Chainlink's forwarder directory.

## How CI publishes a release
CI uses a key that the owner has allowlisted via `setPublisher`:

```
cast send $REGISTRY "publish(bytes32,bytes32,string)" 0x<gitCommitPadded32> 0x<bundleSha256> "<bundle url>" \
  --rpc-url $SEPOLIA_RPC_URL --private-key $PUBLISHER_KEY
```

The id comes from the `ReleasePublished` event (or `releaseCount()`). A CRE workflow then checks the live deployment/bundle and sends a report in the encoding above through the forwarder, which lands in `onReport`.

## Redeploying
`forge create ... --broadcast --json --constructor-args ...` (put `--constructor-args` last), or `packages/contracts/script/Deploy.s.sol` (env `DHEET_DEPLOYER_KEY`, `FORWARDER`). Verify with `forge verify-contract --chain 11155111` and an Etherscan v2 key.
