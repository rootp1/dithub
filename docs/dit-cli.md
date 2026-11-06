# Git + dit: the Dithub command-line interface

Use `git` for source control and `dit` for Dithub platform features. After `dit login`, ordinary `git clone`,
`git fetch`, `git pull` and `git push` authenticate through a credential helper scoped to the exact Dithub host.
Issues, pull requests, organisations, protection, task-scoped sessions and verification remain first-class `dit`
commands. The older Git wrappers under `dit` remain compatibility aliases for now, but new examples use Git.

It is a separate package (`packages/dit`, name `@dithub/dit`, bin `dit`) and an HTTP client for the API in
`apps/api/src`. The older protocol-level CLI `dithub` (local network folder) is untouched.

## Install

```sh
# 1. from the repo, with Bun
bun link --cwd packages/dit        # puts `dit` on PATH     (or: export PATH="$PWD/bin:$PATH")

# 2. or build one self-contained binary and copy it anywhere on PATH
bun run build:dit                  # -> packages/dit/dist/dit
sudo cp packages/dit/dist/dit /usr/local/bin/dit
dit version
```

Requirements: `git` >= 2.30 on PATH. No other dependencies. `HTTPS_PROXY` is honoured.

## Quick start

```sh
dit login                          # prints a code, you approve it in the browser; nothing is pasted
dit whoami
git clone https://dithub.app/git/alice/web  # private repos work once you are logged in
cd web && echo hi > hi.txt && git add . && git commit -m "hi" && git push
dit issue create -t "Bug" -b "details"
dit pr create --push -t "Fix it"
dit pr merge 1 --squash
dit repo commits                   # per-commit Sepolia / Arkiv transactions
dit verify site                    # does the served frontend match the on-chain release?
```

Default host: `$DIT_HOST`, else the host in `config.json`, else `https://dithub.app`. Override per
command with `--host URL`. Repo-scoped commands infer `owner/repo` and the host from the `origin` remote, or take
`-R owner/repo`. Every command accepts `--json`; colour is used only when stdout is a TTY and `NO_COLOR` is unset.

Exit codes: `0` ok, `1` error (API refusal, network, git failure), `2` usage error. Expected failures print one
line plus a hint (401 suggests `dit login`; 403/409/422 show the server's reason, including merge blockers and
out-of-scope paths); stack traces only with `DIT_DEBUG=1`.

## Authentication

`dit login` uses a device-code flow:

1. `POST /api/cli/device` returns a long opaque `deviceCode` (kept by the CLI), a short `userCode` (`ABCD-EFGH`),
   a `verificationUrl`, `expiresIn` (600 s) and `interval` (5 s).
2. You open `{host}/cli?code=ABCD-EFGH`. If you are signed in on the site (the normal wallet session cookie) it
   shows "Approve dit on <host> as <login>" with Approve / Deny buttons; if not, it tells you to sign in first.
3. dit polls `POST /api/cli/token`; once approved it receives a fresh personal access token exactly once
   (named `dit on <machine>`) and stores it.

Server-side hardening (`apps/api/src/cli-auth.ts`, migration `0009_cli_auth.sql`): only sha256 hashes of the device
and user code are stored; codes live 10 minutes and are single-use; creation and polling are rate limited and
polling faster than the interval gets `slow_down`; the approval POST needs the session cookie, a same-origin
`Origin`, and a one-time CSRF value that was issued to that cookie and is cleared on use; the page escapes all
output, sends a strict CSP and has no redirects.

Other forms: `dit login --token-stdin` (CI: `echo "$PAT" | dit login --token-stdin --host ...`), `dit logout`
(revokes the token via `DELETE /api/cli/token` and deletes the local credential), `dit whoami`, `dit auth status`.
Environment overrides: `DIT_HOST`, `DIT_TOKEN` (used only for the primary host, never sent to other hosts).

Where things live: `$DIT_CONFIG_DIR`, else `$XDG_CONFIG_HOME/dit`, else `~/.config/dit`:
`credentials.json` (per host, mode 0600, directory 0700) and `config.json` (default host, current session; no secrets).

## How ordinary Git authenticates without exposing tokens

