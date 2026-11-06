// Sign in / sign out with the device-code flow. The token lives ONLY in vscode.SecretStorage (one key per host)
// and in the Authorization header of API calls. It is never logged, put in a URL, a setting or workspaceState.
import * as vscode from 'vscode'
import { hostname } from 'node:os'
import { ApiError, DithubClient, normalizeHost } from './api.ts'
import { DEFAULT_HOST } from './core.ts'

const secretKey = (host: string) => `dithub.token:${host}`
const loginKey = (host: string) => `dithub.login:${host}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Auth implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  private client: DithubClient
  private unauthorizedPrompted = 0
  private readonly subs: vscode.Disposable[] = []

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.client = this.makeClient()
    this.subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dithub.host')) { this.client = this.makeClient(); void this.refreshContext(); this.changed.fire() }
    }))
    this.subs.push(ctx.secrets.onDidChange((e) => { if (e.key === secretKey(this.host)) { void this.refreshContext(); this.changed.fire() } }))
  }

  get host(): string {
    const raw = vscode.workspace.getConfiguration('dithub').get<string>('host') || DEFAULT_HOST
    try { return normalizeHost(raw) } catch { return normalizeHost(DEFAULT_HOST) }
  }
  get api(): DithubClient { return this.client }
  get login(): string | null { return this.ctx.globalState.get<string>(loginKey(this.host)) ?? null }

  private makeClient(): DithubClient {
    return new DithubClient({ host: this.host, getToken: () => this.token(), onUnauthorized: () => this.onUnauthorized(), userAgent: `dithub-vscode/${this.ctx.extension.packageJSON.version ?? '0'}` })
  }

  async token(): Promise<string | null> { return (await this.ctx.secrets.get(secretKey(this.host))) ?? null }
  async signedIn(): Promise<boolean> { return !!(await this.token()) }
  async refreshContext(): Promise<void> { await vscode.commands.executeCommand('setContext', 'dithub.signedIn', await this.signedIn()) }

  private onUnauthorized(): void {
    // A 401 means the stored token is dead (revoked on the site, signed out elsewhere, or expired): never keep it around.
    void this.forget()
    const now = Date.now()
    if (now - this.unauthorizedPrompted < 60_000) return
    this.unauthorizedPrompted = now
    void vscode.window.showWarningMessage(`Dithub: you are signed out of ${this.host} or your token was revoked.`, 'Sign in').then((c) => { if (c === 'Sign in') void vscode.commands.executeCommand('dithub.signIn') })
  }

  /** Device-code login: show the code, open the approval page, poll until approved (cancellable). */
  async signIn(): Promise<boolean> {
    const host = this.host
    const anon = new DithubClient({ host })
    const machine = (() => { try { return hostname().replace(/[^\w.-]/g, '').slice(0, 24) || 'machine' } catch { return 'machine' } })()
    let dev: Awaited<ReturnType<DithubClient['startDeviceLogin']>>
    try { dev = await anon.startDeviceLogin(`VS Code on ${machine}`) }
    catch (err) { void vscode.window.showErrorMessage(`Dithub sign-in could not start: ${(err as Error).message}`); return false }
    // Only open http(s) URLs on the configured host.
    let verification: vscode.Uri
    try {
      const u = new URL(dev.verificationUrl)
      if ((u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error('bad scheme')
      verification = vscode.Uri.parse(u.toString(), true)
    } catch { void vscode.window.showErrorMessage('Dithub sign-in: the server returned an invalid approval URL.'); return false }

    void vscode.window.showInformationMessage(
      `Dithub sign-in code: ${dev.userCode}. Check that the browser page shows the same code, then press Approve.`, 'Copy code', 'Open page again',
    ).then(async (c) => {
      if (c === 'Copy code') await vscode.env.clipboard.writeText(dev.userCode)
      if (c === 'Open page again') await vscode.env.openExternal(verification)
    })
    await vscode.env.openExternal(verification)

    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Dithub: waiting for approval of code ${dev.userCode} in the browser…`, cancellable: true }, async (_p, cancel) => {
      const deadline = Date.now() + Math.max(30, dev.expiresIn) * 1000
      let interval = Math.max(2, dev.interval) * 1000
      while (Date.now() < deadline && !cancel.isCancellationRequested) {
        await Promise.race([sleep(interval), new Promise<void>((r) => cancel.onCancellationRequested(() => r()))])
        if (cancel.isCancellationRequested) return 'cancelled' as const
        try {
          const r = await anon.pollDeviceToken(dev.deviceCode)
          if (r.status === 'ok') return { token: r.token, login: r.login }
          if (r.status === 'slow_down') interval += 5000
          else if (r.status === 'denied') return 'denied' as const
          else if (r.status === 'expired') return 'expired' as const
        } catch (err) {
          // transient network trouble: keep polling until the deadline
          this.log.appendLine(`sign-in poll failed: ${err instanceof ApiError ? `HTTP ${err.status} ${err.message}` : (err as Error).message}`)
        }
      }
      return cancel.isCancellationRequested ? 'cancelled' as const : 'expired' as const
    })
    if (typeof result === 'string') {
      if (result !== 'cancelled') void vscode.window.showErrorMessage(result === 'denied' ? 'Dithub sign-in was denied in the browser.' : 'The Dithub sign-in code expired. Run "Dithub: Sign in" again.')
      return false
    }
    await this.ctx.secrets.store(secretKey(host), result.token)
    await this.ctx.globalState.update(loginKey(host), result.login)
    await this.refreshContext()
    this.changed.fire()
    void vscode.window.showInformationMessage(`Signed in to Dithub as @${result.login}.`)
    return true
  }

  async signOut(): Promise<void> {
    const host = this.host
    const token = await this.token()
    let note = ''
    if (token) {
      try { if (!(await this.client.revokeToken(token))) note = ' (the token was already invalid on the server)' }
      catch { note = ' (could not reach the server to revoke the token; revoke it on the site if needed)' }
    }
    await this.ctx.secrets.delete(secretKey(host))
    await this.ctx.globalState.update(loginKey(host), undefined)
    await this.refreshContext()
    this.changed.fire()
    void vscode.window.showInformationMessage(token ? `Signed out of ${host}${note}.` : `You were not signed in to ${host}.`)
  }

  /** Remove the stored credential for the current host without contacting the server. */
  async forget(): Promise<void> {
    const host = this.host
    if (!(await this.ctx.secrets.get(secretKey(host)))) return
    await this.ctx.secrets.delete(secretKey(host))
    await this.ctx.globalState.update(loginKey(host), undefined)
    await this.refreshContext()
    this.changed.fire()
  }

  /** Ensure a token exists; offers to sign in. */
  async require(): Promise<boolean> {
    if (await this.signedIn()) return true
    const c = await vscode.window.showInformationMessage('Sign in to Dithub first.', 'Sign in')
    return c === 'Sign in' ? this.signIn() : false
  }

  dispose(): void { this.changed.dispose(); for (const s of this.subs) s.dispose() }
}
