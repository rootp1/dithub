import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, normalizeHost } from '../config.ts'
import { DitError } from '../errors.ts'
import { normalizeReadPath, writablePath, type Change, type Task } from './core.ts'

export interface Draft { content: string; original: string | null }
interface DraftFile { version: 1; sessionId: string; ref: string; files: Record<string, Draft> }

// Only edited files and their comparison baselines are persisted. Host + session isolate accounts and servers.
export class TaskDrafts {
  private readonly dir: string
  readonly file: string
  constructor(host: string, private readonly task: Task) {
    this.dir = join(configDir(), 'task-drafts')
    this.file = join(this.dir, createHash('sha256').update(`${normalizeHost(host)}\n${task.sessionId}`).digest('hex') + '.json')
  }

  read(): Record<string, Draft> {
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw err }
    let data: DraftFile
    try { data = JSON.parse(raw) }
    catch { throw new DitError('the task draft file is invalid; it was left untouched') }
    if (data?.version !== 1 || data.sessionId !== this.task.sessionId || data.ref !== this.task.ref || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
      throw new DitError('the task draft does not match this session; it was left untouched')
    }
    for (const [path, value] of Object.entries(data.files)) {
      if (normalizeReadPath(path) !== path || !writablePath(this.task.allowedPaths, path) || !value || typeof value.content !== 'string' || !(value.original === null || typeof value.original === 'string')) {
        throw new DitError('the task draft contains invalid or out-of-scope files; it was left untouched')
      }
    }
    return data.files
  }

  private write(files: Record<string, Draft>): void {
    if (!Object.keys(files).length) { rmSync(this.file, { force: true }); return }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, sessionId: this.task.sessionId, ref: this.task.ref, files } satisfies DraftFile) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.file)
    } finally { rmSync(temp, { force: true }) }
  }

  put(path: string, draft: Draft): void {
    if (normalizeReadPath(path) !== path || !writablePath(this.task.allowedPaths, path)) throw new DitError(`${path} is outside the task scope`)
    if (Buffer.byteLength(draft.content) > 1_000_000 || draft.content.includes('\0')) throw new DitError('task files must be UTF-8 text of at most 1 MB')
    const files = this.read()
    if (draft.original !== null && draft.content === draft.original) delete files[path]
    else Object.defineProperty(files, path, { value: draft, enumerable: true, configurable: true, writable: true })
    this.write(files)
  }

  changes(): Change[] {
    return Object.entries(this.read()).sort(([a], [b]) => a.localeCompare(b)).map(([path, d]) => ({ path, content: d.content, status: d.original === null ? 'added' : 'modified' }))
  }

  // Preserve edits made by another command while the proposal request was running.
  submitted(changes: Change[]): void {
    const files = this.read()
    for (const c of changes) if (Object.hasOwn(files, c.path) && files[c.path]!.content === c.content) delete files[c.path]
    this.write(files)
  }

  discard(paths?: string[]): void {
    if (!paths) { rmSync(this.file, { force: true }); return }
    const files = this.read()
    for (const path of paths) delete files[path]
    this.write(files)
  }
}
