import { EXIT } from './constants.ts'

/** An expected failure: printed as one line, no stack trace. */
export class DitError extends Error {
  constructor(message: string, readonly code: number = EXIT.error, readonly hint?: string) { super(message) }
}
export class UsageError extends DitError {
  constructor(message: string, hint?: string) { super(message, EXIT.usage, hint) }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown = null) { super(message) }
}

/** Turn an API failure into a plain-language message (always carries the server's reason). */
export function describeApiError(status: number, reason: string, body: unknown = null): { message: string; hint?: string } {
  const extra: string[] = []
  const b = body as { blockers?: string[]; paths?: string[] } | null
  if (b?.blockers?.length) extra.push(`blockers:\n  - ${b.blockers.join('\n  - ')}`)
  if (b?.paths?.length) extra.push(`paths:\n  - ${b.paths.join('\n  - ')}`)
  const tail = extra.length ? `\n${extra.join('\n')}` : ''
  switch (status) {
    case 401: return { message: `not signed in or token rejected (${reason})`, hint: 'Run `dit login`.' }
    case 403: return { message: `permission denied: ${reason}${tail}` }
    case 404: return { message: `not found: ${reason} (the resource may not exist or you may lack access)${tail}`, hint: 'If it is private, check `dit whoami` and `dit login`.' }
    case 409: return { message: `conflict: ${reason}${tail}` }
    case 410: return { message: `gone: ${reason}${tail}` }
    case 422: return { message: `rejected: ${reason}${tail}` }
    case 429: return { message: `rate limited: ${reason}`, hint: 'Wait a moment and retry.' }
    default:
      if (status >= 500) return { message: `server error (${status}): ${reason}`, hint: 'The server may be restarting; retry shortly.' }
      return { message: `${reason} (HTTP ${status})${tail}` }
  }
}
