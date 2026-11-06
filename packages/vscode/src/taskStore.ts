// In-memory list of the signed-in developer's tasks (GET /api/tasks). Nothing here is persisted: after a window reload
// the list is fetched again on first use, so task metadata never lands in settings or state files.
import * as vscode from 'vscode'
import type { Auth } from './auth.ts'
import { isLive, type Task } from './core.ts'

export class TaskStore implements vscode.Disposable {
  private tasks = new Map<string, Task>()
  private loaded = false
  private inflight: Promise<Task[]> | null = null
  private readonly changed = new vscode.EventEmitter<Task[]>()
  readonly onDidChange = this.changed.event

  constructor(private readonly auth: Auth) {}

  all(): Task[] { return [...this.tasks.values()] }
  get(id: string): Task | undefined { return this.tasks.get(id) }
  active(now = Date.now()): Task[] { return this.all().filter((t) => isLive(t, now)) }

  clear(): void { this.tasks.clear(); this.loaded = false; this.changed.fire([]) }

  /** Fetch GET /api/tasks (deduplicated while a request is running). */
  refresh(): Promise<Task[]> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        const list = await this.auth.api.tasks()
        this.tasks = new Map(list.map((t) => [t.sessionId, t]))
        this.loaded = true
        this.changed.fire(list)
        return list
      } finally { this.inflight = null }
    })()
    return this.inflight
  }

  /** The task for a session id, fetching the list once if it is not known yet. */
  async ensure(id: string): Promise<Task | undefined> {
    if (!this.tasks.has(id) || !this.loaded) { try { await this.refresh() } catch { /* the caller reports a missing task */ } }
    return this.tasks.get(id)
  }

  /** Mark a task as no longer active locally (e.g. after End task or a 403 for a dead session). */
  markEnded(id: string, status: Task['status'] = 'ended'): void {
    const t = this.tasks.get(id); if (!t) return
    this.tasks.set(id, { ...t, status })
    this.changed.fire(this.all())
  }

  dispose(): void { this.changed.dispose() }
}
