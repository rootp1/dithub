# Phase 3 API: issues, pull requests, task-scoped sessions

All paths are under the API origin. Auth is the same as elsewhere (session cookie or `Authorization: Bearer <PAT>`). Errors are `{ "error": string }`. A repository the caller cannot read answers `404`. Migration: `packages/db/migrations/0004_phase3.sql`. Verified by `scripts/e2e-phase3.ts` (116 checks).

Notation: `R = /api/repos/:owner/:repo`. Permission levels: read < triage < write < maintain < admin (see `perm.ts`).

## Issues

Numbers are per repo and shared by issues and pull requests (atomic counter `repo_counters`, safe under concurrency). A PR is an issue row plus a `pull_requests` row, so comments, labels, assignees and the timeline are shared.

Issue object: `{ number, title, body, state: open|closed, stateReason, locked, author, isPullRequest, comments, labels: [{name,color,description}], assignees: [login], source, createdAt, updatedAt, closedAt }`.

| Method and path | Access | Notes |
|---|---|---|
| `POST R/issues` `{title, body?, labels?, assignees?}` | read + signed in (labels/assignees need triage) | 201 |
| `GET R/issues?state=open\|closed\|all&label=a,b&assignee=login&author=login&q=text&page=1&per_page=30` | read | `{total,page,perPage,issues}`; PRs excluded; label filter is AND |
| `GET R/issues/:n` | read | |
| `PATCH R/issues/:n` `{title?, body?, state?, stateReason?}` | author, or triage+ | author may close/reopen own issue; others need triage |
| `GET R/issues/:n/events` | read | timeline (opened, labeled, assigned, closed, merged, ...) |
| `GET R/issues/:n/comments`, `POST R/issues/:n/comments` `{body}` | read / signed in | works for PR threads too; locked issues need triage |
| `PATCH R/comments/:id` `{body}` | comment author | |
| `DELETE R/comments/:id` | author or triage+ | soft delete |
| `GET R/labels`; `POST R/labels` `{name,color,description?}`; `PATCH R/labels/:name`; `DELETE R/labels/:name` | read / triage | color is 6-hex |
| `POST R/issues/:n/labels` `{labels:[name]}`; `DELETE R/issues/:n/labels/:name` | triage | |
| `POST R/issues/:n/assignees` `{assignees:[login]}`; `DELETE R/issues/:n/assignees/:login` | triage | |
| `POST R/issues/import` `{url}` | triage | `https://github.com/<o>/<r>/issues/<n>`; fetched from the public GitHub API; stored in `source` (`provider,url,owner,repo,number,author,state,labels,importedAt`). PR URLs rejected. 502 if GitHub unreachable |

## Pull requests

Same-repo PRs only (`head` and `base` are branch names in this repo). PR object = issue object plus `state: open|closed|merged, draft, head, base, headOid, baseOid, mergeBaseOid, mergeable: clean|conflict|unknown, mergeMethod, mergedAt, mergeCommitOid, additions, deletions, changedFiles, fromSession, reviews: {approvals:[login], changesRequested:[login], requiredApprovals}, protection`. Open PRs are re-synced with the live branch tips on every read.

| Method and path | Access | Notes |
|---|---|---|
| `POST R/pulls` `{title, body?, head, base?, draft?}` | write | base defaults to the default branch; 409 on duplicate open PR; 422 if no new commits |
| `GET R/pulls?state=open\|closed\|merged\|all&page&per_page` | read | |
| `GET R/pulls/:n` | read | |
| `PATCH R/pulls/:n` `{title?, body?, state?: open\|closed, draft?}` | author or write | merged PRs cannot change state |
| `GET R/pulls/:n/files` | read | `[{path, oldPath, status: added\|modified\|deleted\|renamed, additions, deletions}]` |
| `GET R/pulls/:n/diff` | read | `text/plain` unified diff (merge-base to head, 2 MB cap) |
| `GET R/pulls/:n/commits` | read | |
| `GET R/pulls/:n/mergeable` | read | `{mergeable, canMerge, blockers: [string]}` |
| `GET R/pulls/:n/reviews` | read | reviews with inline comments |
| `POST R/pulls/:n/reviews` `{event: approve\|request_changes\|comment, body?, comments?: [{path,line,side?: LEFT\|RIGHT,startLine?,body}]}` | comment: read; approve/request_changes: write and not the PR author | review is pinned to the current head oid |
| `POST R/pulls/:n/merge` `{method?: merge\|squash\|rebase, commitTitle?, commitMessage?}` | write | 409 with `blockers` if not mergeable |

