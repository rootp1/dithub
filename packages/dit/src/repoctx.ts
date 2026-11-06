// Resolve "which repo on which host with which token" for commands that take -R owner/repo or infer it from origin.
import { Api, apiFor } from './api.ts'
import { UsageError } from './errors.ts'
import { currentSession, primaryHost } from './config.ts'
import { inferFromGit, parseRepoRef } from './git.ts'

export interface Ctx { api: Api; host: string; owner: string; repo: string; R: string; slug: string }

export function repoCtx(v: { repo?: unknown; host?: unknown }, o: { session?: boolean } = {}): Ctx {
  const flagHost = typeof v.host === 'string' ? v.host : undefined
  const given = typeof v.repo === 'string' ? parseRepoRef(v.repo) : null
  if (typeof v.repo === 'string' && !given) throw new UsageError(`cannot understand -R "${v.repo}"`, 'Use owner/repo.')
  const ref = given ?? inferFromGit()
  if (!ref) throw new UsageError('no repository given and none could be inferred from `origin`', 'Pass -R owner/repo or run inside a clone.')
  const host = flagHost ? primaryHost(flagHost) : (ref.origin ?? primaryHost())
  const sess = o.session ? currentSession(host) : null
  const api = apiFor(host, { flagHost, session: sess?.id ?? process.env.DIT_SESSION ?? null })
  return { api, host, owner: ref.owner, repo: ref.repo, R: `/api/repos/${ref.owner}/${ref.repo}`, slug: `${ref.owner}/${ref.repo}` }
}

export const apiForFlags = (v: { host?: unknown }): Api => {
  const flagHost = typeof v.host === 'string' ? v.host : undefined
  return apiFor(primaryHost(flagHost), { flagHost })
}
