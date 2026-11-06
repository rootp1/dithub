// GET /api/deployments, /api/deployments/latest: deployment history READ FROM ARKIV (dheet-activity-v1, kinds 'deploy' / 'attest').
// Postgres (`deployments`, filled by the worker mirror) is used only when Arkiv is unreachable; the response says so in `source`.
// Mount in index.ts:  import { deployments } from './deployments.ts'  ...  app.route('/api', deployments)
import { Hono } from 'hono'
import { generatePrivateKey } from 'viem/accounts'
import { and, desc, eq } from '@arkiv-network/sdk/query'
import { addr, key } from '@arkiv-network/sdk/schema'
import { ArkivActivitySchema, createArkivConnection, sha256 } from '../../../packages/sdk/src/index.ts'
import { sql, toHex } from './db.ts'

export const deployments = new Hono()

const REPO_KEY = sha256('dheet:deployments') as `0x${string}`
const TTL_MS = 30_000
// Anyone can write entities with this schema, so only entities written by the trusted mirror (relayer) wallet are shown.
const TRUSTED_WRITER = (process.env.DHEET_RELAYER_ADDRESS ?? '0x7e290CA88091C8635cC78fE58bB1f6e1361b097c') as `0x${string}`
const LIMIT = 100          // the Arkiv node rejects limit > 100; newest-first so the latest releases always fit

export interface DeploymentItem {
  releaseId: number
  commit: string | null
  bundleHash: string | null
  url: string | null
  publishedAt: string | null
  publishTx: string | null
  attested: boolean
  ok: boolean | null
  attestedAt: string | null
  attestTx: string | null
  arkivEntity: string | null
}
interface Payload { items: DeploymentItem[]; source: 'arkiv' | 'postgres-fallback'; fetchedAt: string }

// Read-only connection: the key is a throwaway (reads never sign); the access key comes from env.
let conn: ReturnType<typeof createArkivConnection> | undefined
const connection = () => (conn ??= createArkivConnection({ privateKey: generatePrivateKey(), accessKey: process.env.ARKIV_ACCESS_KEY ?? '' }))

/** Arkiv SDK returns bytes either as Uint8Array, hex or {value}; normalise to bytes. */
function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v.replace(/^0x/, ''), 'hex'))
  if (v && typeof v === 'object' && 'value' in v) return bytesOf((v as { value: unknown }).value)
  return new Uint8Array()
}
const str = (v: unknown): string => (v && typeof v === 'object' && 'value' in v ? str((v as { value: unknown }).value) : String(v ?? ''))
const iso = (secs: unknown) => { const n = Number(str(secs)); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null }

async function fromArkiv(): Promise<DeploymentItem[]> {
  const res = await connection().publicClient
    .select({ $key: true, kind: true, seq: true, ctime: true, l1Tx: true, content: true })
    .from(ArkivActivitySchema, { onMismatch: 'throw' })
    .where(and(eq('repo', key(REPO_KEY)), eq('actor', addr(TRUSTED_WRITER))))
    .orderBy(desc('seq'))
    .limit(LIMIT)
    .fetch()
  const byId = new Map<number, DeploymentItem>()
  const get = (id: number) => { let r = byId.get(id); if (!r) byId.set(id, r = { releaseId: id, commit: null, bundleHash: null, url: null, publishedAt: null, publishTx: null, attested: false, ok: null, attestedAt: null, attestTx: null, arkivEntity: null }); return r }
  const attestCtime = new Map<number, number>()
  for (const e of res.entities as unknown as Array<Record<string, unknown>>) {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(new TextDecoder().decode(bytesOf(e.content))) } catch { continue }
    const id = Number(str(e.seq)), kind = str(e.kind), ctime = Number(str(e.ctime))
    if (kind === 'deploy') {
      const r = get(id)
      Object.assign(r, { commit: String(body.commit ?? ''), bundleHash: String(body.bundleHash ?? ''), url: String(body.url ?? ''), publishedAt: (body.publishedAt as string) ?? iso(ctime), publishTx: str(e.l1Tx), arkivEntity: str(e.$key) })
    } else if (kind === 'attest' && ctime >= (attestCtime.get(id) ?? 0)) {       // latest attestation wins
      attestCtime.set(id, ctime)
      Object.assign(get(id), { attested: true, ok: Boolean(body.ok), attestedAt: iso(body.observedAt), attestTx: str(e.l1Tx) })
    }
  }
  return [...byId.values()].filter((r) => r.bundleHash).sort((a, b) => b.releaseId - a.releaseId)
}

async function fromPostgres(): Promise<DeploymentItem[]> {
  const rows = await sql`SELECT * FROM deployments ORDER BY id DESC LIMIT ${LIMIT}`
  return rows.map((r: Record<string, any>) => ({
    releaseId: Number(r.id), commit: toHex(r.commit), bundleHash: toHex(r.bundle_hash), url: r.url,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null, publishTx: toHex(r.publish_tx),
    attested: Boolean(r.attested), ok: r.attested_ok ?? null, attestedAt: r.attested_at ? new Date(r.attested_at).toISOString() : null,
    attestTx: toHex(r.attest_tx), arkivEntity: toHex(r.arkiv_entity),
  }))
}

let cache: { at: number; value: Payload } | undefined
async function load(): Promise<Payload> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  let value: Payload
  try {
    value = { items: await fromArkiv(), source: 'arkiv', fetchedAt: new Date().toISOString() }
  } catch (e) {
    console.error('deployments: Arkiv read failed, falling back to Postgres:', String(e).slice(0, 200))
    value = { items: await fromPostgres(), source: 'postgres-fallback', fetchedAt: new Date().toISOString() }
    cache = { at: Date.now() - TTL_MS + 5_000, value }        // retry Arkiv after 5 s
    return value
  }
  cache = { at: Date.now(), value }
  return value
}

deployments.get('/deployments', async (c) => {
  try { const p = await load(); return c.json({ source: p.source, fetchedAt: p.fetchedAt, deployments: p.items }) }
  catch (e) { return c.json({ error: 'deployment history unavailable', detail: String(e).slice(0, 200) }, 503) }
})

deployments.get('/deployments/latest', async (c) => {
  try {
    const p = await load()
    const latest = p.items[0]
    return latest ? c.json({ source: p.source, fetchedAt: p.fetchedAt, deployment: latest }) : c.json({ source: p.source, deployment: null }, 404)
  } catch (e) { return c.json({ error: 'deployment history unavailable', detail: String(e).slice(0, 200) }, 503) }
})
