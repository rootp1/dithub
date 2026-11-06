import { createReadStream } from 'node:fs'
import { stat, rm, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const SWARM_REFERENCE = /^[a-f0-9]{64}$/i
// Dithub runs on the Sepolia Swarm testnet, which has no public gateway; this read-only proxy is the default. Pass --bee-url to use any
// other Bee node on the same network (e.g. your own) so recovery does not depend on Dithub at all.
export const DEFAULT_SWARM_READ_URL = 'https://dithub.app/swarm'

export interface SwarmOptions {
  url: string
  batchId?: string
  readUrl?: string
  timeoutMs?: number
  maxBytes?: number
}

/** Raw /bytes transfers avoid wrapping Git bundles in a second file manifest. */
export class SwarmStore {
  constructor(readonly options: SwarmOptions) {
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) throw new Error('Swarm byte limit must be a positive safe integer')
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('Swarm timeout must be a positive integer')
    for (const value of [options.url, options.readUrl].filter(Boolean)) {
      const url = new URL(value!)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bee URL must use HTTP or HTTPS')
    }
  }

  private async request(base: string, path: string, init: RequestInit = {}) {
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/${path}`, {
        ...init, signal: AbortSignal.timeout(this.options.timeoutMs ?? 30 * 60_000), redirect: 'error',
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
      return response
    } catch (error) {
      // Never include a credential-bearing Bee URL, response body or batch ID in errors.
      const status = /HTTP \d+/.exec(String(error))?.[0]
      throw new Error(`Swarm ${init.method === 'POST' ? 'upload' : 'read'} failed${status ? ` (${status})` : ''}`)
    }
  }

  async uploadFile(path: string): Promise<string> {
    const batch = this.options.batchId
    if (!batch || !SWARM_REFERENCE.test(batch)) throw new Error('A 64-character Swarm postage batch ID is required')
    const { size } = await stat(path)
    if (size > (this.options.maxBytes ?? 10 * 1024 ** 3)) throw new Error('Snapshot exceeds configured Swarm size limit')
    const stream = createReadStream(path)
    try {
      const response = await this.request(this.options.url, 'bytes', {
        method: 'POST', headers: {
          'content-type': 'application/octet-stream', 'content-length': String(size),
          'swarm-postage-batch-id': batch, 'swarm-deferred-upload': 'false', 'swarm-pin': 'true',
        }, body: stream as unknown as BodyInit, duplex: 'half',
      } as RequestInit)
      const result = await response.json() as { reference?: unknown }
      if (typeof result.reference !== 'string' || !SWARM_REFERENCE.test(result.reference)) throw new Error('Invalid public Swarm reference')
      return result.reference.toLowerCase()
    } finally { stream.destroy() }
  }

  async downloadFile(reference: string, path: string, expected: { hash: string; size: number }, progress?: (bytes: number) => void) {
    if (!SWARM_REFERENCE.test(reference)) throw new Error('Invalid public Swarm reference')
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > (this.options.maxBytes ?? 10 * 1024 ** 3)) throw new Error('Invalid or oversized Swarm download')
    const response = await this.request(this.options.readUrl ?? this.options.url, `bytes/${reference}`)
    if (!response.body) throw new Error('Empty Swarm response')
    let size = 0
    const hash = createHash('sha256')
    const check = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > expected.size) return callback(new Error('Swarm download exceeds expected size'))
      hash.update(chunk); progress?.(size); callback(null, chunk)
    } })
    const output = await open(path, 'wx').catch(async (error) => { await response.body?.cancel(); throw error })
    try {
      await pipeline(Readable.fromWeb(response.body as never), check, output.createWriteStream())
      if (size !== expected.size || `0x${hash.digest('hex')}` !== expected.hash) throw new Error('Swarm content hash or size mismatch')
    } catch (error) { await rm(path, { force: true }); throw error }
    finally { await output.close() }
  }

  /** Postage TTL is an estimate; query the uploader's node, never a public gateway. */
  async batchStatus() {
    const id = this.options.batchId
    if (!id || !SWARM_REFERENCE.test(id)) throw new Error('Invalid postage batch ID')
    const response = await this.request(this.options.url, `stamps/${id}`)
    const value = await response.json() as { usable?: boolean; batchTTL?: number; expired?: boolean }
    if (value.usable === false || value.expired || !Number.isFinite(value.batchTTL) || value.batchTTL! <= 0) throw new Error('Swarm postage batch is expired or not usable')
    return { ttlSeconds: value.batchTTL! }
  }
}
