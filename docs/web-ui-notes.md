# Web UI notes (apps/web)

Dependency-free TypeScript SPA. Sources: `apps/web/src/{app.ts,helpers.ts,verify.ts,index.html,style.css}`; build with `bun apps/web/build.ts` (output `apps/web/dist`, `build.json` is what the verifier compares). Tests: `bun test apps/web/src` (`verify.test.ts`, `helpers.test.ts`, `smoke.test.ts`; pure functions only, no DOM).

## Route map

| Route | Page | Endpoints |
|---|---|---|
| `/` | repo list | `GET /api/repos` |
| `/:o/:r` (`?path=`, `?file=`), `/commits`, `/ledger`, `/settings` | code, commits, ledger, settings (unchanged) | existing |
| `/:o/:r/issues` (`?state=&q=&page=`) | issue list + filter/search | `GET R/issues` |
| `/:o/:r/issues/new` | new issue | `POST R/issues` |
| `/:o/:r/issues/:n` | detail: comments, labels, assignees, close/reopen, timeline | `GET R/issues/:n`, `/comments`, `/events`; `POST /comments`, `/labels`, `/assignees`; `DELETE` label/assignee; `PATCH R/issues/:n` |
| `/:o/:r/pulls` (`?state=`) | PR list | `GET R/pulls` |
| `/:o/:r/pulls/new` | create PR (head/base from `GET /api/repos/:o/:r` refs) | `POST R/pulls` |
| `/:o/:r/pulls/:n` (`?tab=conversation\|commits\|files`) | detail, reviews, merge (strategy select), close | `GET R/pulls/:n`, `/mergeable`, `/reviews`, `/commits`, `/files`, `/diff`; `POST /reviews`, `/merge`; `PATCH` |
| `/:o/:r/sessions` | maintainer: create/list/revoke sessions, audit log (tab shown when `canWrite`) | `POST/GET R/sessions`, `POST /api/sessions/:id/revoke`, `GET /api/sessions/:id/events` |
| `/sessions` | my sessions | `GET /api/sessions` |
| `/sessions/:id` | scoped workspace | `GET /api/sessions/:id/issue`; scoped `GET R/tree`, `R/blob` with `x-dheet-session`; assistant `summarize`, `ask`, `calls`; `GET /export` (blob download); `POST /proposals` |
| `/deployments` | releases + "Verify this site" | `GET /api/deployments`, `/api/deployments/latest`, `/build.json`, served files, Sepolia JSON-RPC `eth_call` |

## Security

All dynamic strings pass through `esc()` (helpers.ts) before `innerHTML`; issue/PR/comment bodies, diffs, file contents and LLM answers are rendered as plain text (`white-space:pre-wrap`), no markdown. Etherscan links are built only for `0x`+64-hex hashes; release URLs only link when `https://`. No tokens in URLs. Session id goes only in the `x-dheet-session` header (scoped browse/export/proposals use `sapi()`).

## Verify this site

`verify.ts`: sha256 via `crypto.subtle`; `bundleHash = sha256(JSON.stringify(files))` with sorted keys (same as build.ts); `latestRelease()` selector `0x7be0ca5e`, `latestAttestation()` `0x24b6d96a` (checked with `cast sig` in the test); hand-written ABI decoding. Contract addresses are hard-coded from `deployments/sepolia.json`. Note: a locally-run build prints `commit: dev` and a different hash than the published release, so FAIL is expected outside the deployed site.

## Backend gaps / suggestions

- `GET /api/repos/:o/:r` exposes `canWrite` but not the caller's permission level; the sessions tab is shown when `canWrite` (write+), though only maintain+ may create sessions (others get a 403 message).
- `GET /api/sessions/:id` has no `owner`/`repo`; the workspace finds them via `GET /api/sessions` (own sessions only). Adding `owner`/`repo` to the single-session response would let maintainers open it too.
- Assistant `calls` history has no `sealed` flag; the UI shows "sealed on 0G" for every non-refused call that has a request id.
- Refused calls return `reason` plus `answer`; shown as refusal.
- Release `commit` from the API is a 32-byte left-padded hex (`0x000...a4d3...`); shown as-is.
- No endpoint to list branches except `refs` in the repo response (used for the PR form). Code-tab file links still call the repo endpoints without a session header.
- Not driven in a real browser: layout/behaviour verified only by typecheck, build and unit tests.
