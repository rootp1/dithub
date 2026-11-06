# Hackathon submission: Dithub

Live: https://172-105-43-184.sslip.io. Repo: this repository (MIT). Quick judge check: `SITE=https://172-105-43-184.sslip.io bun scripts/verify-site.ts`.
Evidence column: "tested" means we ran it and it passed; "present" means the code or doc exists but was not verified end to end by this document's author.

## Track: Arkiv
| Requirement | Evidence |
| --- | --- |
| Meaningful use of Arkiv for writes | Chunks, manifests, per-commit activity, name claims, RBAC chain, deployment events: `arkiv/schema.md`, `packages/sdk/src/{arkiv,activity}.ts`, `apps/worker/src/` |
| User-visible feature that READS Arkiv | `GET /api/deployments` reads `dheet-activity-v1` from Arkiv (`apps/api/src/deployments.ts`); tested: `source: "arkiv"` with releases #1 and #2; `dithub arkiv-clone` recovery (`packages/cli`) |
| Schema documentation | `arkiv/schema.md` |
| Honest friction report | `arkiv/friction.md` (expiry cap, no read proofs, limit 100 hit live, typing quirks) |
| Reach / why Arkiv / how used | `arkiv/reach.md`, `arkiv/why-arkiv.md`, `arkiv/how-you-use-arkiv.md` |
| Lifecycle handled | hourly renewal worker, `permissionlessExtension` |

## Track: EF Best CROPS App
| Requirement | Evidence |
| --- | --- |
| Censorship resistance | code + activity on Arkiv, ref anchors on Sepolia, `arkiv-clone`; README "CROPS" |
| Open source | MIT `LICENSE`; everything including CI/CD and CRE workflow in repo |
| Privacy | private repos/orgs never mirrored; 0G sealed inference for sessions (`docs/zerog.md`) |
| Security | RBAC at pre-receive, SIWE, container hardening, Foundry tests; unaudited (stated) |
| Verifiable frontend demo | `scripts/verify-site.ts` (tested locally against real Sepolia contracts: PASS, and FAIL when a file is tampered), `scripts/publish-release.ts` (tested, idempotent), `.github/workflows/deploy.yml` |
| Live deployment | https://172-105-43-184.sslip.io (serves `/build.json` only after the lead redeploys the new build) |

## Track: Chainlink Best workflow with CRE
| Requirement | Evidence |
| --- | --- |
| CRE workflow (TypeScript) | `cre/deploy-attestor/` (`workflow.ts`, `verify.ts`, tests); description in `docs/chainlink-cre.md` |
| Reads on-chain + external data with consensus, writes on-chain | reads `DeployRegistry.latestRelease`, HTTP-fetches the site, writes a report to `DeployAttestations` (`packages/contracts/src/`, `deployments/sepolia.json`) |
| Trigger from CI | `deploy.yml` step "Trigger CRE verification workflow" (needs `CRE_TRIGGER_URL`) plus a 15 minute cron trigger |
| Observed result | attestation for release #2 was mirrored by our worker with `ok=true` (the attester wrote it through the mock forwarder listed in `deployments/sepolia.json`, `MockKeystoneForwarder (CRE simulation)`) |

## Track: 0G Private Computer
| Requirement | Evidence |
| --- | --- |
| Uses 0G Private Computer, essential to the product | task-scoped assistant: `apps/api/src/{zerog,assistant,assistant-core}.ts`, `docs/zerog.md` (what breaks without it), migration `0005` |

## Still to do before submitting (humans only)
- Record the demo video(s) per track; add team names and contact details/handles.
- Push the repo to a public remote and confirm no secrets are in history (`.env`, `.env.app`, `infra/prod.env` are git-ignored; rotate any key that has ever been pasted in chat or logs, including the Sepolia RPC key that appeared in an error message during testing).
- Redeploy production with the new build so `/build.json` is served, publish the release, and rerun `verify-site.ts`; set the GitHub secrets listed in `docs/ci-cd.md`.
- CRE: confirm whether Chainlink deployment access is granted; until then the workflow is simulation-only and the forwarder is a mock. Do not describe it as a live DON deployment unless that is true.
- Mount the deployments route in `apps/api/src/index.ts` (one line, `docs/ci-cd.md`) and confirm the worker has `SEPOLIA_RPC_URL` unset or a range-friendly RPC.
- Fund the relayer on Arkiv Rabdi and Sepolia for the demo window.
- Write the form answers for each track using the tables above.

## Eligibility risk (read this)
The project history started before the hackathon (the protocol slice, SDK, contracts and the first platform phases pre-date the event window; `plan.md` and `docs/implementation-status.md` are dated 2026-11-06 but the repository has earlier work). Track rules that require from-scratch work, or that treat continued projects differently (Arkiv and 0G "Continuity" vs new-build rules), must be checked by the team against the official rules.
If in doubt, state clearly in the submission which components were built during the event (deployment registry/attestations, CRE workflow, deployment mirror and Arkiv reader, CI/CD, 0G assistant, issues/PRs/sessions) and which pre-existed (protocol SDK, RefRegistry, platform phases 1-2).