Merge rules: PR open, not draft, no conflict, no outstanding `changes_requested`, and if a branch protection pattern matches the base: at least `required_approvals` approvals from users with write access, on the current head (a new push makes older approvals stale), plus every `require_status_checks` name must have a latest `check_runs.conclusion = 'success'` for the head. Merging via PR is how protected branches advance: the server updates the ref itself (compare-and-swap with `git update-ref`), so the `pre-receive` `require_pr` rule does not apply. The update is recorded exactly like a push (`pushes` row, `git_refs`, `commits`, `commit_anchors`, `activity`, outbox `push` entry), so the worker anchors it on L1/Arkiv. Merges run with git plumbing (`merge-tree --write-tree`, `commit-tree`) in memory, so no worktree or checkout exists and there is nothing to clean up; this needs git >= 2.38. Strategies: `merge` (two-parent commit), `squash` (one commit, PR author as author), `rebase` (commits replayed one by one onto base, original authors kept, merger as committer; conflict aborts).

## Task-scoped sessions (need-to-know access)

A maintainer gives a developer a time-boxed session tied to one issue and a list of path prefixes. The developer sees and exports only those paths. Table `task_sessions` (the name `sessions` is already the login-session table) and `session_events` (audit log).

Session object: `{ id (uuid), repoId, issueNumber, user, createdBy, role, allowedPaths, ref, status: active|ended|expired, expiresAt, createdAt, endedAt, endReason }`.

| Method and path | Access | Notes |
|---|---|---|
| `POST R/sessions` `{issueNumber, login, role: contractor\|employee\|maintainer, paths: [..], ttlMinutes?: 1..1440 (default 480), ref?}` | maintain+ | paths required (1-50) for contractor/employee; maintainer role defaults to everything. Assigns the user to the issue. 409 if that user already has an active session for the issue |
| `GET R/sessions?status=` | maintain+: all; others: own | |
| `GET /api/sessions?status=` | signed in | your own sessions across repos (adds `owner`, `repo`) |
| `GET /api/sessions/:id` | the developer or a maintainer | |
| `GET /api/sessions/:id/issue` | the developer (while active) or a maintainer | `{number,title,body,state}` of the task |
| `POST /api/sessions/:id/end` | the developer or a maintainer | |
| `POST /api/sessions/:id/revoke` | maintainer | |
| `GET /api/sessions/:id/events` | maintainer | audit log, newest first: `create, tree, blob, commits, export, proposal, proposal_rejected, denied, clone_denied, end, revoke` |
| `GET /api/sessions/:id/export` | the session user | `application/x-tar`, built from the in-scope files at `ref` only, no history |
| `POST /api/sessions/:id/proposals` `{patch, title?, body?}` | the session user | unified diff (`git diff` output, <= 1 MB) |

### Using a session

Send `x-dheet-session: <id>` (or `?session=<id>`) on the normal code-browser endpoints. The caller must be the session user and the session active (not ended, revoked or expired), else `403`. A session is the only thing that grants a contractor/employee access to a private repo; without the header they get `404` like any stranger. (On a public repo everyone can read everything anyway, so sessions only protect private/internal repos. Do not also give the developer collaborator access.) Sessions grant read access only.

