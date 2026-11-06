// dit keys: this device's X25519 key for private repositories. The private key stays in the dit config dir (0600);
// the public key is registered with the server, bound to the user's wallet by a personal_sign signature.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deviceKeyStatement, devicePublicKey, generateDeviceKey, verifyDeviceKey } from '../../../sdk/src/keys.ts'
import { apiFor } from '../api.ts'
import { flag, parse, str } from '../args.ts'
import { configDir, primaryHost } from '../config.ts'
import { DitError, UsageError } from '../errors.ts'
import { c, info, printJson } from '../ui.ts'

export interface StoredDeviceKey {
  version: 1
  privateKey: string
  publicKey: string
  createdAt: string
  registered?: Record<string, { wallet: string; at: string }>
}

export const deviceKeyPath = (env: NodeJS.ProcessEnv = process.env) => join(configDir(env), 'device-key.json')

export function loadDeviceKey(env: NodeJS.ProcessEnv = process.env): StoredDeviceKey | null {
  const file = deviceKeyPath(env)
  if (!existsSync(file)) return null
  let k: StoredDeviceKey
  try { k = JSON.parse(readFileSync(file, 'utf8')) as StoredDeviceKey } catch { throw new DitError(`${file} is not valid JSON`, 1, 'Move it away and run `dit keys init`.') }
  if (k.version !== 1 || !/^0x[0-9a-f]{64}$/.test(k.privateKey ?? '') || devicePublicKey(k.privateKey) !== k.publicKey) {
    throw new DitError(`${file} is not a valid dit device key`, 1, 'Move it away and run `dit keys init`.')
  }
  return k
}

export function saveDeviceKey(k: StoredDeviceKey, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* not ours to chmod */ }
  const file = deviceKeyPath(env), tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return file
}

export function newStoredDeviceKey(now = new Date()): StoredDeviceKey {
  const k = generateDeviceKey()
  return { version: 1, privateKey: k.privateKey, publicKey: k.publicKey, createdAt: now.toISOString() }
}

/** Web page where the signed-in user signs the statement with their wallet and registers the key. */
export function signUrl(host: string, publicKey: string): string {
  const u = new URL('/settings/device-keys', host)
  u.searchParams.set('publicKey', publicKey)
  return u.toString()
}

export function normalizeSignature(s: string): `0x${string}` {
  const v = s.trim()
  const hex = v.startsWith('0x') ? v : `0x${v}`
  if (!/^0x[0-9a-fA-F]{130}$/.test(hex)) throw new UsageError('signature must be a 65-byte hex personal_sign signature')
  return hex.toLowerCase() as `0x${string}`
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const ch of process.stdin) chunks.push(ch as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function register(k: StoredDeviceKey, host: string, flagHost: string | undefined, sigArg: string | undefined, json: boolean): Promise<number> {
  const api = apiFor(host, { flagHost })
  if (!api.hasToken) throw new DitError(`not logged in to ${host}`, 1, 'Run `dit login` first.')
  const me = await api.get<{ user: { login: string; wallet: string | null } | null }>('/api/me')
  if (!me.user) throw new DitError(`not logged in to ${host}`, 1, 'Run `dit login` first.')
  const wallet = me.user.wallet
  if (!wallet) throw new DitError('your account has no wallet linked', 1, 'Link a wallet on the site; device keys are bound to it.')
  const statement = deviceKeyStatement(wallet, k.publicKey)

  if (!sigArg) {
    const url = signUrl(host, k.publicKey)
    if (json) { printJson({ host, publicKey: k.publicKey, wallet, registered: false, statement, signUrl: url }); return 0 }
    info(`Device key ${c.bold(k.publicKey)} is not registered yet.`)
    info(`Open ${url} and sign with ${wallet}, or sign this text with personal_sign:\n`)
    info(statement.split('\n').map((l) => `  ${l}`).join('\n'))
    info(`\nthen run: dit keys register --signature 0x...`)
    return 0
  }

  const signature = normalizeSignature(sigArg === '-' ? await readStdin() : sigArg)
  if (!(await verifyDeviceKey({ wallet, publicKey: k.publicKey, signature }))) {
    throw new DitError(`that signature is not ${wallet}'s signature of this device key statement`, 1, 'Run `dit keys register` without --signature to print the exact text to sign.')
  }
  await api.post('/api/user/device-keys', { publicKey: k.publicKey, signature })
  const registered = { ...(k.registered ?? {}), [host]: { wallet, at: new Date().toISOString() } }
  saveDeviceKey({ ...k, registered })
  if (json) printJson({ host, publicKey: k.publicKey, wallet, registered: true })
  else info(`${c.green('Registered')} device key ${c.bold(k.publicKey)} for ${wallet} on ${host}.`)
  return 0
}

export async function keysCmd(argv: string[]): Promise<number> {
  const [sub = 'show', ...rest] = argv
  const p = parse(rest, { force: { type: 'boolean' }, signature: { type: 'string' } }, { allowPositionals: false })
  const flagHost = str(p.values.host), json = flag(p.values.json)
  const host = primaryHost(flagHost)

  if (sub === 'init') {
    let k = loadDeviceKey()
    if (k && !flag(p.values.force)) {
      if (!json) info(`Using the existing device key at ${deviceKeyPath()} (--force replaces it; access granted to the old key is lost).`)
    } else {
      k = newStoredDeviceKey()
      const file = saveDeviceKey(k)
      if (!json) info(`${c.green('Created')} device key ${c.bold(k.publicKey)} at ${file}`)
    }
    return register(k, host, flagHost, str(p.values.signature), json)
  }
  if (sub === 'register') {
    const k = loadDeviceKey()
    if (!k) throw new DitError('no device key on this machine', 1, 'Run `dit keys init`.')
    return register(k, host, flagHost, str(p.values.signature), json)
  }
  if (sub === 'show') {
    const k = loadDeviceKey()
    if (!k) {
      if (json) printJson({ path: deviceKeyPath(), publicKey: null })
      else info('No device key on this machine. Run `dit keys init`.')
      return json ? 0 : 1
    }
    const reg = k.registered?.[host] ?? null
    if (json) { printJson({ path: deviceKeyPath(), publicKey: k.publicKey, createdAt: k.createdAt, host, registered: reg }); return 0 }
    console.log(`public key  ${k.publicKey}`)
    console.log(`created     ${k.createdAt}`)
    console.log(`file        ${deviceKeyPath()}`)
    console.log(`registered  ${reg ? `${host} (${reg.wallet}, ${reg.at})` : `no (on ${host}); run \`dit keys register\``}`)
    return 0
  }
  throw new UsageError(`unknown subcommand: keys ${sub}`, 'Use: dit keys init|register|show')
}
