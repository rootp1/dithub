// Minimal typed client for the 0G Compute Router ("0G Private Computer", pc.0g.ai).
// OpenAI-compatible: POST {base}/chat/completions with `Authorization: Bearer sk-...`.
// Sealed inference is requested per call with `X-0G-Provider-Trust-Mode: private` (TeeML providers only, no fallback).
// The 0G request ID comes back in the body at `x_0g_trace.request_id` (also the `X-Request-Id` header).
// Failures are surfaced as ZeroGError; this module NEVER fabricates an answer and never exposes the API key.

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatArgs {
  model?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** Opaque end-user id forwarded for abuse attribution (OpenAI `user` field). Do not put PII here. */
  user?: string
  /** Allow the model's reasoning phase (default off: faster, cheaper, and answers are not truncated by thinking). */
  thinking?: boolean
}
export interface ChatResult {
  text: string
  requestId: string
  model: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  provider: string | null
  /** True when the gateway reported `X-0G-E2ee: sealed` and the trust tier was pinned to private. */
  sealed: boolean
  /** Router-side TEE signature check (only when verify is requested). */
  teeVerified: boolean | null
  raw?: unknown
}
export type ChatFn = (args: ChatArgs) => Promise<ChatResult>

export class ZeroGError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null, readonly requestId: string | null) {
    super(message); this.name = 'ZeroGError'
  }
}

const env = () => process.env
export const zgConfig = () => ({
  baseUrl: (env().ZG_BASE_URL || 'https://router-api.0g.ai/v1').replace(/\/+$/, ''),
  model: env().ZG_MODEL || '0gm-1.0-35b-a3b',
  timeoutMs: Number(env().ZG_TIMEOUT_MS || 90_000),
  verify: env().ZG_VERIFY_TEE !== '0',
})
export const zgConfigured = () => Boolean(env().ZG_API_KEY)

function scrub(text: string): string {
  const key = env().ZG_API_KEY
  let out = key ? text.split(key).join('[redacted]') : text
  out = out.replace(/\b(sk|mk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
  return out.slice(0, 500)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const chatOnce: ChatFn = async (args) => {
  const key = env().ZG_API_KEY
  if (!key) throw new ZeroGError('0G Private Computer is not configured (ZG_API_KEY missing)', null, 'not_configured', null)
  const cfg = zgConfig()
  const model = args.model || cfg.model
  const body: Record<string, unknown> = {
    model, messages: args.messages, temperature: args.temperature ?? 0.2, max_tokens: args.maxTokens ?? 1200,
    verify_tee: cfg.verify,
  }
  if (args.user) body.user = args.user
  if (model.startsWith('0gm') && !args.thinking) body.chat_template_kwargs = { enable_thinking: false }
  const payload = JSON.stringify(body)
  const maxAttempts = 4
  let lastErr: ZeroGError | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-0g-provider-trust-mode': 'private' },
        body: payload, signal: AbortSignal.timeout(cfg.timeoutMs),
      })
    } catch (e) {
      lastErr = new ZeroGError(`0G Private Computer unreachable: ${scrub((e as Error).name === 'TimeoutError' ? 'request timed out' : (e as Error).message)}`, null, 'unreachable', null)
      if (attempt < maxAttempts) { await sleep(500 * 2 ** (attempt - 1)); continue }
      throw lastErr
    }
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* non-JSON error page */ }
    if (res.ok && json) {
      const content: unknown = json.choices?.[0]?.message?.content
      const requestId: string | undefined = json.x_0g_trace?.request_id ?? res.headers.get('x-request-id')?.split(',').pop()?.trim() ?? undefined
      if (!requestId) throw new ZeroGError('0G response carried no request ID; refusing to use it', res.status, 'no_request_id', null)
      if (typeof content !== 'string' || !content.trim()) {
        throw new ZeroGError(`0G returned an empty completion (finish_reason=${json.choices?.[0]?.finish_reason ?? 'unknown'})`, res.status, 'empty_completion', requestId)
      }
      if (json.x_0g_trace?.tee_verified === false) throw new ZeroGError('0G reported the TEE signature did not verify; response discarded', res.status, 'tee_verification_failed', requestId)
      const u = json.usage ?? {}
      return {
        text: content, requestId, model: json.model ?? model,
        usage: { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 },
        provider: json.x_0g_trace?.provider ?? null,
        sealed: res.headers.get('x-0g-e2ee') === 'sealed',
        teeVerified: json.x_0g_trace?.tee_verified ?? null,
        raw: json,
      }
    }
    const rid = json?.request_id ?? res.headers.get('x-request-id')?.split(',').pop()?.trim() ?? null
    lastErr = new ZeroGError(`0G error ${res.status}: ${scrub(json?.error?.message ?? text)}`, res.status, json?.error?.code ?? null, rid)
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt === maxAttempts) throw lastErr
    const ra = Number(res.headers.get('retry-after'))
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 500 * 2 ** (attempt - 1))
  }
  throw lastErr ?? new ZeroGError('0G call failed', null, null, null)
}

/**
 * Provider-side failures (a compute node unreachable, TEE quote fetch failing) are per-model-route problems. Try the next sealed-tier
 * model before giving up. Still never fakes an answer: if every model fails the caller gets the error, and `model` in the result is
 * always the one that actually ran (the assistant stores it next to the 0G request id).
 */
export const chat: ChatFn = async (args) => {
  const primary = args.model || zgConfig().model
  const fallbacks = (env().ZG_FALLBACK_MODELS ?? 'glm-5.3').split(',').map((m) => m.trim()).filter(Boolean)
  const models = [...new Set([primary, ...fallbacks])]
  let last: unknown
  for (const model of models) {
    try {
      try { return await chatOnce({ ...args, model }) }
      catch (error) {
        // Reasoning models can spend the whole token budget thinking and return nothing: retry once with more room.
        if (!(error instanceof ZeroGError) || error.code !== 'empty_completion') throw error
        return await chatOnce({ ...args, model, maxTokens: Math.min((args.maxTokens ?? 800) * 3, 4096) })
      }
    } catch (error) {
      last = error
      const status = error instanceof ZeroGError ? error.status : null
      const emptyAgain = error instanceof ZeroGError && error.code === 'empty_completion'
      if (status !== 502 && status !== 503 && status !== 504 && !emptyAgain) throw error
    }
  }
  throw last
}
