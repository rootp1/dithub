import { VERSION } from './constants.ts'

const G = `Global options (every command):
  --host <url>     Dithub host (default: $DIT_HOST, config, or the production site)
  --json           machine-readable output
  -R, --repo <o/r> repository (default: inferred from the \`origin\` remote)
  -h, --help       show help
Environment: DIT_HOST, DIT_TOKEN (CI), DIT_CONFIG_DIR, DIT_SESSION, NO_COLOR, HTTPS_PROXY`

export const TOP = `dit ${VERSION}: Dithub's platform command-line client

Usage: dit <command> [options]

Platform commands
  login / logout / whoami / auth     sign in (device flow), sign out, who am I, status
  repo create|list|view|collaborators|grant-team
  protect set|remove|list            branch protection
  issue list|view|create|comment|close|reopen|label|assign
  pr list|view|create|diff|files|checks|review|merge|close|reopen|checkout
  org list|view|create|members|team|log
  task assign|connect|edit|ask|diff|submit   the 0G extension workflow in your terminal
  session list|open|issue|ls|cat|export|ask|summarize|propose|end   task-scoped access
  session create|revoke|events       (maintainers)
  label list|create|edit|delete      issue labels
  keys init|register|show            this device's key for private repositories
  token create                       mint an extra personal access token (never echoed to a terminal)
  name resolve <owner/repo>          repo id, claimant and Arkiv entity of a name
  deployments [list|latest]          release history (Arkiv, with SQLite fallback) and attestations
  verify site|commit|rebuild         check the site / a commit / the on-chain release against its public source
  recover <repo> [dir]               rebuild a repo from Arkiv alone, without the Dithub server
  credential get|store|erase         git credential helper (called by git)
  completion bash|zsh                print a shell completion script
  version                            print the version

Use Git for source-control operations: git clone, init, add, commit, status, diff, log, fetch, pull,
push, branch, switch, checkout, merge, rebase, tag, stash, restore, reset and remote. Use dit for
Dithub platform operations. \`dit login\` configures Git's credential helper for the selected host.

The older dit wrappers for Git commands remain as compatibility aliases for now.

${G}

Run \`dit <command> --help\` for details and examples.`

