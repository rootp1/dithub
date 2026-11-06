// Task-scoped assistant on 0G Private Computer. Mount in index.ts: app.route('/', assistant)
import { Hono } from 'hono'
import { authenticate } from './auth.ts'
import { sql, bool, now } from './db.ts'
import { repoPath } from './gitrepo.ts'
import { loadSessionForUser, pathInScope, logSessionEvent } from './sessions.ts'
import { gitSource, runAssistant, LIMITS, type FileSource } from './assistant-core.ts'
import { chat as zgChat, ZeroGError, zgConfig, type ChatFn } from './zerog.ts'

export const RATE_LIMIT_PER_HOUR = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Test seams: override the 0G client or the repo reader. Production uses the defaults. */
export const deps: { chat: ChatFn; source: (dir: string, ref: string) => FileSource } = { chat: zgChat, source: gitSource }

export const assistant = new Hono()

type Kind = 'summarize' | 'ask'
const flag = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0)
const optBool = (v: unknown) => (v == null ? null : bool(v))

async function handle(c: import('hono').Context, kind: Kind) {
  const user = await authenticate(c)
  if (!user) return c.json({ error: 'authentication required' }, 401)
  const id = (c.req.param('id') ?? '').toLowerCase()
  if (!UUID.test(id)) return c.json({ error: 'session not found' }, 404)
  const session = await loadSessionForUser(id, user.id)
  if (!session) return c.json({ error: 'session not found' }, 404)
  if (session.expiresAt.getTime() <= Date.now()) return c.json({ error: 'session has expired' }, 410)

  let question: string | undefined
  if (kind === 'ask') {
    const body = await c.req.json<{ question?: unknown }>().catch(() => ({} as { question?: unknown }))
    if (typeof body.question !== 'string' || !body.question.trim()) return c.json({ error: 'question is required' }, 400)
    if (body.question.length > LIMITS.question) return c.json({ error: `question too long (max ${LIMITS.question} chars)` }, 400)
    question = body.question.trim()
  }

  const [rate] = await sql`SELECT count(*) AS n FROM assistant_calls WHERE session_id = ${id} AND created_at > ${now(-3_600_000)}`
  if (Number(rate?.n ?? 0) >= RATE_LIMIT_PER_HOUR) return c.json({ error: `rate limit: ${RATE_LIMIT_PER_HOUR} assistant calls per hour per session` }, 429)

  const [issue] = await sql`SELECT title, body FROM issues WHERE id = ${session.issueId}`
  if (!issue) return c.json({ error: 'issue not found' }, 404)

  const started = Date.now()
  const model = zgConfig().model
  let outcome: Awaited<ReturnType<typeof runAssistant>>
  try {
    outcome = await runAssistant({
      kind, ...(question !== undefined ? { question } : {}),
      issue: { number: session.issueNumber, title: String(issue.title), body: String(issue.body ?? '') },
      allowedPaths: session.allowedPaths, source: deps.source(repoPath(session.repoIdHex), session.ref), pathInScope,
      chat: deps.chat, model, userTag: `dheet-u${session.userId}`,
    })
  } catch (e) {
    const zg = e instanceof ZeroGError
    const message = zg ? e.message : 'assistant failed'
    if (!zg) console.error('assistant error', (e as Error).message)
    await sql`INSERT INTO assistant_calls (session_id, user_id, kind, model, zg_request_id, latency_ms, question, error)
      VALUES (${id}, ${user.id}, ${kind}, ${model}, ${zg ? e.requestId : null}, ${Date.now() - started}, ${question ?? null}, ${message.slice(0, 500)})`
    await logSessionEvent(id, user.id, `assistant.${kind}.error`, { code: zg ? e.code : 'internal', requestId: zg ? e.requestId : null }).catch(() => {})
    // Never fabricate an answer: surface the failure.
    return c.json({ error: zg ? `0G Private Computer is unavailable: ${message}` : 'assistant failed', answer: null }, 502)
  }
  const latency = Date.now() - started

  if (outcome.refused) {
    const [row] = await sql`INSERT INTO assistant_calls (session_id, user_id, kind, refused, refusal_reason, latency_ms, question, answer)
      VALUES (${id}, ${user.id}, ${kind}, 1, ${outcome.reason}, ${latency}, ${question ?? null}, ${outcome.answer}) RETURNING id, created_at`
    await logSessionEvent(id, user.id, `assistant.${kind}.refused`, { reason: outcome.reason, tokens: outcome.tokens }).catch(() => {})
    return c.json({ callId: row.id, refused: true, reason: outcome.reason, answer: outcome.answer, requestId: null, createdAt: row.created_at })
  }

  const r = outcome.result
  const [row] = await sql`INSERT INTO assistant_calls (session_id, user_id, kind, model, zg_request_id, prompt_hash, refused, sealed, tee_verified,
      tokens_in, tokens_out, latency_ms, question, answer)
    VALUES (${id}, ${user.id}, ${kind}, ${r.model}, ${r.requestId}, ${outcome.promptHash}, 0, ${flag(r.sealed)}, ${flag(r.teeVerified)},
      ${r.usage.promptTokens}, ${r.usage.completionTokens}, ${latency}, ${question ?? null}, ${outcome.answer.slice(0, 4000)}) RETURNING id, created_at`
  await logSessionEvent(id, user.id, `assistant.${kind}`, {
    requestId: r.requestId, model: r.model, files: outcome.files, redactions: outcome.redactions, sealed: r.sealed,
  }).catch(() => {})
  return c.json({
    callId: row.id, refused: false, answer: outcome.answer, requestId: r.requestId, model: r.model, sealed: r.sealed, teeVerified: r.teeVerified,
    filesUsed: outcome.files, usage: r.usage, redactions: outcome.redactions, createdAt: row.created_at,
  })
}

assistant.post('/api/sessions/:id/assistant/summarize', (c) => handle(c, 'summarize'))
assistant.post('/api/sessions/:id/assistant/ask', (c) => handle(c, 'ask'))

assistant.get('/api/sessions/:id/assistant/calls', async (c) => {
  const user = await authenticate(c)
  if (!user) return c.json({ error: 'authentication required' }, 401)
  const id = c.req.param('id').toLowerCase()
  if (!UUID.test(id)) return c.json({ error: 'session not found' }, 404)
  // Only the caller's own rows; prompts are never stored.
  const rows = await sql`SELECT id, kind, model, zg_request_id, refused, refusal_reason, sealed, tee_verified, tokens_in, tokens_out, latency_ms,
      question, answer, error, created_at FROM assistant_calls WHERE session_id = ${id} AND user_id = ${user.id} ORDER BY created_at DESC, rowid DESC LIMIT 100`
  return c.json({
    calls: rows.map((r: any) => ({
      id: r.id, kind: r.kind, model: r.model, requestId: r.zg_request_id, refused: bool(r.refused), refusalReason: r.refusal_reason,
      sealed: optBool(r.sealed), teeVerified: optBool(r.tee_verified), tokensIn: r.tokens_in, tokensOut: r.tokens_out, latencyMs: r.latency_ms,
      question: r.question, answer: r.answer, failed: Boolean(r.error), createdAt: r.created_at,
    })),
  })
})
