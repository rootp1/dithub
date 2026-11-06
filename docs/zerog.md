# 0G Private Computer integration

The task-scoped assistant (issue summary and Q&A inside a contractor/employee session) runs every model call on
**0G Private Computer** (the 0G Compute Router at pc.0g.ai) and records the 0G request ID for each call.

## What breaks if 0G is removed

What breaks if 0G is removed: the assistant would have to send in-scope proprietary code to an ordinary third-party model provider that can read and log it (the sealed, TEE-only inference is the only reason a contractor-facing assistant is acceptable for IP-sensitive repos), and we would lose the per-call 0G request IDs that act as the audit trail tying every answer to a sealed execution.

## API facts (from the docs, verified live)

Sources:
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart.md
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy.md (privacy mode / trust tiers)
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions.md (`x_0g_trace`)
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution.md (`verify_tee`)
- https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/errors.md and `GET https://router-api.0g.ai/v1/models`
- (docs index: https://docs.0g.ai/llms.txt; pc.0g.ai itself is a JS app with no API docs)

| Item | Value |
| --- | --- |
| Base URL (OpenAI-compatible) | `https://router-api.0g.ai/v1` (`POST /chat/completions`, `GET /models`) |
| Auth | `Authorization: Bearer sk-...` (API key made in the pc.0g.ai dashboard; `mk-` keys are management only) |
| Sealed execution | request header `X-0G-Provider-Trust-Mode: private` routes to TeeML providers only (Intel TDX + TEE GPUs, prompt encrypted into the enclave, response signed inside). If none is available it returns 503, never a silent downgrade. Can also be set per API key in the dashboard. |
| Observed seal marker | response header `X-0G-E2ee: sealed` (we store it as `sealed`) |
| Request ID | body field `x_0g_trace.request_id` (also the `X-Request-Id` response header). Also returned: `x_0g_trace.provider` (on-chain provider address) and `ZG-Res-Key` header (chat id used for independent TEE signature verification). |
| Optional verification | `"verify_tee": true` in the body asks the Router to check the provider TEE signature and add `x_0g_trace.tee_verified`. We send it by default (`ZG_VERIFY_TEE=0` disables); with the current provider it returns no flag (`null`), a `false` is treated as an error. |
| Private-tier text models | `0gm-1.0-35b-a3b` (262k ctx, TDX/dstack attested; default), `glm-5.3` (TEE attested). Claude/GPT families are "standard" tier (not sealed) and must not be used here. |
| Thinking | `0gm-1.0-35b-a3b` is a reasoning model: with default settings the reasoning consumes `max_tokens` and `content` comes back empty. The client sends `chat_template_kwargs: {"enable_thinking": false}` for `0gm*` models (observed to work; `reasoning_effort` did not). |
| Rate limit | 500 requests/min per key (`X-Ratelimit-*` headers); 429 carries `Retry-After`. |
| Errors | OpenAI shape `{error:{message,type,code}, request_id}`; 401/402/403/429/502/503. |

## Code map

- `apps/api/src/zerog.ts` - typed client `chat({model, messages, temperature, maxTokens, user})` -> `{text, requestId, model, usage, provider, sealed, teeVerified, raw}`.
  Env: `ZG_API_KEY` (required), `ZG_BASE_URL`, `ZG_MODEL`, `ZG_TIMEOUT_MS`, `ZG_VERIFY_TEE`. 90 s timeout, 4 attempts with exponential backoff on network errors/429/5xx (honours `Retry-After`).
  Always sends the private trust header. Throws `ZeroGError` (message scrubbed of the key) when 0G fails; it never returns invented text.
- `apps/api/src/assistant-core.ts` - pure logic: `gitSource`, `retrieveContext`, `guardQuestion`, `buildMessages`, `redactOutput`, `runAssistant` (no DB/HTTP; unit-testable with an injected `chat`).
- `apps/api/src/assistant.ts` - Hono sub-app `assistant` (routes, DB persistence, rate limit, session events).
- `packages/db/migrations/0005_assistant.sql` - `assistant_calls` (request ID, sha256 prompt hash, tokens, latency, refused flag, capped answer; no prompts, no key).
- `scripts/zg-smoke.ts` (live calls), `scripts/e2e-assistant.ts` (+ `scripts/e2e-sessions-stub.ts`).

## Endpoints (all require `authenticate`)

- `POST /api/sessions/:id/assistant/summarize` -> plain-language summary, acceptance-criteria checklist, relevant in-scope files.
- `POST /api/sessions/:id/assistant/ask` `{question}` -> answer from issue text + in-scope files only.
- `GET  /api/sessions/:id/assistant/calls` -> caller's own history: `id, kind, model, requestId, refused, tokensIn/Out, latencyMs, question, answer, createdAt`.

Responses: `{callId, refused, answer, requestId, model, sealed, teeVerified, filesUsed, usage, redactions, createdAt}`.
Failures: 401, 404 (no such session for this user), 410 (expired), 429 (30 calls/hour/session), 502 (0G unavailable: clear error, `answer: null`).

## Scope enforcement (server side)

1. File listing and reads go only through `git ls-tree` / `git show <ref>:<path>` on the bare repo; every path is checked with `pathInScope(allowedPaths, path)` first. Out-of-scope names and contents are never put in a prompt, for any role.
2. Size caps: 40 KB per file, 60 KB total context, <=200 KB readable, binaries skipped (extension + NUL check).
3. Ranking is keyword overlap (path and content) against the question or issue; no external embedding service.
4. Pre-call guard refuses (no 0G call, stored `refused=true`, logged as `assistant.<kind>.refused` in session_events) questions naming existing out-of-scope paths/files, traversal or system paths, "whole repo"/"other modules"/`ls`-style requests and instruction-override attempts.
5. The system prompt confines the model to the ISSUE and FILES blocks and treats their text as data.
6. Output post-filter redacts any path-like token that is not an in-scope file or quoted from the issue/question.
7. Per-session rate limit 30/hour; expired sessions are rejected.

## Mounting (for the lead; index.ts is not edited by this work)

```ts
import { assistant } from './assistant.ts'   // add next to the other imports
app.route('/', assistant)                    // add after the other app.route(...) calls
```

Apply migration `0005_assistant.sql` (`bun apps/api/src/migrate.ts`). It requires `./sessions.ts` exporting
`loadSessionForUser`, `pathInScope`, `logSessionEvent` (contract in the task brief). Set `ZG_API_KEY` in the API's environment.

## Verifying

```sh
set -a; . ./.env.app; . ./.env; set +a
bun scripts/zg-smoke.ts        # two live 0G calls, prints request IDs
bun scripts/e2e-assistant.ts   # scope tests + live HTTP flow on a scratch Postgres database (dheet_assistant_e2e, dropped afterwards)
```

Independent proof for any stored request: take `x_0g_trace.provider` and the chat id and run `broker.inference.processResponse(provider, chatID)` from `@0gfoundation/0g-compute-ts-sdk` (see the verifiable-execution page above).
