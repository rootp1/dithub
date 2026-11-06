import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir), outdir = resolve(root, 'dist')
mkdirSync(outdir, { recursive: true })
const r = await Bun.build({ entrypoints: [resolve(root, 'src/app.ts')], outdir, target: 'browser', minify: true,
  // Which L1 the verify panel and explorer links use. Part of the bundle, so it is covered by bundleHash.
  define: { 'process.env.DITHUB_NETWORK': JSON.stringify(process.env.L1_NETWORK ?? process.env.L1_CHAIN_ID ?? 'sepolia') } })
if (!r.success) throw new AggregateError(r.logs, 'web build failed')
await Promise.all(['index.html', 'style.css'].map((f) => Bun.write(resolve(outdir, f), Bun.file(resolve(root, 'src', f)))))

// build.json: what a verifier compares against the on-chain release. Deterministic: no timestamps, sorted keys.
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const files: Record<string, string> = {}
for (const name of readdirSync(outdir).filter((f) => f !== 'build.json').sort()) files[name] = `0x${sha256(readFileSync(resolve(outdir, name)))}`
const bundleHash = `0x${sha256(Buffer.from(JSON.stringify(files)))}`
const commit = (process.env.GIT_COMMIT ?? 'dev').toLowerCase()
await Bun.write(resolve(outdir, 'build.json'), JSON.stringify({ commit, bundleHash, files }, null, 2) + '\n')
console.log(`web build ${commit.slice(0, 12)} bundleHash ${bundleHash}`)
