// Per-host credentials (0600, directory 0700) and small non-secret settings (default host, current session).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOST } from './constants.ts'
import { UsageError } from './errors.ts'

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DIT_CONFIG_DIR) return env.DIT_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'dit')
  return join(env.HOME ?? homedir(), '.config', 'dit')
}

export interface Credential { token: string; login: string; savedAt: string }
export interface SessionRef { id: string; owner: string; repo: string; role: string; ref: string; issueNumber: number; expiresAt: string; allowedPaths: string[] }
interface CredFile { version: 1; hosts: Record<string, Credential> }
interface ConfigFile { host?: string; sessions?: Record<string, SessionRef> }

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}
function writeSecure(file: string, data: unknown): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* not ours to chmod */ }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

const credFile = () => join(configDir(), 'credentials.json')
const cfgFile = () => join(configDir(), 'config.json')

/** "localhost:3300", "https://x.y/" -> "https://x.y" (scheme defaults to https, localhost to http). */
export function normalizeHost(input: string): string {
  let s = input.trim()
  if (!s) throw new UsageError('empty host')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${/^(localhost|127\.|\[::1\])/i.test(s) ? 'http' : 'https'}://${s}`
  let u: URL
  try { u = new URL(s) } catch { throw new UsageError(`invalid host: ${input}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError(`host must be http(s): ${input}`)
  return u.origin
}

const readCreds = (): CredFile => readJson<CredFile>(credFile(), { version: 1, hosts: {} })
export const readConfig = (): ConfigFile => readJson<ConfigFile>(cfgFile(), {})
const writeConfig = (c: ConfigFile) => writeSecure(cfgFile(), c)

/** Default host: --host, DIT_HOST, config.json, then the production site. */
export function primaryHost(flagHost?: string): string {
  return normalizeHost(flagHost ?? process.env.DIT_HOST ?? readConfig().host ?? DEFAULT_HOST)
}

export type TokenSource = 'env' | 'file'
/** DIT_TOKEN applies only to the primary host (never leaks to another host found in a remote URL). */
export function findToken(host: string, flagHost?: string): { token: string; source: TokenSource; login?: string } | null {
  const h = normalizeHost(host)
  const env = process.env.DIT_TOKEN?.trim()
  if (env && h === primaryHost(flagHost)) return { token: env, source: 'env' }
  const c = readCreds().hosts[h]
  return c?.token ? { token: c.token, source: 'file', login: c.login } : null
}

export const storedHosts = (): string[] => Object.keys(readCreds().hosts)

export function saveCredential(host: string, cred: Omit<Credential, 'savedAt'>): void {
  const f = readCreds()
  f.hosts[normalizeHost(host)] = { ...cred, savedAt: new Date().toISOString() }
  writeSecure(credFile(), f)
  const cfg = readConfig()
  if (!cfg.host) writeConfig({ ...cfg, host: normalizeHost(host) })
}

export function deleteCredential(host: string): boolean {
  const f = readCreds(), h = normalizeHost(host)
  if (!f.hosts[h]) return false
  delete f.hosts[h]
  if (Object.keys(f.hosts).length) writeSecure(credFile(), f)
  else rmSync(credFile(), { force: true })
  return true
}

export function setDefaultHost(host: string): void { writeConfig({ ...readConfig(), host: normalizeHost(host) }) }

export function currentSession(host: string): SessionRef | null {
  return readConfig().sessions?.[normalizeHost(host)] ?? null
}
export function setCurrentSession(host: string, s: SessionRef | null): void {
  const cfg = readConfig(), h = normalizeHost(host)
  const sessions = { ...(cfg.sessions ?? {}) }
  if (s) sessions[h] = s; else delete sessions[h]
  writeConfig({ ...cfg, sessions })
}

export const credentialsPath = credFile
export const hasCredentialFile = () => existsSync(credFile())
