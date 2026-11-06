export {}
interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
const eth = (window as unknown as { ethereum?: Eth }).ethereum
const app = document.getElementById('app')!, nav = document.getElementById('nav')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '')
const ago = (d: string) => { const s = (Date.now() - new Date(d).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }
const etherscan = (chain: number | null, tx: string) => (chain === 11155111 ? `https://sepolia.etherscan.io/tx/${tx}` : '#')

let me: { id: number; login: string; wallet: string | null } | null = null
async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body as T
}

async function connect() {
  if (!eth) throw new Error('No wallet found. Install MetaMask or another EIP-1193 wallet.')
  const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
  const { nonce } = await api<{ nonce: string }>('/api/auth/nonce')
  const issued = new Date().toISOString(), expires = new Date(Date.now() + 5 * 60_000).toISOString()
  const message = `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Dheet\n\nURI: ${location.origin}\nVersion: 1\nChain ID: 11155111\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expires}`
  const signature = (await eth.request({ method: 'personal_sign', params: [message, address] })) as string
  const r = await api<{ user: typeof me }>('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) })
  me = r.user; render()
}

function renderNav() {
  nav.innerHTML = me
    ? `<a href="/new">New repo</a><a href="/orgs/new">New org</a><a href="/settings">${esc(me.login)}</a><button class="ghost" id="out">Sign out</button>`
    : `<button id="in">Connect wallet</button>`
  document.getElementById('in')?.addEventListener('click', () => connect().catch((e) => alert(e.message)))
  document.getElementById('out')?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); me = null; render() })
}

async function home() {
  const { repos } = await api<{ repos: any[] }>('/api/repos')
  app.innerHTML = `<h1>Repositories</h1><div class="card list">${repos.map((r) => `
    <div><a href="/${esc(r.owner)}/${esc(r.name)}"><b>${esc(r.owner)}/${esc(r.name)}</b></a>
    <span class="chip">${esc(r.visibility)}</span><div class="muted">${esc(r.description ?? '')}</div>
    <div class="muted mono">repoId ${short(r.repoId)}</div></div>`).join('') || '<p class="muted">No repositories yet.</p>'}</div>`
}

function newRepo() {
  if (!me) { app.innerHTML = '<div class="card">Connect your wallet to create a repository.</div>'; return }
  app.innerHTML = `<h1>Create a repository</h1><form class="card" id="f"><div class="row">
    <input id="org" placeholder="organisation (optional)"><span>/</span><input id="name" placeholder="repo-name" required class="grow"></div>
    <p><select id="vis"><option>public</option><option>private</option></select></p>
    <p><input id="desc" placeholder="description" style="width:100%"></p><button>Create</button> <span id="e" class="err"></span></form>`
  document.getElementById('f')!.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    try {
      const org = (document.getElementById('org') as HTMLInputElement).value.trim()
      const r = await api('/api/repos', { method: 'POST', body: JSON.stringify({ name: (document.getElementById('name') as HTMLInputElement).value.trim(),
        ...(org ? { org } : {}), visibility: (document.getElementById('vis') as HTMLSelectElement).value, description: (document.getElementById('desc') as HTMLInputElement).value }) })
      history.pushState({}, '', `/${r.owner}/${r.name}`); render()
    } catch (e) { document.getElementById('e')!.textContent = (e as Error).message }
  })
}

async function settings() {
  if (!me) { app.innerHTML = '<div class="card">Connect your wallet first.</div>'; return }
  app.innerHTML = `<h1>Account</h1><div class="card"><p>Wallet <code>${esc(me.wallet)}</code></p>
    <div class="row"><input id="login" value="${esc(me.login)}"><button id="save">Set username</button></div><p id="m" class="muted"></p></div>
    <div class="card"><h2>Personal access token</h2><p class="muted">Use it as the password when you <code>git push</code> over HTTPS.</p>
    <button id="tok">Create token</button><pre id="t" hidden></pre></div>`
  document.getElementById('save')!.onclick = async () => { try { const r = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ login: (document.getElementById('login') as HTMLInputElement).value }) }); me!.login = r.login; renderNav(); document.getElementById('m')!.textContent = 'Saved.' } catch (e) { document.getElementById('m')!.textContent = (e as Error).message } }
  document.getElementById('tok')!.onclick = async () => { const r = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'web' }) }); const t = document.getElementById('t')!; t.hidden = false; t.textContent = `${r.token}\n(shown once; copy it now)` }
}