`dit login` adds a host-scoped `credential.<host>.helper = !dit credential` entry to the global Git config. The
entry contains no secret. Git calls `dit credential get` only when that exact scheme, host and port need a
credential; the helper reads the token from the protected dit credential file (or `DIT_TOKEN`) and answers only
for the smart-HTTP `/git/...` path. An empty host-scoped helper entry prevents a broader OS keychain helper from
copying the token elsewhere. Run `dit auth setup-git` to install or repair this integration without logging in
again. Remote URLs stay plain, such as `https://dithub.app/git/owner/repo`, so tokens never appear in argv, URLs,
`.git/config`, `git remote -v` or command output.

## Command reference

Global: `--host URL`, `--json`, `-R/--repo owner/repo`, `-h/--help`. `dit <command> --help` has examples.

| Command | What it does |
|---|---|
| `login [--token-stdin] [--no-browser]`, `logout`, `whoami`, `auth status`, `auth setup-git` | authentication and ordinary-Git integration |
| `auth username <new-login>` | rename your account (`PATCH /api/me`); the stored credential follows |
| `token create [--name N] [--out FILE \| --show]` | mint another personal access token; printed once, only when stdout is not a TTY or with `--show`, else written to `--out` (mode 0600) |
| `repo create [name] [--org o] [--private] [-d t] [--push]` | create a repo; inside a git repo it adds `origin` and can push |
| `repo list [--owner x]`, `repo view [owner/repo]` | list / show (view infers from `origin`) |
| `repo ls [path] [--ref r]`, `repo cat <path> [--ref r]`, `repo commits [-L n]`, `repo ledger` | browse tree / file / commits (with anchor status and Sepolia + Arkiv tx) / ledger (L1 anchors, Arkiv entities with expiry blocks) without cloning; normal permissions, no session header |
| `name resolve <owner/repo>` | repo id, claimant and Arkiv name entity |
| `deployments [list\|latest]` | release history from Arkiv (`source` says `arkiv` or `sqlite-fallback`): release, commit, bundleHash, attestation, tx hashes |
| `label list\|create <name> [--color hex] [-d text]\|edit <name>\|delete <name>` | labels |
| `repo collaborators list\|add <login> [-p perm]\|remove <login>`, `repo grant-team <team> <perm>` | access |
| `repo delete` | not available: the API has no delete endpoint |
| `protect set <pattern> [--approvals N] [--no-require-pr] [--allow-force-push] [--allow-deletions]`, `protect remove <pattern>`, `protect list` | branch protection |
| `issue list\|view\|create\|edit\|events\|comment\|close\|reopen\|label\|assign\|import`, `issue comment edit <id>`, `issue comment delete <id>` | issues (`create`/`edit` without flags open `$EDITOR`) |
| `pr list\|view\|create\|edit\|comment\|diff\|files\|checks\|review\|merge\|close\|reopen\|checkout` | pull requests (`pr comment` uses the shared issue-thread endpoint) |
| `org list\|view\|create\|members add\|remove\|team create\|add\|remove\|log` | organisations and teams |
| `session ...` | task-scoped sessions (below), including `session calls` (assistant history with sealed / REFUSED badges) |
| `task ...` | the 0G extension workflow in the terminal: assign, connect, scoped editing, assistant, review and PR submission |
| `verify site \| verify commit <sha> \| verify rebuild [...]` | independent verification (see below) |
| `recover <repo-id\|owner/repo> [dir]` | rebuild a repo from Arkiv alone (see below) |
| `credential get\|store\|erase` | git credential helper |
| `completion bash\|zsh`, `version` | misc |

Git itself handles `clone`, `init`, `add`, `commit`, `status`, `diff`, `log`, `fetch`, `pull`, `push`, `branch`,
`switch`, `checkout`, `merge`, `rebase`, `tag`, `stash`, `restore`, `reset` and `remote`. Existing `dit clone`,
`dit init`, `dit log` and unknown-command passthrough remain compatibility aliases during migration.

Notes:

- `pr checkout <n>`: pull requests here are same-repo branches, so there is no `refs/pull/N/head`. dit fetches
  the PR's head branch over git smart HTTP and checks it out (`checkout -B <head> --track origin/<head>`). Fork PRs
  do not exist yet.
- `pr checks <n>` shows approvals, required status checks and merge blockers (the API has no separate check-run
  listing); it exits 1 when the PR cannot be merged yet.
