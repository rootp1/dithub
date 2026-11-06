// Throwaway check: after a username change, does every API surface show the new login?
import { createSiweMessage } from 'viem/siwe'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const BASE = process.env.BASE_URL ?? 'http://localhost:3000', host = new URL(BASE).host
let cookie = ''
const req = async (path: string, init: RequestInit = {}) => { const r = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]!; return r }
const acct = privateKeyToAccount(generatePrivateKey())
const { nonce } = await (await req('/api/auth/nonce')).json() as { nonce: string }
const message = createSiweMessage({ address: acct.address, chainId: 11155111, domain: host, nonce, uri: BASE, version: '1' })
const first = await (await req('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature: await acct.signMessage({ message }) }) })).json() as { user: { login: string } }
const oldLogin = first.user.login
const repoName = `rn-${Date.now().toString(36)}`
await req('/api/repos', { method: 'POST', body: JSON.stringify({ name: repoName }) })
const newLogin = `renamed-${Date.now().toString(36)}`
const patch = await req('/api/me', { method: 'PATCH', body: JSON.stringify({ login: newLogin }) })
console.log(`old=${oldLogin} new=${newLogin} patch=${patch.status}`)
const show = (label: string, v: unknown) => console.log(`${String(v).includes(oldLogin) ? 'STALE ' : 'ok    '} ${label}: ${String(v).slice(0, 110)}`)
show('/api/me', JSON.stringify(await (await req('/api/me')).json()))
const list = await (await req('/api/repos')).json() as { repos: { owner: string; name: string }[] }
show('/api/repos owner', list.repos.find((r) => r.name === repoName)?.owner)
const detail = await (await req(`/api/repos/${newLogin}/${repoName}`)).json() as { owner: string; cloneUrl: string }
show('repo detail owner', detail.owner); show('repo cloneUrl', detail.cloneUrl)
const nm = await req(`/api/names/${newLogin}/${repoName}`); show(`/api/names/${newLogin}/${repoName}`, `${nm.status} ${await nm.text()}`)
const oldNm = await req(`/api/names/${oldLogin}/${repoName}`); console.log(`       old-name lookup /api/names/${oldLogin}/${repoName}: ${oldNm.status}`)
const oldRepo = await req(`/api/repos/${oldLogin}/${repoName}`); console.log(`       old-name repo URL still resolves: ${oldRepo.status === 200}`)