const H: Record<string, string> = {
  task: `dit task [list|repos|issues|assign|connect|show|ls|cat|edit|status|diff|submit|ask|summarize|calls|discard|disconnect|end]

The same scoped task workflow as the VS Code extension, directly in the terminal. Sign in with dit login.
No clone, repository access or export is needed. Drafts are kept in a private local store, and editing opens
one temporary file in $VISUAL/$EDITOR. Only in-scope UTF-8 files up to 1 MB can be edited.

Maintainers:
  dit task repos                              repositories you maintain
  dit task issues -R owner/repo                open issues
  dit task assign <issue> @login -R owner/repo  0G scope suggestions, review, confirm, assign
      [--role contractor|employee] [--ttl minutes] [--ref branch]
      [--path path ...]    explicit paths replace the suggested set; still reviewed
      [--manual]          skip 0G and supply paths yourself
      [--dry-run]         show the plan without creating a session
      [--yes]             accept the displayed scope and assignment without prompting
      defaults: contractor, 480 minutes; max: 1440 minutes

Developers:
  dit task [list] [--all]                      My Tasks; active tasks by default
  dit task connect [session-id]                choose a task and remember it for this host
  dit task show                               issue, scope and remaining time
  dit task ls [dir]                            scoped files, including local drafts
  dit task cat <path>                          your draft, or the scoped original
  dit task edit <path> [--new] [--from file|-]  editor, local UTF-8 file, or stdin
  dit task status                             edited and added files
  dit task diff [path]                         review changes (requires git)
  dit task submit -t title [-b description] [--path path ...] [--yes]
                                               open/update a PR with selected drafts
  dit task ask "question"                      sealed 0G assistant
  dit task summarize                          issue summary and acceptance criteria
  dit task calls                              assistant history
  dit task discard [path] [--yes]              discard one/all drafts
  dit task disconnect                         keep drafts, clear the current selection
  dit task end [--yes]                         release access and discard drafts

Use --session <id> or DIT_SESSION to select a task without connecting. All task commands support --host and
--json. Scripts must pass --yes for assignment/submission/discard/end. A failed submission keeps your drafts.
Existing repository files cannot be deleted or renamed through files proposals.

Examples:
  dit task assign 12 @dev -R acme/app
  dit task assign 12 @dev -R acme/app --manual --path src/payments --yes
  dit task connect
  dit task edit src/payments/retry.ts
  dit task ask "Explain the retry limit"
  dit task diff
  dit task submit -t "Fix payment retry"`,
  login: `dit login [--host URL] [--no-browser] [--token-stdin]

Sign in with a device code: dit prints a short code and a URL, you approve it in the browser (where you are
already signed in with your wallet), and dit stores a fresh personal access token in
~/.config/dit/credentials.json (mode 0600). No key or token is ever typed into the terminal.

  --token-stdin   read an existing personal access token from stdin (for CI)
  --no-browser    do not try to open the browser

Examples:
  dit login
  dit login --host https://dithub.example.com
  echo "$DITHUB_TOKEN" | dit login --token-stdin --host https://dithub.example.com
  DIT_TOKEN=... dit whoami        # CI without a credentials file`,
  logout: `dit logout [--host URL]

Revokes the stored token on the server (best effort) and deletes the local credential.

Example:
  dit logout`,
  whoami: `dit whoami [--host URL] [--json]

Prints the login you are authenticated as; exits 1 when not logged in.

Examples:
  dit whoami
  dit whoami --json`,
  auth: `dit auth [status|login|logout|setup-git|username <new-login>]

Shows each host you hold credentials for, whether the token still works, and where it comes from.

  dit auth username <new-login>   rename your account (PATCH /api/me); remotes with the old name need set-url
  dit auth setup-git              install/repair the host-scoped Git credential helper

Examples:
  dit auth status
  dit auth username alice`,
  clone: `dit clone <target> [dir] [git clone flags...]

Compatibility alias. Prefer: git clone https://HOST/git/OWNER/REPO [dir]

target is owner/repo, owner/repo@host, or a full Dithub URL. The repo is resolved through the API first
(clear errors for missing repos or no access), then the real git clone runs. The token is never placed in the
URL, argv or .git/config: git asks \`dit credential\`, and the clone is configured with
credential.<host>.helper = !dit credential so plain git push/pull keep working.

Examples:
  dit clone alice/web
  dit clone alice/web my-dir --depth 1 --branch dev
  dit clone alice/web@https://dithub.example.com
  dit clone https://dithub.app/git/alice/web.git`,
  init: `dit init [dir] [--remote[=name]] [--org o] [--private] [--description text] [git init flags]

Compatibility alias. Prefer git init, then dit repo create, git remote add and git push.

Runs git init. With --remote also creates the platform repo (name defaults to the folder name), adds
\`origin\`, and wires the credential helper.

Examples:
  dit init
  dit init my-project --remote --private
  dit init --remote --org acme`,
  repo: `dit repo <create|list|view|collaborators|grant-team> ...

  dit repo create [name] [--org o] [--private] [-d text] [--push]
        inside a git repo: adds the origin remote (and with --push pushes the current branch)
  dit repo list [--owner login]
  dit repo view [owner/repo]
  dit repo ls [path] [--ref r]      browse the tree without cloning (normal permissions)
  dit repo cat <path> [--ref r]     print a file
  dit repo commits [-L n]           commits with anchor status and L1 / Arkiv tx
  dit repo ledger                   L1 anchors and Arkiv entities (with expiry blocks)
  dit repo collaborators list|add <login> [-p read|triage|write|maintain|admin]|remove <login>
  dit repo grant-team <team> <permission>        (organisation repos)
  (repo delete is not available: the API has no delete endpoint)

Examples:
  dit repo create my-app --private -d "internal tools" --push
  dit repo view alice/web
  dit repo collaborators add bob -p write -R alice/web`,
  protect: `dit protect set|remove|list <branch-pattern> [-R owner/repo]

  dit protect set main [--no-require-pr] [--approvals N] [--allow-force-push] [--allow-deletions]
  dit protect remove main
  dit protect list

Examples:
  dit protect set main --approvals 1
  dit protect list --json`,
  issue: `dit issue <list|view|create|comment|close|reopen|label|assign|import> [-R owner/repo]

  dit issue list [-s open|closed|all] [-l label] [-a assignee] [--author login] [-q text] [-L n]
  dit issue view <n> [--comments]
  dit issue create [-t title] [-b body] [-l label] [-a login]     (no -t: opens $EDITOR)
  dit issue edit <n> [-t title] [-b body]      (no flags: opens $EDITOR)
  dit issue events <n>                          timeline
  dit issue comment <n> [-b text]
  dit issue comment edit <id> [-b text]       dit issue comment delete <id>
  dit issue close <n> [--reason completed|not_planned]      dit issue reopen <n>
  dit issue label <n> bug,help-wanted | --add a --remove b
  dit issue assign <n> <login>... [--unassign]
  dit issue import <github-issue-url>

Examples:
  dit issue create -t "Login fails on Safari" -b "Steps: ..."
  dit issue list -s all --json
  dit issue close 12 --reason not_planned`,
  pr: `dit pr <list|view|create|edit|comment|diff|files|checks|review|merge|close|reopen|checkout> [-R owner/repo]

  dit pr list [-s open|closed|merged|all]
  dit pr view <n> [--comments]
  dit pr create [-t title] [-b body] [--head branch] [--base branch] [--draft] [--push]
  dit pr edit <n> [-t title] [-b body]
  dit pr comment <n> -b text
  dit pr diff <n>        dit pr files <n>
  dit pr checks <n>      reviews, required status checks, merge blockers (exit 1 if it cannot merge)
  dit pr review <n> --approve | --request-changes -b text | --comment -b text
  dit pr merge <n> [--merge|--squash|--rebase]
  dit pr close <n>       dit pr reopen <n>
  dit pr checkout <n>    fetches the PR's head branch and checks it out (PRs are same-repo branches, so
                         there is no refs/pull/N/head; a normal fetch of the branch is used)

Examples:
  dit pr create --push -t "Add retry" -b "Fixes #3"
  dit pr review 7 --approve
  dit pr merge 7 --squash`,
  org: `dit org <list|view|create|members|team|log>

  dit org list
  dit org view <org>
  dit org create <org> [--private]
  dit org members add <org> <login> [--role owner|member]
  dit org members remove <org> <login>
  dit org team create <org> <slug> [--name text]
  dit org team add <org> <team> <login>      dit org team remove <org> <team> <login>
  dit org log <org>        the hash-chained RBAC log

Examples:
  dit org create acme
  dit org members add acme bob
  dit org team add acme backend bob`,
  session: `dit session <subcommand>      (task-scoped, IP-protected access)

Developer:
  dit session list [--status active]
  dit session open <id>            sets the current session; shows scope, role, countdown
  dit session issue                the task text
  dit session ls [path]            scoped tree
  dit session cat <path>           scoped file (out-of-scope paths are refused, exit 1)
  dit session export [-o dir]      in-scope files only, no history; creates a local git repo with a baseline commit
  dit session ask "question"       sealed 0G assistant (prints the 0G request id and model; refusals are marked)
  dit session summarize
  dit session propose [-t title] [-b body]    (run inside the exported folder) diff vs baseline -> proposal -> PR
  dit session calls                past assistant calls: model, 0G request id, sealed / refused badges
  dit session end
Maintainers:
  dit session create --issue N --login dev [--role contractor|employee|maintainer] --path src/payments [--path ..] [--ttl 480] [-R o/r]
  dit session revoke <id>
  dit session events <id>

Example workflow:
  dit session list && dit session open 3f2a...
  dit session export -o work && cd work
  $EDITOR src/payments/retry.ts
  dit session propose -t "Add retry backoff"`,
  verify: `dit verify site [--host URL] | dit verify commit <sha> [-R owner/repo] | dit verify rebuild [...]

  rebuild  prove the on-chain release equals a fresh build of the PUBLIC SOURCE at that commit:
             dit verify rebuild [--release N | --commit SHA] [--source URL_OR_PATH] [--site URL]
                                [--sandbox auto|docker|none] [--unsafe-local-build] [--json]
           Fetches only that commit (default repo https://github.com/rootp1/dithub.git, or $DIT_SOURCE_REPO),
           builds it exactly like CI (GIT_COMMIT=<sha> bun apps/web/build.ts) inside Docker (--network none,
           source read-only, pinned bun image) and re-hashes every output file itself. Without Docker it refuses,
           unless you pass both \`--sandbox none --unsafe-local-build\` (empty-environment local child).
           Then compares with the on-chain bundleHash and the live site. Exit 0 only when all match.

  site     recompute the hashes of the files the site serves and compare them with the latest release and
           attestation on Base (manual JSON-RPC, no libraries; DIT_NETWORK=sepolia for the testnet,
           DIT_RPC_URL to override the RPC)
  commit   look up the commit's anchors, check the L1 receipt (Base, or Sepolia for older anchors) and that the Arkiv entity is in the ledger

Examples:
  dit verify site
  dit verify commit HEAD
  dit verify commit 3f2a9c1 -R alice/web --json
  dit verify rebuild --release 11
  dit verify rebuild --source ~/src/dithub --sandbox none --unsafe-local-build`,
  log: `dit log [--anchors] [git log flags]

Compatibility alias. Prefer git log for history and dit repo commits for anchor information.

Without --anchors this is git log. With --anchors it lists, for each commit of the current branch that
Dithub knows about, its anchoring status and the L1 and Arkiv transaction hashes.

Examples:
  dit log --oneline -5
  dit log --anchors
  dit log --anchors -n 10 --json`,
  credential: `dit credential get|store|erase

Git credential helper protocol (stdin/stdout). Answers only for hosts you are logged in to; store and erase
do nothing. Configured globally for the exact host by dit login or dit auth setup-git.`,
  completion: `dit completion bash|zsh

Examples:
  source <(dit completion bash)
  dit completion zsh > "\${fpath[1]}/_dit"`,
  label: `dit label list|create|edit|delete [-R owner/repo]

  dit label list
  dit label create <name> [--color ff0000] [--description text]
  dit label edit <name> [--name new] [--color hex] [--description text]
  dit label delete <name>

Example:
  dit label create bug --color d73a4a -d "Something is broken"`,
  token: `dit token create [--name N] [--out FILE | --show]

Creates an additional personal access token (for CI and the like). The token is printed once, and only when
stdout is not a terminal (pipe it) or with --show; otherwise write it to a file with --out (mode 0600).

Examples:
  dit token create --name ci --out ./ci-token
  dit token create --name ci | gh secret set DITHUB_TOKEN`,
  name: `dit name resolve <owner/repo> [--host URL]

Prints the repo id, the claimant wallet and the Arkiv name entity.

Example:
  dit name resolve rootp1/smoke-mw4iu8wl`,
  deployments: `dit deployments [list|latest] [-L n]

Release history (read from Arkiv; "source" says arkiv or sqlite-fallback): release id, commit, bundleHash,
attestation result and the publish / attest transaction hashes.

Examples:
  dit deployments
  dit deployments latest --json`,
  recover: `dit recover <repo-id|owner/repo> [dir] [--manifest-hash 0x...] [--access-key KEY] [--arkiv-only]

Rebuilds a repository from Arkiv ALONE, without the Dithub server: fetches the manifest and chunks, verifies the
manifest hash and every chunk hash, materialises a git clone and runs git fsck. Without --manifest-hash it uses
the newest 'push' activity entity of the repo. owner/repo is resolved through the API, or through Arkiv name
entities when the server is unreachable (or with --arkiv-only).

Needs an Arkiv access key (https://hub.arkiv.network/access-keys): --access-key or $ARKIV_ACCESS_KEY.
Only small PUBLIC repos on the default branch are mirrored to Arkiv, and entities expire after about 182 days
unless renewed.

Examples:
  dit recover rootp1/smoke-mw4iu8wl
  dit recover 0xbcd0...e436 ./rescued --manifest-hash 0x9e83...6be5
  dit recover alice/web --arkiv-only --json`,
  keys: `dit keys [init|register|show] [--host URL] [--json]

This device's X25519 key for private repositories. Private repo keys are sealed to registered device keys.
The private key is stored 0600 in the dit config dir (device-key.json) and never leaves this machine.

  dit keys init [--force]                 create the key (or reuse it) and start registration
  dit keys register [--signature 0x...|-]  register the public key; the signature is your wallet's
                                          personal_sign of the statement dit prints (- reads stdin)
  dit keys show                           public key, file and registration status

Without --signature, dit prints the statement and a link to sign it in the browser with your wallet.

Examples:
  dit keys init
  dit keys register --signature 0x5d1f...1b`,
  version: `dit version [--json]    print the version`,
}

export function helpFor(cmd: string, sub?: string): string | null {
  void sub
  return H[cmd] ?? null
}
export const helpTopics = Object.keys(H)