| Endpoint | Behaviour with a session |
|---|---|
| `GET R` | refs limited to the session ref; adds `session: {id, role, ref, issueNumber, expiresAt}`; `canWrite=false` |
| `GET R/tree?path=` | contractor: entries inside scope plus the directories leading to them. employee: same, plus at the repo root only, every top-level name as `{type,name,path,restricted:true}` (no oid, size or mode). Other paths: `403` |
| `GET R/blob?path=` | in scope: content. Everything else (also nonexistent files, so existence is not an oracle): `403` |
| `GET R/commits` | `{commits:[{oid,subject,author,email,committedAt,files}], scoped:true}`: only commits touching in-scope paths, `files` lists in-scope files only (no anchors) |
| `GET R/ledger` | `403` |
| `GET /git/:owner/:repo/...` | clone/fetch/push: `403` for contractor and employee (clone would reveal everything). Maintainer-role sessions may clone/fetch; pushes always use normal write permission |

`ref` must be omitted or equal the session ref (other refs: `403`). Every read, denial, export and proposal is written to `session_events`.

### Roles

- **contractor**: in-scope files only; commit history only where it touches in-scope paths; no clone, no top-level listing; sees only the directory names on the way to scoped paths.
- **employee**: contractor rules plus the names (not contents or metadata) of the top-level entries.
- **maintainer**: normal read access to the whole ref (scope ignored), may clone; every access is still audited.

### Path rules

Scope entries and requested paths are normalised: NFC only (other Unicode forms are rejected), no absolute paths, no `..` or `.` or empty segments, no backslashes, NUL/control characters, bidi/zero-width characters or `.git` segments, no leading `:` and (for reads) no glob characters. Matching is by whole path segments and case-sensitive (like git), so `src` matches `src/a.ts` but not `srcx/a.ts` or `SRC/a.ts`. Scope entries may use `*` inside a segment (`src/*.ts` style segments) or a trailing `**`; the first segment may not be a wildcard (except for maintainer sessions). Request paths are never passed to git as pathspecs, only as literal `ref:path`.

### Proposals

`POST /api/sessions/:id/proposals` checks the patch with `git apply --numstat` (every touched path, including rename sources and targets, must be in scope), applies it to a temporary index (no worktree), re-checks the full resulting diff against the session base, then commits to branch `session/<issueNumber>-<login>` (authored by the developer), records it as a push, and opens a PR into the session ref (or reuses the open PR when the branch already has one; further proposals stack on the branch). `201 {branch, commit, pullRequest, files}`. Rejection is `422 {error, paths}` and is logged as `proposal_rejected`. The PR is a normal PR (`fromSession: true`); a maintainer reviews and merges it.

### Audit / RBAC log

Create, end and revoke call `recordRbac` (`session.create`, `session.end`, `session.revoke`). Payload holds only ids and counts (`session, repo, issue, user, role, pathCount, ttlMinutes`), never paths or issue text. For repos owned by a public org the event is mirrored to Arkiv like other RBAC events; user-owned repos only get an `audit_log` row.

### Helpers for other server code (`apps/api/src/sessions.ts`)

`loadSessionForUser(sessionId, userId)`, `pathInScope(allowedPaths, path)`, `logSessionEvent(sessionId, actorId, kind, detail)`, `resolveAccess(c, repo, need)`.

## VS Code flow (scope suggestions, task inbox, repo picker, files proposals)

Migration `packages/db/migrations/0010_vscode_flow.sql` (`scope_suggestions`). Code: `apps/api/src/suggest-scope.ts`, `apps/api/src/tasks.ts`, `apps/api/src/sessions.ts` (proposals). Unit tests: `bun test apps/api/test`. End to end (live 0G): `BASE_URL=http://localhost:3400 bun scripts/e2e-vscode-flow.ts` with `DHEET_SEAT_KEY` (maintainer) and `DHEET_STRANGER_KEY` (developer) in the environment.

Flow: the maintainer picks an issue, asks 0G for the relevant paths (`suggest-scope`), reviews them, assigns the issue (`POST R/issues/:n/assignees`) and creates a contractor session with the approved paths (`POST R/sessions`). The developer never gets repository access: `GET /api/tasks` lists their sessions, reads go through `R/tree` and `R/blob` with `x-dheet-session`, the assistant through `/api/sessions/:id/assistant/*`, and edits come back as a PR via `POST /api/sessions/:id/proposals` (files variant).