const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim()
const act = (id: string, fn: () => Promise<unknown>) => { document.getElementById(id)!.onclick = async () => { try { await fn(); render() } catch (e) { alert((e as Error).message) } } }
const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const del = (path: string) => api(path, { method: 'DELETE' })

function newOrg() {
  if (!me) { app.innerHTML = '<div class="card">Connect your wallet first.</div>'; return }
  app.innerHTML = `<h1>Create an organisation</h1><div class="card"><div class="row"><input id="ol" placeholder="org-name" class="grow">
    <select id="ov"><option value="public">public (role changes are verifiable)</option><option value="private">private (not on-chain)</option></select></div>
    <p><button id="mk">Create</button></p></div>`
  act('mk', async () => { const r = await api('/api/orgs', { method: 'POST', body: JSON.stringify({ login: val('ol'), visibility: (document.getElementById('ov') as HTMLSelectElement).value }) }); history.pushState({}, '', `/orgs/${r.org.login}`) })
}

async function orgPage(login: string) {
  const o = await api(`/api/orgs/${login}`)
  const log = await api(`/api/orgs/${login}/rbac-log`)
  const owner = o.yourRole === 'owner'
  const badge = log.verifiable ? '<span class="chip ok">verifiable: role changes are hash-chained and mirrored to Arkiv</span>' : '<span class="chip warn">private: role changes are not on-chain</span>'
  app.innerHTML = `<h1>${esc(o.login)} <span class="chip">${esc(o.visibility)}</span></h1><p>${badge}</p>
    <div class="card"><h2>Members</h2><div class="list">${o.members.map((m: any) => `<div class="row"><b class="grow">${esc(m.login)}</b><span class="chip">${esc(m.role)}</span>
      ${owner ? `<button class="ghost" data-role="${esc(m.login)}|${m.role === 'owner' ? 'member' : 'owner'}">make ${m.role === 'owner' ? 'member' : 'owner'}</button><button class="ghost" data-rm="${esc(m.login)}">remove</button>` : ''}</div>`).join('')}</div>
      ${owner ? `<div class="row"><input id="nm" placeholder="username" class="grow"><select id="nr"><option>member</option><option>owner</option></select><button id="addm">Add member</button></div>` : ''}</div>
    <div class="card"><h2>Teams</h2><div class="list">${o.teams.map((t: any) => `<div>${esc(t.slug)} <span class="muted">${t.members} member(s)</span></div>`).join('') || '<p class="muted">No teams.</p>'}</div>
      ${owner ? `<div class="row"><input id="ts" placeholder="team-slug" class="grow"><button id="addt">Create team</button></div>` : ''}</div>
    <div class="card"><h2>Role change log</h2><p class="muted mono">head ${short(log.head)} · ${log.events.length} event(s)</p><div class="list">${log.events.map((e: any) => `<div class="mono">#${e.seq} ${esc(e.action)} by ${esc(e.actor)} · hash ${short(e.hash)}
      ${e.arkivTx ? `<span class="chip ok">Arkiv ${short(e.arkivTx)}</span>` : log.verifiable ? '<span class="chip warn">pending</span>' : ''}</div>`).join('')}</div></div>`
  document.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) => { b.onclick = async () => { const [u, r] = b.dataset.role!.split('|'); try { await put(`/api/orgs/${login}/members/${u}`, { role: r }); render() } catch (e) { alert((e as Error).message) } } })
  document.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => { b.onclick = async () => { try { await del(`/api/orgs/${login}/members/${b.dataset.rm}`); render() } catch (e) { alert((e as Error).message) } } })
  if (owner) {
    act('addm', () => put(`/api/orgs/${login}/members/${val('nm')}`, { role: (document.getElementById('nr') as HTMLSelectElement).value }))
    act('addt', () => api(`/api/orgs/${login}/teams`, { method: 'POST', body: JSON.stringify({ slug: val('ts') }) }))
  }
}

