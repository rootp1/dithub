// `dithub-task://<sessionId>/<repo path>`: a virtual folder showing ONLY the task's in-scope files.
// Reads go to the API with `x-dheet-session`; edits stay in an overlay kept in workspaceState (never written to disk as files).
import * as vscode from 'vscode'
import { ApiError, OutOfScopeError, type ScopedTarget } from './api.ts'
import type { Auth } from './auth.ts'
import type { TaskStore } from './taskStore.ts'
import {
  ORIGINAL_SCHEME, TASK_SCHEME, UUID_RE, baseName, diffOverlay, emptyOverlay, friendlyError, isDeadSessionError, isLive, overlayChildren, overlayHasDir,
  parentOf, parseOverlay, repoPathFromUri, visibleEntries, visiblePath, writablePath, type Change, type Overlay, type Task, type TreeEntry,
} from './core.ts'

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
const TREE_TTL = 60_000
const overlayKey = (sid: string) => `dithub.overlay.${sid}`

export const taskRootUri = (sessionId: string) => vscode.Uri.from({ scheme: TASK_SCHEME, authority: sessionId, path: '/' })
export const taskFileUri = (sessionId: string, path: string) => vscode.Uri.from({ scheme: TASK_SCHEME, authority: sessionId, path: `/${path}` })
export const originalUri = (sessionId: string, path: string) => vscode.Uri.from({ scheme: ORIGINAL_SCHEME, authority: sessionId, path: `/${path}` })