| Method and path | Access | Notes |
|---|---|---|
| `POST R/issues/:n/suggest-scope` `{maxPaths?: 1..25 (default 8), ref?}` | signed in, maintain+ | `200 {paths:[{path, kind: file\|dir, reason}], model, requestId, sealed, ref, considered}`. 401 anonymous; 404 unknown repo/issue or a repo the caller cannot read; 403 readable but below maintain; 400 bad body/ref; 422 unknown ref; 429 more than 20 calls/hour/user (failed calls count); 502 `{error, requestId?}` when 0G fails or returns no valid path; 503 when 0G is not configured |
| `GET /api/tasks` | signed in | `{tasks:[{sessionId, repo:{owner,name}, issue:{number,title,state}, role, allowedPaths, ref, status: active\|ended\|expired\|revoked, expiresAt, createdAt, createdBy}]}`: every session whose user is the caller, active first then newest (max 500). Needs no repository permission. Revoked = ended by a maintainer's revoke |
| `GET /api/me/repos?min=read\|triage\|write\|maintain\|admin` | signed in | `{repos:[{owner, name, visibility, permission, defaultBranch, repoId}]}`: repos the caller has a role in (owner, org member, team grant, collaborator; site admins: all) at `min` or above; `permission` is the effective level. Public repos with no relationship are not listed; sessions never count. 400 on a bad `min` |
| `POST /api/sessions/:id/proposals` `{files:[{path, content}], title?, body?}` | the session user | files variant, see below. The `{patch}` variant is unchanged; sending both is 400 |

### suggest-scope

1. Candidates: `git ls-tree -r <ref>` on the bare repo, minus binaries (by extension), lockfiles, `node_modules`, `dist`, `vendor`, `.git` and similar build/vendored dirs.
2. Ranking: keyword overlap (light stemming) between the issue title/body and the path. The model gets at most 1,500 paths (most relevant kept) and, for up to 40 top-ranked files, the first 25 lines (lines cut at 200 chars, 30 KB total).
3. Prompt: the issue is wrapped in random `<ISSUE_xxxxxxxxxxxx>` markers and declared untrusted; the model is told to ignore instructions inside it, to pick only listed paths, the minimal set (files or the narrowest directory), never the root, and to answer with `{"paths":[{"path","reason"}]}` only. The call goes through `chat` in `zerog.ts` (0G Private Computer, private trust tier, with its sealed-model fallback).
4. Validation (`validateSuggestion`, pure): first JSON object (code fences/prose tolerated); paths normalised (`./` and trailing `/` stripped; absolute, `..`, `.`/empty segments, globs, control/bidi characters, `.git`, root rejected); kept only if an exact file or a real directory prefix (segment boundary) of the listed tree; deduplicated; entries inside another returned directory dropped; capped to `maxPaths`; reasons cut to 200 chars. Nothing valid -> 502, paths are never invented.
5. Records: one `scope_suggestions` row per call (validated paths, model, 0G request id; failures with `error`), and an `audit_log` row `issue.suggest_scope` with `{issue, pathCount, model, requestId}` only (no paths, no issue text).

### Proposals: files variant

`{files:[{path, content}]}` with 1-200 files, each <= 1 MB of UTF-8 and <= 5 MB in total (else 400). Every path is normalised like a read path and must satisfy `pathInScope` (else `422 {error, paths}`, logged as `proposal_rejected`); new files are allowed only inside the scope; duplicate paths are 400. The server builds the change itself on top of the session branch tip (or the session ref when the branch does not exist yet): each file is written with `git hash-object -w --stdin`, staged with `update-index --index-info` on a temporary `GIT_INDEX_FILE` (existing executable bits kept, symlinks/submodules not editable, file/directory collisions rejected), files identical to the base are skipped, and when nothing changes the answer is `422 {error: 'no changes'}`. Then the same path as the patch variant: full-diff scope re-check against the session base, `write-tree`, `commit-tree`, compare-and-swap `update-ref` on `session/<issue>-<login>`, recorded as a push, PR opened (or reused). Response `201 {branch, commit, pullRequest, files}` (`files` = files actually changed); session event `proposal` (with `variant: 'files'`).