async function repoSettings(owner: string, name: string) {
  const base = `/api/repos/${owner}/${name}`
  let c, p
  try { [c, p] = await Promise.all([api(`${base}/collaborators`), api(`${base}/protections`)]) } catch (e) { return `<div class="card muted">${esc((e as Error).message)}</div>` }
  setTimeout(() => {
    act('addc', () => put(`${base}/collaborators/${val('cu')}`, { permission: (document.getElementById('cp') as HTMLSelectElement).value }))
    document.querySelectorAll<HTMLButtonElement>('[data-rc]').forEach((b) => { b.onclick = async () => { try { await del(`${base}/collaborators/${b.dataset.rc}`); render() } catch (e) { alert((e as Error).message) } } })
    act('addp', () => put(`${base}/protections`, { pattern: val('pp'), requirePr: (document.getElementById('pr') as HTMLInputElement).checked }))
    document.querySelectorAll<HTMLButtonElement>('[data-rp]').forEach((b) => { b.onclick = async () => { try { await del(`${base}/protections?pattern=${encodeURIComponent(b.dataset.rp!)}`); render() } catch (e) { alert((e as Error).message) } } })
  })
  return `<div class="card"><h2>Collaborators</h2><div class="list">${c.collaborators.map((x: any) => `<div class="row"><b class="grow">${esc(x.login)}</b><span class="chip">${esc(x.permission)}</span><button class="ghost" data-rc="${esc(x.login)}">remove</button></div>`).join('') || '<p class="muted">None.</p>'}</div>
    <div class="row"><input id="cu" placeholder="username" class="grow"><select id="cp">${['read', 'triage', 'write', 'maintain', 'admin'].map((x) => `<option>${x}</option>`).join('')}</select><button id="addc">Add</button></div></div>
    <div class="card"><h2>Branch protection</h2><div class="list">${p.protections.map((x: any) => `<div class="row"><code class="grow">${esc(x.pattern)}</code><span class="chip">${x.require_pr ? 'PR required' : 'direct push ok'}</span><button class="ghost" data-rp="${esc(x.pattern)}">remove</button></div>`).join('') || '<p class="muted">None.</p>'}</div>
    <div class="row"><input id="pp" placeholder="main or release/*" class="grow"><label><input type="checkbox" id="pr" checked> require pull request</label><button id="addp">Protect</button></div></div>`
}

