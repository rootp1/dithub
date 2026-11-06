import { basename } from 'node:path'
import { apiFor } from '../api.ts'
import { parse, flag, list, str } from '../args.ts'
import { DitError, UsageError } from '../errors.ts'
import { primaryHost, findToken } from '../config.ts'
import { configureCredentialHelper, git, gitInherit, parseRepoRef, withHelperEnv } from '../git.ts'
import { c, info } from '../ui.ts'
import { createRepoRemote } from './repo.ts'

/** git clone options that take a separate value (so the value is not mistaken for the target or dir). */
const CLONE_VALUE_FLAGS = new Set(['-b', '--branch', '--depth', '-o', '--origin', '--reference', '--reference-if-able', '-c', '--config', '-j', '--jobs',
  '--filter', '--template', '--separate-git-dir', '-u', '--upload-pack', '--shallow-since', '--shallow-exclude', '--server-option', '--bundle-uri', '--ref-format', '--revision'])

export function splitCloneArgs(argv: string[]): { target?: string; dir?: string; passthrough: string[] } {
  const passthrough: string[] = []
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('-')) {
      passthrough.push(a)
      if (CLONE_VALUE_FLAGS.has(a) && i + 1 < argv.length) passthrough.push(argv[++i]!)
    } else pos.push(a)
  }
  return { ...(pos[0] ? { target: pos[0] } : {}), ...(pos[1] ? { dir: pos[1] } : {}), passthrough }
}

export async function clone(argv: string[]): Promise<number> {
  // --host is ours; everything else is git's.
  let hostFlag: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--host') hostFlag = argv[++i]
    else if (a.startsWith('--host=')) hostFlag = a.slice(7)
    else rest.push(a)
  }
  const { target, dir, passthrough } = splitCloneArgs(rest)
  if (!target) throw new UsageError('missing <target>', 'Usage: dit clone owner/repo [dir] [git clone flags]')
  const ref = parseRepoRef(target)
  if (!ref) throw new UsageError(`cannot understand "${target}"`, 'Use owner/repo, owner/repo@host or a full Dithub URL.')
  const origin = ref.origin ?? primaryHost(hostFlag)
  const api = apiFor(origin, { flagHost: hostFlag })

  // Resolve first: gives a clear error for missing repos / no access instead of a git prompt.
  let meta: { defaultBranch: string; canWrite: boolean; visibility: string; cloneUrl: string }
  try { meta = await api.get(`/api/repos/${ref.owner}/${ref.repo}`) }
  catch (err) {
    if ((err as { status?: number }).status === 404 && !api.hasToken) throw new DitError(`${ref.owner}/${ref.repo} was not found at ${origin}`, 1, 'It may be private: run `dit login` and retry.')
    throw err
  }
  const url = `${origin}/git/${ref.owner}/${ref.repo}`
  const target2 = dir ?? ref.repo
  const hasTok = !!findToken(origin, hostFlag)
  info(`Cloning ${c.bold(`${ref.owner}/${ref.repo}`)} from ${origin} (default branch ${meta.defaultBranch}, ${meta.canWrite ? 'you can push' : 'read-only'})...`)
  // The token never reaches argv, the URL or .git/config: git asks `dit credential` for it when the server challenges.
  const env = hasTok ? { ...withHelperEnv(origin), GIT_TERMINAL_PROMPT: '0' } : { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const code = gitInherit(['clone', ...passthrough, '--', url, target2], { env })
  if (code !== 0) return code
  if (hasTok) configureCredentialHelper(target2, origin)
  return 0
}

export async function init(argv: string[]): Promise<number> {
  // dit-specific flags are peeled off; everything else goes to `git init`.
  const mine = { remote: false, org: undefined as string | undefined, private: false, description: undefined as string | undefined, host: undefined as string | undefined, name: undefined as string | undefined }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--remote') mine.remote = true
    else if (a.startsWith('--remote=')) { mine.remote = true; mine.name = a.slice(9) }
    else if (a === '--org') mine.org = argv[++i]
    else if (a === '--private') mine.private = true
    else if (a === '--description') mine.description = argv[++i]
    else if (a === '--host') mine.host = argv[++i]
    else rest.push(a)
  }
  const dirArg = [...rest].reverse().find((a) => !a.startsWith('-'))
  const userBranch = rest.some((a) => a === '-b' || a.startsWith('--initial-branch'))
  const code = gitInherit(['init', ...(mine.remote && !userBranch ? ['--initial-branch=main'] : []), ...rest])
  if (code !== 0 || !mine.remote) return code
  const dir = dirArg ?? '.'
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir }).out.trim() || dir
  const name = mine.name ?? basename(top)
  await createRepoRemote({ name, org: mine.org, visibility: mine.private ? 'private' : 'public', description: mine.description, host: mine.host, cwd: top, push: false })
  return 0
}
void flag; void list; void str; void parse