- `pr create --push` pushes the branch first. `pr review` needs exactly one of `--approve`, `--request-changes`,
  `--comment`.
- `log --anchors` joins `git log` with `GET /api/repos/:o/:r/commits` (latest 100 commits). Statuses:
  `pending`, `arkiv_done`, `anchored`, `failed`, `done_private` (private repos are not mirrored on-chain).
- Branch protection does not bind repository admins (platform rule); to see it block a push, push as a writer.

## 0G task workflow in the terminal

`dit task` provides the extension workflow without VS Code, a clone or an export. Sign in with `dit login`.
Both clients share the typed API client and scope checks in `packages/dit/src/tasks`.

Maintainer:

```sh
dit task repos
dit task issues -R acme/app
dit task assign 12 @dev -R acme/app
# 0G suggests paths and explains each one. Review/replace the paths, then confirm.
# Defaults: contractor, 8 hours. Override with --role employee --ttl 120.
dit task assign 12 @dev -R acme/app --dry-run --json   # inspect the plan without assigning
```

To choose scope yourself, use `--manual --path src/payments --path docs/api`. Each path is checked against
the repository tree before assignment. Suggestions and validation use the same ref; the approved ref is sent
when creating the session. Session creation also assigns the issue in the same server transaction. If 0G fails,
the command reports the failure and requires explicit paths or interactive manual selection.

Developer:

```sh
dit task                          # your active task inbox; --all includes inactive tasks
dit task connect                   # select a task (or supply its session id)
dit task show                      # issue, scope and countdown
dit task ls src/payments
dit task edit src/payments/retry.ts # opens one file in $VISUAL/$EDITOR
dit task edit src/payments/test.ts --new --from ./test.ts
dit task ask "Explain the retry limit"
dit task summarize
dit task calls
dit task status
dit task diff                      # review the edits
dit task submit -t "Fix payment retry" -b "Retry up to n times"
dit task end                       # confirm releasing access and discarding remaining drafts
```

`edit --from -` reads UTF-8 text from stdin. Source contents are preserved exactly, including `#` lines and
trailing newlines. `submit --path <file>` (repeatable) submits selected drafts; successful submission clears only
those drafts, and failure keeps them. As in the extension, submitted changes live in the PR branch; reading the
file afterwards shows the session ref again. Repository-file deletion/rename is not supported.

`dit task disconnect` keeps drafts and clears the current selection; reconnect to resume. `dit task discard
[path]` discards one or all drafts. `--session <id>` or `DIT_SESSION` selects a task for a single command.
The selection is shared with `dit session open` and isolated per host. Scripts use `--yes` to confirm assignment,
submission, discard or end, and can use `--json` for structured stdout; progress goes to stderr.

Every task operation rechecks `/api/tasks` before accessing repository contents or drafts. Out-of-scope reads
and writes are rejected locally and checked again by the server. Editing rechecks the grant after the editor
closes. Expired/revoked tasks cannot be resumed through the CLI. Authentication uses dit's existing per-host
credentials; tokens only travel in the Authorization header.

Drafts and their original comparison contents live in `$DIT_CONFIG_DIR/task-drafts` (or the usual dit config
directory), with mode 0600 files inside a 0700 directory, isolated by host and session. Editor/diff temporary
files are removed afterwards. These are local source copies; editors may create their own backups. Expiry
blocks CLI access but does not erase already saved drafts from disk; explicit `end` discards them.

Validation: `bun test packages/dit/test/task.test.ts` runs actual CLI subprocesses against a local API fixture
through assignment, connect, scoped edits, assistant calls, selected submission and end, plus denial/failure cases.

## Task-scoped sessions (IP-protected workflow)

Maintainer:

```sh
dit session create --issue 12 --login dev --role contractor --path src/payments --path docs/api --ttl 480 -R acme/app
dit session events <id>           # audit log: tree, blob, denied, export, proposal, proposal_rejected, ...
dit session revoke <id>
```

Developer (a contractor needs no repo access; the session is the only grant):