async function repoPage(owner: string, name: string, tab: string, params: URLSearchParams) {
  const repo = await api(`/api/repos/${owner}/${name}`)
  const base = `/${esc(owner)}/${esc(name)}`
  const tabs = (['code', 'commits', 'ledger', 'settings'] as const).map((t) => `<a class="${tab === t ? 'on' : ''}" href="${base}${t === 'code' ? '' : '/' + t}">${t}</a>`).join('')
  let body = ''
  if (tab === 'code') {
    const path = params.get('path') ?? '', file = params.get('file')
    if (file) {
      const b = await api(`/api/repos/${owner}/${name}/blob?path=${encodeURIComponent(file)}`)
      body = `<div class="crumbs"><a href="${base}">${esc(name)}</a> / ${esc(file)}</div><pre>${b.binary ? '(binary file)' : b.truncated ? '(file too large to display)' : esc(b.content)}</pre>`
    } else {
      const t = await api(`/api/repos/${owner}/${name}/tree?path=${encodeURIComponent(path)}`)
      const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      body = `<div class="card list">${path ? `<div><a href="${base}?path=${encodeURIComponent(up)}">..</a></div>` : ''}${t.entries.map((e: any) =>
        `<div>${e.type === 'tree' ? '📁' : '📄'} <a href="${base}?${e.type === 'tree' ? 'path' : 'file'}=${encodeURIComponent(e.path)}">${esc(e.name)}</a></div>`).join('') || '<p class="muted">Empty repository. Push a commit to get started.</p>'}</div>`
    }
    body += `<div class="card"><h2>Clone</h2><pre>git clone ${esc(repo.cloneUrl)}</pre><p class="muted">Push with a personal access token as the password.</p></div>`
  } else if (tab === 'commits') {
    const { commits } = await api(`/api/repos/${owner}/${name}/commits`)
    body = `<div class="card list">${commits.map((c: any) => {
      const a = c.anchor
      const chips = [`<span class="chip ${a.status === 'anchored' ? 'ok' : 'warn'}">${esc(a.status)}</span>`,
        a.l1Tx ? `<a class="chip mono" href="${etherscan(a.l1ChainId, a.l1Tx)}" target="_blank" rel="noopener">L1 ${short(a.l1Tx)}</a>` : '',
        a.arkivTx ? `<span class="chip mono" title="Arkiv transaction ${esc(a.arkivTx)}">Arkiv ${short(a.arkivTx)}</span>` : ''].join('')
      return `<div><b>${esc(c.subject)}</b><div class="muted">${esc(c.author)} · ${ago(c.committedAt)} · <code>${esc(c.oid?.slice(2, 9))}</code></div><div>${chips}</div></div>`
    }).join('') || '<p class="muted">No commits yet.</p>'}</div>`
  } else if (tab === 'settings') {
    body = await repoSettings(owner, name)
  } else {
    const l = await api(`/api/repos/${owner}/${name}/ledger`)
    body = `<div class="card"><h2>L1 anchors</h2><div class="list">${l.anchors.map((a: any) => `<div class="mono">${esc(a.ref_name.slice(0, 40))} · seq ${esc(a.ref_sequence)} · <a href="${etherscan(a.chain_id, '0x' + a.tx)}" target="_blank" rel="noopener">0x${esc(a.tx.slice(0, 10))}…</a></div>`).join('') || '<p class="muted">None yet.</p>'}</div></div>
      <div class="card"><h2>Arkiv entities</h2><div class="list">${l.entities.map((e: any) => `<div class="mono"><span class="chip">${esc(e.schema)}</span> 0x${esc(e.entity.slice(0, 14))}… · expires block ${esc(e.expires_at_block)}</div>`).join('') || '<p class="muted">None yet.</p>'}</div></div>`
  }
  app.innerHTML = `<h1>${esc(owner)} / ${esc(name)} <span class="chip">${esc(repo.visibility)}</span></h1>
    <p class="muted">${esc(repo.description ?? '')} <span class="mono">repoId ${short(repo.repoId)}</span></p><div class="tabs">${tabs}</div>${body}`
}

async function render() {
  renderNav()
  const url = new URL(location.href), parts = url.pathname.split('/').filter(Boolean)
  try {
    if (parts.length === 0) await home()
    else if (parts[0] === 'new') newRepo()
    else if (parts[0] === 'settings') await settings()
    else if (parts[0] === 'orgs' && parts[1] === 'new') newOrg()
    else if (parts[0] === 'orgs' && parts[1]) await orgPage(parts[1])
    else if (parts.length >= 2) await repoPage(parts[0]!, parts[1]!, parts[2] ?? 'code', url.searchParams)
  } catch (e) { app.innerHTML = `<div class="card err">${esc((e as Error).message)}</div>` }
}
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a')
  if (a && a.origin === location.origin && !a.target && a.pathname !== '#') { e.preventDefault(); history.pushState({}, '', a.href); render() }
})
window.addEventListener('popstate', render)
api<{ user: typeof me }>('/api/me').then((r) => { me = r.user }).catch(() => {}).finally(render)