export class TaskFileSystem implements vscode.FileSystemProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.emitter.event
  private readonly overlays = new Map<string, Overlay>()
  private readonly trees = new Map<string, { at: number; entries: TreeEntry[] }>()
  private readonly originals = new Map<string, string | null>()
  private readonly deadNotified = new Set<string>()

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly auth: Auth,
    private readonly store: TaskStore,
    private readonly onDead: (sessionId: string, why: string) => void,
  ) {}

  // ------------------------------------------------------------ helpers
  private async task(uri: vscode.Uri): Promise<Task> {
    const sid = uri.authority
    if (!UUID_RE.test(sid)) throw vscode.FileSystemError.FileNotFound(uri)
    const t = await this.store.ensure(sid)
    if (!t) throw vscode.FileSystemError.Unavailable('This Dithub task is not assigned to you (or you are signed out). Run "Dithub: Sign in" or remove this folder.')
    if (!isLive(t)) { this.dead(sid, t.status === 'active' ? 'expired' : t.status); throw vscode.FileSystemError.Unavailable(`This Dithub task session is ${t.status === 'active' ? 'expired' : t.status}.`) }
    return t
  }
  private target(t: Task): ScopedTarget { return { owner: t.repo.owner, repo: t.repo.name, ref: t.ref, sessionId: t.sessionId, allowedPaths: t.allowedPaths } }
  private path(uri: vscode.Uri): string {
    const p = repoPathFromUri(uri.path)
    if (p === null) throw vscode.FileSystemError.FileNotFound(uri)
    return p
  }
  private dead(sid: string, why: string): void {
    if (this.deadNotified.has(sid)) return
    this.deadNotified.add(sid)
    this.onDead(sid, why)
  }
  /** Map API failures to FileSystemErrors; a dead session triggers the folder removal. */
  private fail(err: unknown, uri: vscode.Uri): never {
    if (err instanceof vscode.FileSystemError) throw err
    if (err instanceof OutOfScopeError) throw vscode.FileSystemError.FileNotFound(uri)
    if (err instanceof ApiError) {
      if (isDeadSessionError(err)) { this.dead(uri.authority, 'ended'); throw vscode.FileSystemError.Unavailable('This Dithub task session has ended, expired or was revoked.') }
      if (err.status === 403 || err.status === 404) throw vscode.FileSystemError.FileNotFound(uri)
      throw vscode.FileSystemError.Unavailable(friendlyError({ status: err.status, message: err.message, body: err.body }))
    }
    throw vscode.FileSystemError.Unavailable((err as Error)?.message ?? String(err))
  }

  overlay(sid: string): Overlay {
    let o = this.overlays.get(sid)
    if (!o) { o = parseOverlay(this.ctx.workspaceState.get(overlayKey(sid))); this.overlays.set(sid, o) }
    return o
  }
  private async saveOverlay(sid: string, o: Overlay): Promise<void> {
    this.overlays.set(sid, o)
    await this.ctx.workspaceState.update(overlayKey(sid), Object.keys(o.files).length || o.dirs.length ? o : undefined)
  }
  /** Discard all local edits of a session (after a successful submit, or when the task ends). */
  async clearOverlay(sid: string, paths?: string[]): Promise<void> {
    const o = this.overlay(sid)
    const drop = paths ?? Object.keys(o.files)
    const files = { ...o.files }
    for (const p of drop) delete files[p]
    await this.saveOverlay(sid, paths ? { ...o, files } : emptyOverlay())
    for (const p of drop) this.originals.delete(`${sid}:${p}`)
    this.emitter.fire(drop.map((p) => ({ type: vscode.FileChangeType.Changed, uri: taskFileUri(sid, p) })))
  }
  /** Forget everything cached for a session (tree listings, original contents). */
  forget(sid: string): void {
    for (const k of [...this.trees.keys()]) if (k.startsWith(`${sid}:`)) this.trees.delete(k)
    for (const k of [...this.originals.keys()]) if (k.startsWith(`${sid}:`)) this.originals.delete(k)
    this.deadNotified.delete(sid)
  }

  private async list(t: Task, dir: string): Promise<TreeEntry[]> {
    const key = `${t.sessionId}:${dir}`
    const hit = this.trees.get(key)
    if (hit && Date.now() - hit.at < TREE_TTL) return hit.entries
    const entries = visibleEntries(t.allowedPaths, await this.auth.api.scopedTree(this.target(t), dir))
    this.trees.set(key, { at: Date.now(), entries })
    return entries
  }
  /** Remote entry for a path (from its parent's listing), or undefined. */
  private async remoteEntry(t: Task, path: string): Promise<TreeEntry | undefined> {
    const parent = parentOf(path)
    if (!visiblePath(t.allowedPaths, parent, true)) return undefined
    return (await this.list(t, parent)).find((e) => e.path === path)
  }
  /** Content of a file at the session ref (null if it does not exist there). Cached per session. */
  async original(t: Task, path: string): Promise<string | null> {
    const key = `${t.sessionId}:${path}`
    if (this.originals.has(key)) return this.originals.get(key)!
    const entry = await this.remoteEntry(t, path)
    if (!entry || entry.type !== 'blob') { this.originals.set(key, null); return null }
    const blob = await this.auth.api.scopedBlob(this.target(t), path)
    if (blob.content === null) throw vscode.FileSystemError.Unavailable(blob.truncated ? `${path} is too large to open here (${blob.size} bytes).` : `${path} is a binary file and cannot be opened in a task workspace.`)
    this.originals.set(key, blob.content)
    return blob.content
  }
  async changes(t: Task): Promise<Change[]> { return diffOverlay(this.overlay(t.sessionId), (p) => this.original(t, p)) }

  // ------------------------------------------------------------ FileSystemProvider
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}) }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = this.path(uri)
    const t = await this.task(uri)
    const ctime = Date.parse(t.createdAt) || 0
    if (path === '') return { type: vscode.FileType.Directory, ctime, mtime: ctime, size: 0 }
    const o = this.overlay(t.sessionId)
    const f = o.files[path]
    if (f) return { type: vscode.FileType.File, ctime, mtime: f.mtime, size: enc.encode(f.content).byteLength }
    if (!visiblePath(t.allowedPaths, path, true) && !visiblePath(t.allowedPaths, path, false)) throw vscode.FileSystemError.FileNotFound(uri)
    if (overlayHasDir(o, path)) return { type: vscode.FileType.Directory, ctime, mtime: ctime, size: 0 }
    try {
      const e = await this.remoteEntry(t, path)
      if (!e) throw vscode.FileSystemError.FileNotFound(uri)
      return e.type === 'tree'
        ? { type: vscode.FileType.Directory, ctime, mtime: ctime, size: 0 }
        : { type: vscode.FileType.File, ctime, mtime: ctime, size: e.size ?? 0 }
    } catch (err) { return this.fail(err, uri) }
  }

  async readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    const path = this.path(uri)
    const t = await this.task(uri)
    if (!visiblePath(t.allowedPaths, path, true)) throw vscode.FileSystemError.FileNotFound(uri)
    const out = new Map<string, vscode.FileType>()
    try {
      for (const e of await this.list(t, path)) out.set(baseName(e.path), e.type === 'tree' ? vscode.FileType.Directory : vscode.FileType.File)
    } catch (err) { this.fail(err, uri) }
    for (const c of overlayChildren(this.overlay(t.sessionId), path)) if (!out.has(c.name) || c.type === 'dir') out.set(c.name, c.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File)
    return [...out.entries()]
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const path = this.path(uri)
    const t = await this.task(uri)
    const f = this.overlay(t.sessionId).files[path]
    if (f) return enc.encode(f.content)
    if (!writablePath(t.allowedPaths, path)) throw vscode.FileSystemError.FileNotFound(uri)
    let content: string | null
    try { content = await this.original(t, path) } catch (err) { return this.fail(err, uri) }
    if (content === null) throw vscode.FileSystemError.FileNotFound(uri)
    return enc.encode(content)
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
    const path = this.path(uri)
    const t = await this.task(uri)
    if (!writablePath(t.allowedPaths, path)) throw vscode.FileSystemError.NoPermissions(`${path} is outside the scope of this task; you can only change: ${t.allowedPaths.join(', ')}`)
    let text: string
    try { text = dec.decode(content) } catch { throw vscode.FileSystemError.NoPermissions('Only UTF-8 text files can be changed in a task workspace.') }
    const o = this.overlay(t.sessionId)
    let exists = !!o.files[path]
    if (!exists) { try { exists = (await this.original(t, path)) !== null } catch (err) { if (!(err instanceof vscode.FileSystemError)) this.fail(err, uri); exists = true } }
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri)
    if (exists && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri)
    await this.saveOverlay(t.sessionId, { ...o, files: { ...o.files, [path]: { content: text, mtime: Date.now() } } })
    this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }])
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const path = this.path(uri)
    const t = await this.task(uri)
    if (path === '' || !visiblePath(t.allowedPaths, path, true)) throw vscode.FileSystemError.NoPermissions(`${path || '/'} is outside the scope of this task; you can only change: ${t.allowedPaths.join(', ')}`)
    const o = this.overlay(t.sessionId)
    if (!o.dirs.includes(path)) await this.saveOverlay(t.sessionId, { ...o, dirs: [...o.dirs, path] })
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }])
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    const path = this.path(uri)
    const t = await this.task(uri)
    if (!visiblePath(t.allowedPaths, path, true) && !writablePath(t.allowedPaths, path)) throw vscode.FileSystemError.NoPermissions(`${path} is outside the scope of this task`)
    const o = this.overlay(t.sessionId)
    const below = Object.keys(o.files).filter((f) => f === path || f.startsWith(`${path}/`))
    const dirsBelow = o.dirs.filter((d) => d === path || d.startsWith(`${path}/`))
    // Only things that exist solely in the overlay can be deleted: deleting repository files is not part of a files proposal.
    const remote = await (async () => { try { return await this.remoteEntry(t, path) } catch { return undefined } })()
    if (remote) throw vscode.FileSystemError.NoPermissions('Files and folders that exist in the repository cannot be deleted or renamed in a task workspace (only new files you created can). Ask the maintainer if a deletion is needed.')
    for (const f of below) if ((await this.original(t, f).catch(() => null)) !== null) throw vscode.FileSystemError.NoPermissions(`${f} exists in the repository and cannot be deleted here.`)
    if (!below.length && !dirsBelow.length) throw vscode.FileSystemError.FileNotFound(uri)
    if ((below.length > 1 || dirsBelow.some((d) => d !== path)) && !options.recursive) throw vscode.FileSystemError.NoPermissions('folder is not empty')
    const files = { ...o.files }
    for (const f of below) delete files[f]
    await this.saveOverlay(t.sessionId, { ...o, files, dirs: o.dirs.filter((d) => !dirsBelow.includes(d)) })
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }])
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
    if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.NoPermissions('cannot move files between tasks')
    const from = this.path(oldUri), to = this.path(newUri)
    const t = await this.task(oldUri)
    if (!writablePath(t.allowedPaths, to)) throw vscode.FileSystemError.NoPermissions(`${to} is outside the scope of this task; you can only change: ${t.allowedPaths.join(', ')}`)
    const o = this.overlay(t.sessionId)
    const f = o.files[from]
    if (!f || (await this.original(t, from).catch(() => 'x')) !== null) throw vscode.FileSystemError.NoPermissions('Only new files you created in this task can be renamed.')
    const targetExists = !!o.files[to] || (await this.original(t, to).catch(() => null)) !== null
    if (targetExists && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri)
    const files = { ...o.files }
    delete files[from]
    files[to] = { content: f.content, mtime: Date.now() }
    await this.saveOverlay(t.sessionId, { ...o, files })
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: targetExists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri: newUri }])
  }

  // ------------------------------------------------------------ original content (left side of the diff view)
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const path = repoPathFromUri(uri.path)
    if (!path || !UUID_RE.test(uri.authority)) return ''
    const t = await this.store.ensure(uri.authority)
    if (!t || !writablePath(t.allowedPaths, path)) return ''
    try { return (await this.original(t, path)) ?? '' } catch (err) { return `// ${err instanceof ApiError ? friendlyError(err) : (err as Error).message}` }
  }

  /** Re-read everything (e.g. after a refresh). */
  refreshAll(sid: string): void { this.forget(sid); this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: taskRootUri(sid) }]) }

  dispose(): void { this.emitter.dispose() }
}
