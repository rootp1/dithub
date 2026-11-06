# Dithub VS Code extension

`packages/vscode` (name `dithub-vscode`, publisher `dithub`, VS Code >= 1.90). A maintainer clicks **Assign with 0G** on an
issue and types `@username`. 0G reads the issue and picks the relevant files. The developer then works on only those
files from a **My Tasks** list. The developer never gets repository access, and nothing is cloned or exported.

## Install

```sh
bun run build:vscode          # -> packages/vscode/dist/extension.js
bun run package:vscode        # -> packages/vscode/dithub-vscode.vsix
code --install-extension packages/vscode/dithub-vscode.vsix --force
```

Setting: `dithub.host` (default `https://172-105-43-184.sslip.io`). Run **Dithub: Sign in**. The extension shows a one-time code
and opens `<host>/cli?code=…`. Check that the code matches, sign in on the site, and press Approve. **Dithub: Sign out**
revokes the token on the server (`DELETE /api/cli/token`) and deletes it locally.

## Maintainer flow (Issues view)

1. **Choose repository…** lists repositories you maintain (`GET /api/me/repos?min=maintain`). The view shows its open issues (`GET …/issues?state=open`).
2. Click **Assign with 0G…** (the sparkle button or the context menu) on an issue and type `@username` (validated as a Dithub login).
3. "0G is reading the issue and choosing files…" calls `POST …/issues/:n/suggest-scope {maxPaths: 8}`. Every suggested path appears pre-selected, with 0G's reason as the detail. Use the **+** button to add a path by hand; it is checked against `GET …/tree`.
   If 0G fails (502/503/429), the extension says so and offers manual selection. It never makes up paths.
4. Pick a role (contractor is the default; employee) and a duration (2h, 8h default, 24h).
5. A confirmation dialog summarises the user, paths, role, duration, 0G model and request id. Confirming calls `POST …/issues/:n/assignees` and then `POST …/sessions`. The new session id is shown.

## Developer flow (My Tasks view)

- `GET /api/tasks` lists `owner/repo #N title` with the role and a countdown, plus a tooltip of the allowed paths. It refreshes every 60 s, and you can also refresh by hand.
- **Connect with 0G** (the status-bar button or the inline action on a task) adds the virtual folder `dithub-task://<sessionId>/` to the workspace:
  - listings and reads use `GET …/tree` / `GET …/blob` with `x-dheet-session: <id>` and the session ref;
  - paths outside the scope never appear. They are checked on the client before any request, and the server checks them again;
  - edits, new files and new folders go to an overlay in `ExtensionContext.workspaceState`, keyed by session. Writes outside the scope fail with `FileSystemError.NoPermissions`.
- **Show task**: the issue title and body (`GET /api/sessions/:id/issue`) in a webview with no scripts.
- **Ask 0G**: a chat webview (`assistant/summarize`, `assistant/ask`, history from `assistant/calls`). Each answer shows the model, the 0G request id and a "sealed on 0G" badge. Refusals are marked REFUSED.
- **Submit changes**: lists changed files from the overlay (all selected, with a diff button that opens `vscode.diff` of the original against your edit). It asks for a PR title and an optional description, then sends `POST /api/sessions/:id/proposals {title, body, files:[{path, content}]}`. On success it shows the PR link and clears the submitted files from the overlay. A 422 is shown with its reason and any out-of-scope paths.
- **End task**: `POST /api/sessions/:id/end`, then removes the folder and discards the overlay.
- Expired, ended or revoked sessions are detected two ways: by the countdown and `/api/tasks`, or by a dead-session 403 from tree/blob. When that happens the extension shows a message and removes the folder.

## Security model

- The token is stored only in `vscode.SecretStorage` (key `dithub.token:<host>`) and sent only as `Authorization: Bearer`. It never goes in URLs, settings, workspaceState, logs or error messages. The device flow uses `/api/cli/device` and `/api/cli/token` (RFC 8628 style).
- Repository content is not written to disk as files. Reads are held in memory. Your edits live in VS Code's workspace state; VS Code's own editor buffers and hot-exit backups still apply.
- Scope is enforced twice. The client checks every path against `allowedPaths` (the same segment and glob rules as `apps/api/src/sessions.ts`) before any tree, blob or proposal request. The server then enforces the session again, and its decision is the one that counts.
- Webviews use a CSP of `default-src 'none'`, with a nonce for the one script and the style; the task view has no script at all. Content is inserted with `textContent` or HTML-escaped. Messages from the webview are validated, and nothing is evaluated.

## Code map

`src/core.ts` holds the pure logic: login parsing, scope checks, overlay diffing, response parsing, countdowns and error text. `src/html.ts` holds the pure webview HTML.
`src/api.ts` is a typed client with no `vscode` import (timeouts, GET retries, local scope checks). The VS Code modules are `src/auth.ts`, `issuesView.ts`, `tasksView.ts`,
`taskStore.ts`, `taskFs.ts`, `assign.ts`, `assistantPanel.ts`, `submit.ts` and `extension.ts`.

## Tests

```sh
bun test packages/vscode                     # pure logic, HTML/CSP, API client against a mocked fetch
set -a; . ./.env.app; . ./.env; set +a
PORT=3500 PUBLIC_URL=http://localhost:3500 bun apps/api/src/index.ts &
BASE_URL=http://localhost:3500 bun scripts/e2e-vscode-api.ts   # both roles end to end through src/api.ts (live 0G when ZG_API_KEY is set; E2E_ASK=0 skips assistant calls)
```

## Limitations

- Deleting or renaming files that exist in the repository is not supported, because the files proposal has no deletions. Only files you created in the task can be deleted or renamed.
- Only UTF-8 text is supported. Binary files and files over 1 MB cannot be opened or edited.
- Text search (Ctrl+Shift+F) does not search virtual `dithub-task` folders, because VS Code has no stable search-provider API. Quick Open and the explorer do work.
- Adding the first folder to an empty window makes VS Code reload it. The task list is fetched again afterwards, and no task metadata is persisted.
- After a submit, the folder shows the session ref again; the changes are in the PR branch. A later submit stacks on the same branch.