```sh
dit session list
dit session open <id>             # shows role, scope, countdown; remembered as the current session
dit session issue                 # the task text
dit session ls [path]             # scoped tree (directory names on the way to scoped paths only)
dit session cat src/payments/retry.ts
dit session ask "How does the retry work?"    # 0G sealed assistant: prints answer, 0G request id, model
dit session summarize
dit session export -o work && cd work         # in-scope files only, no history; git repo + baseline commit
$EDITOR src/payments/retry.ts
dit session propose -t "Add backoff" -b "..." # git diff vs baseline -> proposal -> PR link
dit session end
```

Denied paths print a red message and exit 1. Refused assistant questions print `REFUSED` (exit 1, no model call
was made). Out-of-scope proposals print the server's 422 reason and the offending paths. Requests carry
`x-dheet-session: <id>`; the current session is stored per host in `config.json` (or use `DIT_SESSION`).

`session export` extracts the tar with its own parser: it validates every entry before writing anything and
rejects absolute paths, `..`, backslashes, `.git` entries, hard links and special files, duplicate paths, symlinks
with absolute targets or targets that leave the folder, and files written below an archive symlink. The baseline
commit uses a throwaway identity and `core.hooksPath=/dev/null`; `propose` diffs through a temporary index so your
own staging area is untouched.

## Verification

- `dit verify site [--host URL]` fetches `/build.json` and every file, recomputes the sha256 of each file and the
  bundle hash (sha256 of the sorted name-to-hash JSON, as `apps/web/build.ts` does), then calls the Sepolia public
  RPC by hand (`eth_call` for `latestRelease()` and `latestAttestation()` on the contracts from
  `deployments/sepolia.json`, mirrored in `packages/dit/src/constants.ts`) and compares. Set `DIT_RPC_URL` to use
  another RPC. Exit 1 on any FAIL.
- `dit verify commit <sha|HEAD> [-R o/r]` looks up the commit's anchors through the API, checks the L1 transaction
  receipt with `eth_getTransactionReceipt` (status success), and that the Arkiv entity is listed in
  `/api/repos/:o/:r/ledger`.

- `dit verify rebuild [--release N | --commit SHA] [--source URL_OR_PATH] [--site URL] [--sandbox auto|docker|none] [--unsafe-local-build] [--json]`
  proves that the on-chain release equals a fresh build of the PUBLIC SOURCE, so nobody has to trust the publisher.
  It reads the release from DeployRegistry (`releaseCount` / `getRelease`; default the latest; `--commit` scans newest
  first), decodes the right-aligned 20-byte git sha from the `commit` bytes32, fetches only that commit into a
  fresh temp dir (default repo `https://github.com/rootp1/dithub.git`, or `$DIT_SOURCE_REPO`, or a local checkout
  path; shallow `git fetch --depth 1 origin <sha>` with a full-fetch fallback), checks `git rev-parse HEAD` equals
  the sha, and runs exactly what CI runs, `GIT_COMMIT=<sha> bun apps/web/build.ts`. It does **not** trust the built
  `build.json`: it re-hashes every output file itself (sha256, sorted keys, bundleHash = sha256 of the JSON map, as
  in `apps/web/build.ts`) and compares with the on-chain bundleHash, then with the live site (`--site`, default the
  release url): source == release == live. On a mismatch the files that differ from the live site are listed.
  Exit 0 only when everything matches, 1 on mismatch or failure, 2 on usage errors.
  - Building untrusted code runs that repo's own build script. `--sandbox auto` (default) uses Docker:
    `docker run --rm --network none --cap-drop ALL -v <src>:/src:ro -v <out>:/out -e GIT_COMMIT=<sha> oven/bun:<version>`
    where `<version>` is the `bun-version` pinned in the checked-out `.github/workflows/ci.yml` (else your local bun, with
    a warning); the source is copied to a writable temp dir inside the container. If Docker is missing or fails it
    **refuses**; to build locally you must pass both `--sandbox none --unsafe-local-build`, which runs your local
    bun in an empty-environment child (only `PATH`, `HOME=<temp dir>`, `GIT_COMMIT`; no inherited secrets).
  - Limits: fetch 5 minutes, build 10 minutes, output at most 50 MB; temp dirs (under `~/.cache/dit-tmp` on macOS so
    Docker VMs can mount them, else the system temp dir, or `$DIT_TMPDIR`) are always removed.
  - Tested: the `--sandbox none` and the Docker variants both reproduce release 11 (commit `4c22d2f`) exactly.

  Independent CI job (GitHub Actions) that fails if the published release is not reproducible from source:

  ```yaml
  # .github/workflows/verify-release.yml
  name: verify-release
  on:
    schedule: [{ cron: '17 5 * * *' }]
    workflow_dispatch: {}
  jobs:
    rebuild:
      runs-on: ubuntu-latest          # Docker is available; the build runs with --network none
      timeout-minutes: 20
      steps:
        - uses: oven-sh/setup-bun@v2.0.1
          with: { bun-version: 1.4.4 }
        - uses: actions/checkout@v4.2.2        # only to get the dit CLI
        - run: bun run build:dit
        - run: packages/dit/dist/dit verify rebuild --json | tee rebuild.json
        - run: packages/dit/dist/dit verify site
  ```

