# Arkiv entity schemas used by Dithub

All entities are created on Arkiv Rabdi through `@arkiv-network/sdk` with `defineSchema`, flags `{ readonly: true, permissionlessExtension: true }` and
`ExpirationTime.max()` (capped at 7,884,000 blocks, about 182.5 days; the worker renews them). Sources: `packages/sdk/src/arkiv.ts`, `packages/sdk/src/activity.ts`.
"Indexed" attributes are queryable with `select().from(schema).where(eq(...))`; `content` is an unindexed bytes payload.

## dheet-chunk-v1 (code bytes)
Attributes (indexed unless noted): `v`, `kind` (`blob-chunk`), `repo` (repoId key), `seq`, `author` (addr), `ctime`, `payloadHash`, `oid`, `gitOid`, `gitAlg`, `objectKind`,
`chunkNo`, `chunkCount`, `rawSize` (not indexed), `chunkSize` (not indexed), `chunkHash` (BLAKE3 of the chunk), `content` (<=120 KiB, bytes).
Writer: worker relayer, via `uploadManifestToArkiv`. Read back: `eq('repo', repoId)` + `eq('chunkHash', h)`; every chunk is BLAKE3-verified locally.

## dheet-manifest-v1 (repo snapshot descriptor)
Attributes: `v`, `kind` (`pack-manifest`), `repo`, `seq`, `author`, `ctime`, `payloadHash`, `oid` (= manifest sha256), `packHash`, `objectRoot` (Merkle root), `objectCount`,
`chunkCount`, `codec` (`canonical-json`) all indexed; `coldId` optional; `content` = canonical JSON manifest inline when <=120 KiB (otherwise it is chunked, which the reader does not support yet).
Writer: worker relayer (public repos under `ARKIV_CODE_MAX_BYTES`, default 2 MB, default branch only). Read back: `findManifestOnArkiv` (`repo` + `oid`), then the manifest hash is recomputed.

## dheet-activity-v1 (one entity per event)
Attributes (all indexed): `v`, `kind`, `repo` (a 32-byte key: repoId, or sha256 of an org / deployments namespace), `seq`, `actor` (addr), `ctime`, `ref` (string, <=120 B),
`commitOid`, `title` (<=120 B), `l1ChainId`, `l1Tx` (Ethereum tx hash), `manifestHash`; `content` = JSON body (<=100 KiB).

| kind | key (`repo`) | seq | notable fields | body |
| --- | --- | --- | --- | --- |
| `commit` | repoId | per-repo counter | `commitOid`, `ref`, `title`=subject, `l1Tx` = the RefRegistry anchor tx | `{oid, subject, ref, pushId}` |
| `push` | repoId | counter | `manifestHash` of the published code manifest | `{manifestEntity}` |
| `rbac` | sha256(`dheet:org:<login>`) | RBAC event seq | `ref` = actor login, `title` = `action (org)` | org, action, payload, `prevHash`, `hash` (hash chain link) |
| `deploy` | sha256(`dheet:deployments`) | DeployRegistry release id | `commitOid` = release commit, `manifestHash` = bundleHash, `ref` = url, `l1Tx` = publish tx | releaseId, commit, bundleHash, url, publisher, publishedAt |
| `attest` | sha256(`dheet:deployments`) | release id | `ref` = `ok`/`mismatch`, `manifestHash` = bundleHash, `l1Tx` = Attested tx | releaseId, bundleHash, ok, observedAt, logIndex |

Writer: worker relayer only. Read back: `select(...).from(ArkivActivitySchema).where(and(eq('repo', key), eq('actor', relayer))).orderBy(desc('seq')).limit(100)`.
Readers must filter on `actor` because anyone can write the same schema. `GET /api/deployments` (`apps/api/src/deployments.ts`) is the user-visible reader of `deploy`/`attest`.

## dheet-name-v1 (repo name claim)
Attributes (indexed): `v`, `name` (<=100 B, `owner/repo`), `repo` (repoId), `owner` (addr), `ctime`. Writer: worker relayer on repo creation. Read back: `resolveNameOnArkiv`
(`eq('name', name)` ordered by `ctime`): first valid claim wins, and clients verify the claimant against the platform ledger because Arkiv does not enforce uniqueness.
