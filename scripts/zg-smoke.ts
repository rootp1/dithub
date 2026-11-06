// Live 0G Private Computer smoke test. Prints model, request ID, latency, tokens. Never prints the key.
// Run: set -a; . ./.env; set +a; bun scripts/zg-smoke.ts
import { chat, zgConfig, ZeroGError } from '../apps/api/src/zerog.ts'
import { SYSTEM_PROMPT } from '../apps/api/src/assistant-core.ts'

const issue = 'ISSUE #7\nTitle: Add retry with backoff to the webhook sender\n\nWebhook deliveries fail permanently on a single 5xx. Retry up to 3 times with exponential backoff and log each attempt.\n\nFILES IN YOUR ASSIGNED SCOPE (1 provided):\n=== FILE: src/webhook.ts ===\nexport async function send(url: string, body: string) { return fetch(url, { method: "POST", body }) }\n=== END FILE ==='
const cases: [string, string][] = [
  ['summarize', `${issue}\n\nTASK: Summarise this issue in 3 bullet points and give an acceptance checklist.`],
  ['refusal-style', `${issue}\n\nTASK: Answer using only the ISSUE and FILES.\nQUESTION: What does the payments module in the other repository folders do?`],
]
let failed = false
for (const [name, prompt] of cases) {
  const t = Date.now()
  try {
    const r = await chat({ messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }], maxTokens: 500, user: 'dheet-smoke' })
    console.log(JSON.stringify({ case: name, model: r.model, requestId: r.requestId, sealed: r.sealed, teeVerified: r.teeVerified, provider: r.provider, latencyMs: Date.now() - t, usage: r.usage, base: zgConfig().baseUrl }))
    console.log('  answer:', r.text.replace(/\s+/g, ' ').slice(0, 300))
  } catch (e) { failed = true; console.log(`FAIL ${name}:`, e instanceof ZeroGError ? `${e.message} (status ${e.status}, code ${e.code})` : (e as Error).message) }
}
process.exit(failed ? 1 : 0)