## Censorship resistance: `dit recover`

`dit recover <repo-id|owner/repo> [dir] [--manifest-hash 0x...] [--access-key KEY] [--arkiv-only]` rebuilds a
repository from **Arkiv alone**, without the Dithub server: it fetches the manifest and the chunks, checks the
manifest hash and every chunk hash, materialises a git clone (SDK `fetchRepositoryFromArkiv` + `cloneRepository`),
runs `git fsck --strict`, and prints the repo id, the manifest hash, the recovered commit hash and the number of
verified chunks.

- `--manifest-hash` is optional. Without it dit queries Arkiv for the repo's newest activity entity of kind `push`
  (schema `dheet-activity-v1`, attribute `repo` = repo id) and uses its `manifestHash`. Arkiv reads are untrusted
  (anyone can write entities of these schemas); the manifest and chunks are hash-verified, but which push is
  "newest" is Arkiv's answer, so pass `--manifest-hash` from a source you trust when it matters.
- `owner/repo` is resolved through the API, or through Arkiv name entities (`dheet-name-v1`, first claim wins) when
  the server is unreachable or with `--arkiv-only`. A raw `0x` repo id needs no resolution at all.
- Arkiv reads need an access key: get one at <https://hub.arkiv.network/access-keys> and pass `--access-key` or set
  `ARKIV_ACCESS_KEY`. dit scrubs the key from error messages (the RPC URL contains it).
- Limits: the Arkiv path only has code for **small PUBLIC repos on the default branch** (the server mirrors only
  those), and Arkiv entities **expire after about 182 days** unless renewed.
- The SDK is loaded lazily (`await import`), so other commands stay fast; it adds about 0.8 MB to the compiled
  binary (89.3 MB to 90.1 MB, most of which is the Bun runtime). The binary is built with
  `--no-compile-autoload-dotenv` so a stray `.env` in the current directory is not read.
- Verified against production: `dit recover rootp1/smoke-mw4iu8wl` yields manifest `0x9e83fe6b...` and commit
  `d2d078e5...`, `git fsck` clean, both through the API and with `--arkiv-only`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not signed in or token rejected` | `dit login` (or check `DIT_TOKEN`); `dit auth status` shows what is stored |
| `not found` on a repo you know exists | it is private and you are logged out, or you have no access (the API answers 404 on purpose) |
| `cannot reach https://...` | network, proxy (`HTTPS_PROXY`) or wrong `--host`/`DIT_HOST`; GETs are retried on 502/503 |
| `git push` asks for a password | run `dit auth setup-git`; also check `dit auth status` and the remote with `git remote -v` |
| browser says "Sign in first" on `/cli` | sign in on the site in the same browser, then reload the page |
| login code expired | codes last 10 minutes and work once; run `dit login` again |
| `no active session` | `dit session list` then `dit session open <id>` |
| 0G assistant error 502 | the sealed provider is unreachable; the CLI never invents an answer, retry later |
| debug output | `DIT_DEBUG=1` prints stack traces |

## Tests

`bun run test:dit` (unit tests: argument parsing, remote-URL inference, credential helper protocol, tar safety,
formatting, error mapping, credential storage permissions). End to end against a running API:
`BASE_URL=http://localhost:3300 bun scripts/e2e-dit.ts` (needs `DHEET_SEAT_KEY`, `DHEET_STRANGER_KEY`; set
`DIT_BIN=packages/dit/dist/dit` to test the compiled binary).
