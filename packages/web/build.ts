import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir)
const outdir = resolve(root, 'dist')
mkdirSync(outdir, { recursive: true })
const result = await Bun.build({ entrypoints: [resolve(root, 'src/app.ts')], outdir, target: 'browser', minify: true })
if (!result.success) throw new AggregateError(result.logs, 'Web build failed')
await Promise.all([
  Bun.write(resolve(outdir, 'index.html'), Bun.file(resolve(root, 'src/index.html'))),
  Bun.write(resolve(outdir, 'style.css'), Bun.file(resolve(root, 'src/style.css'))),
])
