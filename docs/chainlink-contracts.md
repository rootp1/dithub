# Chainlink CRE contracts (Ethereum Sepolia, chain 11155111)

| Contract | Address | Etherscan |
| --- | --- | --- |
| DeployRegistry | `0x654079488907fcC1279f7215a851Cb04c8241232` | deployed |
| DeployAttestations | `0x0366e20a4143C8E45B9c65eCB5B03CD6FC367683` | deployed |
| RefRegistry | `0xBFBF6f788cD66F2f4107F2355eb70cef4143c9E6` | deployed |

Tx hashes and deploy blocks: `deployments/sepolia.json`. Sources: `packages/contracts/src/Deploy*.sol`, tests in `packages/contracts/test/Deploy*.t.sol`.

## DeployRegistry
Append-only list of releases. The owner manages a publisher allowlist (`setPublisher(address,bool)`); only publishers may call `publish(bytes32 commit, bytes32 bundleHash, string url)`, which returns an id starting at 1 and emits `ReleasePublished(id, commit, bundleHash, url, publisher)`. Reads: `latestRelease()` (id 0 if empty), `getRelease(id)` (reverts on unknown id), `releaseCount()`. Owner and initial publisher: `0x9045a577c909d7F6D7f7Bfe8586a8Ba13f81c2dC`. Release 1 records the live `dithub.app` bundle.

## DeployAttestations (CRE consumer)
Implements `IReceiver` (ERC165 reports IReceiver `0x805f2132` and ERC165). `onReport(bytes metadata, bytes report)` is callable only by the configured forwarder; forwarder can never be the zero address (constructor and `setForwarder`, owner only).

Report encoding:

```
abi.encode(uint256 releaseId, bytes32 commit, bytes32 bundleHash, bool ok, uint64 observedAt)
```

The release must exist in the registry and `commit` / `bundleHash` must match it, otherwise the report reverts (`UnknownRelease`, `ReleaseMismatch`). Per release it stores `ok`, `observedAt`, attestation count and keccak of the last metadata. Repeated or replayed reports are accepted: they overwrite ok/observedAt and increment the count. Emits `Attested(releaseId, bundleHash, ok, observedAt)`. Reads: `attestation(id)` -> (exists, ok, observedAt, count), `latestAttestation()` -> highest attested release id.

## Forwarders (Ethereum Sepolia)
- `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` - MockKeystoneForwarder, used only for simulation broadcasts. **Currently configured** (DeployAttestations redeployed 2026-11-07 against it).
- `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` - production KeystoneForwarder. Not configured: it only accepts reports from a workflow deployed to the DON.

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
