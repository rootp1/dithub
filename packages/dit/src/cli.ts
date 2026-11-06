// dit: the Git-compatible command-line client for Dithub.
import { ApiError, DitError, UsageError, describeApiError } from './errors.ts'
import { EXIT, VERSION } from './constants.ts'
import { gitInherit, withHelperEnv } from './git.ts'
import { authCmd, login, logout, whoami } from './cmd/auth.ts'
import { clone, init } from './cmd/clone.ts'
import { completion } from './cmd/completion.ts'
import { credential } from './cmd/credential.ts'
import { issueCmd } from './cmd/issue.ts'
import { logCmd } from './cmd/log.ts'
import { orgCmd } from './cmd/org.ts'
import { prCmd } from './cmd/pr.ts'
import { protect, repoCmd } from './cmd/repo.ts'
import { sessionCmd } from './cmd/session.ts'
import { deploymentsCmd, labelCmd, nameCmd, tokenCmd } from './cmd/extra.ts'
import { verifyCmd } from './cmd/verify.ts'
import { TOP, helpFor } from './help.ts'
import { e } from './ui.ts'
import { findToken, primaryHost } from './config.ts'
import { printJson } from './ui.ts'

type Handler = (argv: string[]) => Promise<number> | number
export const COMMANDS: Record<string, Handler> = {
  login, logout, whoami, auth: authCmd, clone, init, repo: repoCmd, protect, issue: issueCmd, pr: prCmd, org: orgCmd,
  recover: (argv) => import('./cmd/recover.ts').then((m) => m.recoverCmd(argv)), session: sessionCmd, verify: verifyCmd, name: nameCmd, deployments: deploymentsCmd, label: labelCmd, token: tokenCmd, log: logCmd, credential, completion,
  version: (argv) => { if (argv.includes('--json')) printJson({ version: VERSION }); else console.log(`dit ${VERSION}`); return 0 },
}

/** Anything that is not a dit command is git. When we hold a token for the default host, git may use it through the credential helper. */
function passthrough(argv: string[]): number {
  let env = process.env
  try { const h = primaryHost(); if (findToken(h)) env = withHelperEnv(h) } catch { /* no config: plain git */ }
  return gitInherit(argv, { env })
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    if (cmd === 'help' && rest[0]) { const h = helpFor(rest[0]); if (h) { console.log(h); return 0 } }
    console.log(TOP); return cmd ? 0 : EXIT.usage
  }
  if (cmd === '--version' || cmd === '-V') { console.log(`dit ${VERSION}`); return 0 }
  const handler = COMMANDS[cmd]
  if (!handler) return passthrough(argv)
  if (rest.includes('--help') || rest.includes('-h')) { console.log(helpFor(cmd) ?? TOP); return 0 }
  return handler(rest)
}

export function fail(err: unknown): number {
  if (err instanceof ApiError) { const d = describeApiError(err.status, err.message, err.body); err = new DitError(d.message, 1, d.hint) }
  if (err instanceof DitError) {
    process.stderr.write(`${e.red(err instanceof UsageError ? 'usage error:' : 'error:')} ${err.message}\n`)
    if (err.hint) process.stderr.write(`${e.dim(err.hint)}\n`)
    return err.code
  }
  const msg = (err as Error)?.message ?? String(err)
  process.stderr.write(`${e.red('error:')} ${msg}\n`)
  if (process.env.DIT_DEBUG) process.stderr.write(`${(err as Error)?.stack ?? ''}\n`)
  return EXIT.error
}

