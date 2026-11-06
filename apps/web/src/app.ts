export {}
interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
const eth = (window as unknown as { ethereum?: Eth }).ethereum
const app = document.getElementById('app')!, nav = document.getElementById('nav')!
import { esc, short, ago, etherscanTx, isTxHash, parsePaths, countdown, parseDiff, renderDiff } from './helpers.ts'
import { ATTESTATIONS, REGISTRY, SEL_LATEST_ATTESTATION, SEL_LATEST_RELEASE, bundleHashOf, decodeLatestAttestation, decodeLatestRelease, ethCall, evaluate, sha256Hex, type BuildJson, type Check, type OnchainAttestation, type OnchainRelease } from './verify.ts'
const etherscan = (chain: number | null, tx: string) => (chain === 11155111 ? `https://sepolia.etherscan.io/tx/${tx}` : '#')

let me: { id: number; login: string; wallet: string | null } | null = null
class ApiError extends Error { constructor(msg: string, readonly status: number, readonly body: any) { super(msg) } }
async function api<T = any>(path: string, init?: RequestInit, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...extra } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body)
  return body as T
}
/** Scoped fetch: ALWAYS carries the session header (task-scoped need-to-know access). */
const sapi = <T = any>(sid: string, path: string, init?: RequestInit) => api<T>(path, init, { 'x-dheet-session': sid })
const post = <T = any>(path: string, body: unknown, extra?: Record<string, string>) => api<T>(path, { method: 'POST', body: JSON.stringify(body) }, extra)
const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
const $ = (id: string) => document.getElementById(id)!
const say = (id: string, msg: string, bad = true) => { const e = $(id); e.textContent = msg; e.className = bad ? 'err' : 'muted' }
const nav2 = (path: string) => { history.pushState({}, '', path); render() }

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
    ? `<a href="/new">New repo</a><a href="/orgs/new">New org</a><a href="/sessions">My sessions</a><a href="/deployments">Deployments</a><a href="/settings">${esc(me.login)}</a><button class="ghost" id="out">Sign out</button>`
    : `<a href="/deployments">Deployments</a><button id="in">Connect wallet</button>`
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

async function repoPage(owner: string, name: string, tab: string, params: URLSearchParams, sub?: string) {
  const repo = await api(`/api/repos/${owner}/${name}`)
  const base = `/${esc(owner)}/${esc(name)}`
  const tabNames = ['code', 'commits', 'issues', 'pulls', ...(repo.canWrite ? ['sessions'] : []), 'ledger', 'settings']
  let wire: (() => void) | undefined
  const tabs = tabNames.map((t) => `<a class="${tab === t ? 'on' : ''}"${tab === t ? ' aria-current="page"' : ''} href="${base}${t === 'code' ? '' : '/' + t}">${t}</a>`).join('')
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
  } else if (tab === 'issues' || tab === 'pulls' || tab === 'sessions') {
    const r = tab === 'issues' ? await issuesTab(owner, name, sub, params) : tab === 'pulls' ? await pullsTab(owner, name, repo, sub, params) : await sessionsAdminTab(owner, name, repo)
    body = r.html; wire = r.wire
  } else {
    const l = await api(`/api/repos/${owner}/${name}/ledger`)
    body = `<div class="card"><h2>L1 anchors</h2><div class="list">${l.anchors.map((a: any) => `<div class="mono">${esc(a.ref_name.slice(0, 40))} · seq ${esc(a.ref_sequence)} · <a href="${etherscan(a.chain_id, '0x' + a.tx)}" target="_blank" rel="noopener">0x${esc(a.tx.slice(0, 10))}…</a></div>`).join('') || '<p class="muted">None yet.</p>'}</div></div>
      <div class="card"><h2>Arkiv entities</h2><div class="list">${l.entities.map((e: any) => `<div class="mono"><span class="chip">${esc(e.schema)}</span> 0x${esc(e.entity.slice(0, 14))}… · expires block ${esc(e.expires_at_block)}</div>`).join('') || '<p class="muted">None yet.</p>'}</div></div>`
  }
  app.innerHTML = `<h1>${esc(owner)} / ${esc(name)} <span class="chip">${esc(repo.visibility)}</span></h1>
    <p class="muted">${esc(repo.description ?? '')} <span class="mono">repoId ${short(repo.repoId)}</span></p><nav class="tabs" aria-label="Repository">${tabs}</nav>${body}`
  wire?.()
}

// ---------------------------------------------------------------- shared UI bits
type Tab = { html: string; wire?: () => void }
const chipFor = (state: string) => `<span class="chip ${state === 'open' ? 'ok' : state === 'merged' ? 'merged' : 'warn'}">${esc(state)}</span>`
const text = (s: unknown) => `<div class="text">${esc(s) || '<span class="muted">(empty)</span>'}</div>`
const needSignIn = '<div class="card">Connect your wallet to do this.</div>'
const labelChips = (ls: any[]) => (ls ?? []).map((l) => `<span class="chip">${esc(l.name)}</span>`).join('')
const field = (id: string, label: string, input: string) => `<div class="field"><label for="${id}">${esc(label)}</label>${input}</div>`
/** Run an async action from a button; show errors inline in #msgId (role=alert) instead of alert(). */
function wireAction(btnId: string, msgId: string, fn: () => Promise<unknown>, after: () => void = render) {
  const b = $(btnId) as HTMLButtonElement
  b.onclick = async () => {
    b.disabled = true; say(msgId, '', false)
    try { await fn(); after() } catch (e) { say(msgId, (e as Error).message); b.disabled = false }
  }
}
const pager = (base: string, params: URLSearchParams, page: number, total: number, per: number) => {
  const link = (p: number, t: string) => { const q = new URLSearchParams(params); q.set('page', String(p)); return `<a href="${base}?${esc(q.toString())}">${t}</a>` }
  return `<p class="row muted">${page > 1 ? link(page - 1, '← newer') : ''}<span>page ${page} of ${Math.max(1, Math.ceil(total / per))}</span>${page * per < total ? link(page + 1, 'older →') : ''}</p>`
}
const stateFilter = (base: string, cur: string, states: string[], q: string) => `<form class="row" id="flt" role="search">
  <select id="fs" aria-label="State">${states.map((s) => `<option${s === cur ? ' selected' : ''}>${s}</option>`).join('')}</select>
  <input id="fq" class="grow" type="search" aria-label="Search" placeholder="search" value="${esc(q)}"><button>Filter</button></form>`
const wireFilter = (base: string) => ($('flt') as HTMLFormElement).addEventListener('submit', (ev) => {
  ev.preventDefault(); const p = new URLSearchParams(); p.set('state', ($('fs') as HTMLSelectElement).value); const q = ($('fq') as HTMLInputElement).value.trim(); if (q) p.set('q', q); nav2(`${base}?${p}`)
})

// ---------------------------------------------------------------- issues
async function issuesTab(owner: string, name: string, sub: string | undefined, params: URLSearchParams): Promise<Tab> {
  const R = `/api/repos/${owner}/${name}`, base = `/${esc(owner)}/${esc(name)}/issues`
  if (sub === 'new') {
    if (!me) return { html: needSignIn }
    return { html: `<form class="card" id="nf"><h2>New issue</h2>${field('it', 'Title', '<input id="it" required maxlength="256" style="width:100%">')}${field('ib', 'Description', '<textarea id="ib" rows="8" style="width:100%"></textarea>')}
      <p><button id="ic">Submit new issue</button> <span id="msg" role="alert" class="err"></span></p></form>`,
      wire: () => { $('nf').addEventListener('submit', (e) => e.preventDefault()); wireAction('ic', 'msg', async () => { const i = await post(`${R}/issues`, { title: val('it'), body: (($('ib') as HTMLTextAreaElement).value) }); history.pushState({}, '', `/${owner}/${name}/issues/${i.number}`) }) } }
  }
  if (sub && /^\d+$/.test(sub)) {
    const [i, cs, ev] = await Promise.all([api(`${R}/issues/${sub}`), api(`${R}/issues/${sub}/comments`), api(`${R}/issues/${sub}/events`)])
    const commentsHtml = cs.comments.map((c: any) => `<div class="card"><div class="muted"><b>${esc(c.author)}</b> · ${esc(ago(c.createdAt))}</div>${text(c.body)}</div>`).join('')
    const html = `<h2>${esc(i.title)} <span class="muted">#${esc(i.number)}</span> ${chipFor(i.state)}</h2>
      <p class="muted">${esc(i.author)} opened ${esc(ago(i.createdAt))} · ${labelChips(i.labels)} ${i.assignees.length ? 'assigned: ' + i.assignees.map(esc).join(', ') : ''}</p>
      <div class="card">${text(i.body)}</div>${commentsHtml}
      ${me ? `<div class="card"><h2>Comment</h2><label class="sr" for="cb">Comment</label><textarea id="cb" rows="4" style="width:100%"></textarea>
        <p class="row"><button id="cc">Comment</button><button id="cs" class="ghost">${i.state === 'open' ? 'Close issue' : 'Reopen issue'}</button><span id="msg" role="alert" class="err"></span></p>
        <div class="row"><input id="lb" aria-label="Label" placeholder="label"><button id="la" class="ghost">Add label</button><input id="as" aria-label="Assignee" placeholder="assignee login"><button id="aa" class="ghost">Assign</button></div>
        <div class="row">${i.labels.map((l: any) => `<button class="ghost" data-rl="${esc(l.name)}" aria-label="Remove label ${esc(l.name)}">× ${esc(l.name)}</button>`).join('')}${i.assignees.map((a: string) => `<button class="ghost" data-ra="${esc(a)}" aria-label="Unassign ${esc(a)}">× @${esc(a)}</button>`).join('')}</div></div>` : needSignIn}
      <div class="card"><h2>Timeline</h2><div class="list">${ev.events.map((e: any) => `<div class="muted mono">${esc(e.event)} by ${esc(e.actor ?? 'system')} · ${esc(ago(e.createdAt))}${e.payload && Object.keys(e.payload).length ? ' · ' + esc(JSON.stringify(e.payload).slice(0, 160)) : ''}</div>`).join('') || '<p class="muted">No events.</p>'}</div></div>`
    return { html: `<p><a href="${base}">← all issues</a></p>${html}`, wire: () => {
      if (!me) return
      wireAction('cc', 'msg', async () => { if (!val('cb')) throw new Error('write something first'); await post(`${R}/issues/${sub}/comments`, { body: val('cb') }) })
      wireAction('cs', 'msg', () => patch(`${R}/issues/${sub}`, { state: i.state === 'open' ? 'closed' : 'open' }))
      wireAction('la', 'msg', () => post(`${R}/issues/${sub}/labels`, { labels: [val('lb')] }))
      wireAction('aa', 'msg', () => post(`${R}/issues/${sub}/assignees`, { assignees: [val('as')] }))
      document.querySelectorAll<HTMLButtonElement>('[data-rl]').forEach((b) => { b.onclick = () => del(`${R}/issues/${sub}/labels/${encodeURIComponent(b.dataset.rl!)}`).then(render, (e) => say('msg', e.message)) })
      document.querySelectorAll<HTMLButtonElement>('[data-ra]').forEach((b) => { b.onclick = () => del(`${R}/issues/${sub}/assignees/${encodeURIComponent(b.dataset.ra!)}`).then(render, (e) => say('msg', e.message)) })
    } }
  }
  const state = ['open', 'closed', 'all'].includes(params.get('state') ?? '') ? params.get('state')! : 'open', q = params.get('q') ?? '', page = Math.max(1, Number(params.get('page')) || 1)
  const qs = new URLSearchParams({ state, page: String(page), per_page: '30' }); if (q) qs.set('q', q)
  const l = await api(`${R}/issues?${qs}`)
  return { html: `<div class="row"><h2 class="grow">Issues</h2><a class="btn" href="${base}/new">New issue</a></div>${stateFilter(base, state, ['open', 'closed', 'all'], q)}
    <div class="card list">${l.issues.map((i: any) => `<div><a href="${base}/${esc(i.number)}"><b>${esc(i.title)}</b></a> ${chipFor(i.state)} ${labelChips(i.labels)}<div class="muted">#${esc(i.number)} by ${esc(i.author)} · ${esc(ago(i.createdAt))} · ${esc(i.comments)} comment(s)</div></div>`).join('') || '<p class="muted">No issues match.</p>'}</div>${pager(base, new URLSearchParams(qs), page, l.total, l.perPage)}`,
    wire: () => wireFilter(base) }
}

// ---------------------------------------------------------------- pull requests
const reviewChip = (s: string) => `<span class="chip ${s === 'approved' ? 'ok' : s === 'changes_requested' ? 'bad' : ''}">${esc(s.replace('_', ' '))}</span>`
async function pullsTab(owner: string, name: string, repo: any, sub: string | undefined, params: URLSearchParams): Promise<Tab> {
  const R = `/api/repos/${owner}/${name}`, base = `/${esc(owner)}/${esc(name)}/pulls`
  if (sub === 'new') {
    if (!me) return { html: needSignIn }
    const branches = (repo.refs as any[]).map((r) => String(r.name).replace(/^refs\/heads\//, '')).filter((n) => !n.startsWith('refs/'))
    const opts = (sel: string) => branches.map((b) => `<option${b === sel ? ' selected' : ''}>${esc(b)}</option>`).join('')
    return { html: `<form class="card" id="nf"><h2>Open a pull request</h2><div class="row">${field('ph', 'Head (compare)', `<select id="ph">${opts(branches.find((b) => b !== repo.defaultBranch) ?? '')}</select>`)}<span aria-hidden="true">→</span>${field('pb', 'Base', `<select id="pb">${opts(repo.defaultBranch)}</select>`)}</div>
      ${field('pt', 'Title', '<input id="pt" required style="width:100%">')}${field('pd', 'Description', '<textarea id="pd" rows="6" style="width:100%"></textarea>')}
      <p><button id="pc">Create pull request</button> <span id="msg" role="alert" class="err"></span></p></form>`,
      wire: () => { $('nf').addEventListener('submit', (e) => e.preventDefault()); wireAction('pc', 'msg', async () => { const p = await post(`${R}/pulls`, { title: val('pt'), body: ($('pd') as HTMLTextAreaElement).value, head: val('ph'), base: val('pb') }); history.pushState({}, '', `/${owner}/${name}/pulls/${p.number}`) }) } }
  }
  if (sub && /^\d+$/.test(sub)) {
    const pt = ['conversation', 'commits', 'files'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'conversation'
    const [p, mg] = await Promise.all([api(`${R}/pulls/${sub}`), api(`${R}/pulls/${sub}/mergeable`)])
    const href = (t: string) => `${base}/${esc(sub)}${t === 'conversation' ? '' : '?tab=' + t}`
    const sub_ = ['conversation', 'commits', 'files'].map((t) => `<a class="${pt === t ? 'on' : ''}"${pt === t ? ' aria-current="page"' : ''} href="${href(t)}">${t === 'files' ? 'files changed' : t}</a>`).join('')
    let inner = '', wire: (() => void) | undefined
    if (pt === 'conversation') {
      const [cs, rv] = await Promise.all([api(`${R}/issues/${sub}/comments`), api(`${R}/pulls/${sub}/reviews`)])
      const items = [...cs.comments.map((c: any) => ({ at: c.createdAt, h: `<div class="card"><div class="muted"><b>${esc(c.author)}</b> commented · ${esc(ago(c.createdAt))}</div>${text(c.body)}</div>` })),
        ...rv.reviews.map((v: any) => ({ at: v.submittedAt, h: `<div class="card"><div class="muted"><b>${esc(v.author)}</b> ${reviewChip(v.state)} · ${esc(ago(v.submittedAt))}</div>${v.body ? text(v.body) : ''}${v.comments.map((m: any) => `<div class="muted mono">${esc(m.path)}:${esc(m.line)}</div>${text(m.body)}`).join('')}</div>` }))]
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      inner = `<div class="card">${text(p.body)}</div>${items.map((x) => x.h).join('')}
        ${me ? `<div class="card"><h2>Review or comment</h2><label class="sr" for="rb">Body</label><textarea id="rb" rows="4" style="width:100%"></textarea>
          <p class="row"><select id="re" aria-label="Review type"><option value="comment">comment</option><option value="approve">approve</option><option value="request_changes">request changes</option></select><button id="rs">Submit review</button><span id="msg" role="alert" class="err"></span></p></div>` : needSignIn}`
      wire = () => { if (me) wireAction('rs', 'msg', () => { const ev2 = ($('re') as HTMLSelectElement).value, b = ($('rb') as HTMLTextAreaElement).value.trim(); if (ev2 === 'comment' && !b) throw new Error('write a comment first'); return post(`${R}/pulls/${sub}/reviews`, { event: ev2, body: b }) }) }
    } else if (pt === 'commits') {
      const c = await api(`${R}/pulls/${sub}/commits`)
      inner = `<div class="card list">${c.commits.map((m: any) => `<div><b>${esc(m.subject)}</b><div class="muted">${esc(m.author)} · ${esc(ago(m.authoredAt))} · <code>${esc(String(m.oid).slice(2, 9))}</code></div></div>`).join('') || '<p class="muted">No commits.</p>'}</div>`
    } else {
      const [f, dres] = await Promise.all([api(`${R}/pulls/${sub}/files`), fetch(`${R}/pulls/${sub}/diff`)])
      const diff = dres.ok ? await dres.text() : ''
      inner = `<div class="card"><h2>${f.files.length} file(s) changed</h2><div class="list">${f.files.map((x: any) => `<div class="mono">${esc(x.status)} ${esc(x.path)}${x.oldPath ? ' ← ' + esc(x.oldPath) : ''} <span class="add-n">+${esc(x.additions)}</span> <span class="del-n">-${esc(x.deletions)}</span></div>`).join('')}</div></div>${dres.ok ? renderDiff(parseDiff(diff)) : `<div class="card err">Diff unavailable (${esc(dres.status)}).</div>`}`
    }
    const canMergeUi = me && p.state === 'open'
    const status = `<div class="card"><div class="row"><b>Merge status</b>${chipFor(p.state)}<span class="chip ${mg.mergeable === 'clean' ? 'ok' : mg.mergeable === 'conflict' ? 'bad' : 'warn'}">${esc(mg.mergeable)}</span>
      <span class="muted">${esc(p.head)} → ${esc(p.base)} · +${esc(p.additions)} -${esc(p.deletions)} in ${esc(p.changedFiles)} file(s)${p.fromSession ? ' · from a task session' : ''}</span></div>
      ${mg.blockers.length ? `<ul class="blockers">${mg.blockers.map((b: string) => `<li>${esc(b)}</li>`).join('')}</ul>` : p.state === 'open' ? '<p class="ok-t">No blockers.</p>' : ''}
      ${canMergeUi ? `<div class="row"><select id="mm" aria-label="Merge strategy"><option value="merge">merge commit</option><option value="squash">squash</option><option value="rebase">rebase</option></select><button id="mb"${mg.canMerge ? '' : ' class="ghost"'}>Merge pull request</button>
        <button id="mc" class="ghost">${'Close PR'}</button><span id="mmsg" role="alert" class="err"></span></div>` : ''}</div>`
    return { html: `<p><a href="${base}">← all pull requests</a></p><h2>${esc(p.title)} <span class="muted">#${esc(p.number)}</span></h2><p class="muted">${esc(p.author)} · ${esc(ago(p.createdAt))}</p>${status}<nav class="tabs" aria-label="Pull request">${sub_}</nav>${inner}`,
      wire: () => {
        wire?.()
        if (canMergeUi) {
          const b = $('mb') as HTMLButtonElement
          b.onclick = async () => {
            b.disabled = true; say('mmsg', '', false)
            try { await post(`${R}/pulls/${sub}/merge`, { method: ($('mm') as HTMLSelectElement).value }); render() } catch (e) {
              const er = e as ApiError, bl = er.body?.blockers
              say('mmsg', er.status === 409 ? `Cannot merge: ${Array.isArray(bl) && bl.length ? bl.join('; ') : er.message}` : er.status === 403 ? `Not allowed: ${er.message}` : er.message); b.disabled = false
            }
          }
          wireAction('mc', 'mmsg', () => patch(`${R}/pulls/${sub}`, { state: 'closed' }))
        }
      } }
  }
  const state = ['open', 'closed', 'merged', 'all'].includes(params.get('state') ?? '') ? params.get('state')! : 'open', page = Math.max(1, Number(params.get('page')) || 1)
  const qs = new URLSearchParams({ state, page: String(page), per_page: '30' })
  const l = await api(`${R}/pulls?${qs}`)
  const items: any[] = l.pulls ?? l.pullRequests ?? l.issues ?? []
  return { html: `<div class="row"><h2 class="grow">Pull requests</h2>${repo.canWrite ? `<a class="btn" href="${base}/new">New pull request</a>` : ''}</div>${stateFilter(base, state, ['open', 'closed', 'merged', 'all'], params.get('q') ?? '')}
    <div class="card list">${items.map((p) => `<div><a href="${base}/${esc(p.number)}"><b>${esc(p.title)}</b></a> ${chipFor(p.state)}${p.draft ? '<span class="chip">draft</span>' : ''}<div class="muted">#${esc(p.number)} ${esc(p.head)} → ${esc(p.base)} by ${esc(p.author)} · ${esc(ago(p.createdAt))}</div></div>`).join('') || '<p class="muted">No pull requests.</p>'}</div>${l.total != null ? pager(base, new URLSearchParams(qs), page, l.total, l.perPage ?? 30) : ''}`,
    wire: () => wireFilter(base) }
}

// ---------------------------------------------------------------- sessions: maintainer view
const statusChip = (s: string) => `<span class="chip ${s === 'active' ? 'ok' : s === 'ended' ? '' : 'bad'}">${esc(s)}</span>`
async function sessionsAdminTab(owner: string, name: string, repo: any): Promise<Tab> {
  const R = `/api/repos/${owner}/${name}`
  const { sessions } = await api(`${R}/sessions`)
  const form = `<form class="card" id="sf"><h2>Create a task-scoped session</h2><p class="muted">Gives one developer time-boxed, read-only access to the listed paths of <code>${esc(repo.defaultBranch)}</code>, tied to one issue.</p>
    <div class="row">${field('sn', 'Issue number', '<input id="sn" type="number" min="1" required style="width:8em">')}${field('sl', 'Developer login', '<input id="sl" required>')}
    ${field('sr', 'Role', '<select id="sr"><option>contractor</option><option>employee</option><option>maintainer</option></select>')}${field('st', 'TTL (minutes)', '<input id="st" type="number" min="1" max="1440" value="480" style="width:8em">')}</div>
    ${field('sp', 'Allowed paths (one per line, prefix without trailing slash, e.g. src/payments)', '<textarea id="sp" rows="4" style="width:100%" placeholder="src/payments"></textarea>')}
    <p><button id="sc">Create session</button> <span id="msg" role="alert" class="err"></span></p></form>`
  const list = `<div class="card"><h2>Sessions</h2><div class="list">${sessions.map((s: any) => `<div><div class="row"><b class="grow">@${esc(s.user)} on issue #${esc(s.issueNumber)}</b>${statusChip(s.status)}<span class="chip">${esc(s.role)}</span></div>
    <div class="muted">paths: <code>${esc((s.allowedPaths ?? []).join(', ') || '(all)')}</code> · expires ${esc(s.expiresAt)} · by ${esc(s.createdBy)}</div>
    <div class="row"><button class="ghost" data-audit="${esc(s.id)}">Audit log</button>${s.status === 'active' ? `<button class="ghost" data-revoke="${esc(s.id)}">Revoke</button>` : ''}</div></div>`).join('') || '<p class="muted">No sessions yet.</p>'}</div></div>
    <div class="card" id="audit" aria-live="polite"><h2>Audit log</h2><p class="muted">Select a session.</p></div>`
  return { html: form + list, wire: () => {
    $('sf').addEventListener('submit', (e) => e.preventDefault())
    wireAction('sc', 'msg', () => { const role = ($('sr') as HTMLSelectElement).value, paths = parsePaths(($('sp') as HTMLTextAreaElement).value)
      if (role !== 'maintainer' && !paths.length) throw new Error('at least one allowed path is required')
      return post(`${R}/sessions`, { issueNumber: Number(val('sn')), login: val('sl'), role, ttlMinutes: Number(val('st')) || 480, ...(paths.length ? { paths } : {}) }) })
    document.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) => { b.onclick = () => post(`/api/sessions/${encodeURIComponent(b.dataset.revoke!)}/revoke`, {}).then(render, (e) => alert(e.message)) })
    document.querySelectorAll<HTMLButtonElement>('[data-audit]').forEach((b) => { b.onclick = async () => {
      try { const { events } = await api(`/api/sessions/${encodeURIComponent(b.dataset.audit!)}/events`)
        $('audit').innerHTML = `<h2>Audit log</h2><div class="list">${events.map((e: any) => `<div class="mono"><span class="chip ${/denied|rejected/.test(e.kind) ? 'bad' : ''}">${esc(e.kind)}</span> ${esc(e.actor ?? '')} · ${esc(e.createdAt)} · ${esc(JSON.stringify(e.detail ?? {}).slice(0, 200))}</div>`).join('') || '<p class="muted">No events.</p>'}</div>`
      } catch (e) { $('audit').innerHTML = `<h2>Audit log</h2><p class="err">${esc((e as Error).message)}</p>` } } })
  } }
}

// ---------------------------------------------------------------- sessions: developer view
async function mySessions() {
  if (!me) { app.innerHTML = needSignIn; return }
  const { sessions } = await api('/api/sessions')
  app.innerHTML = `<h1>My sessions</h1><div class="card list">${sessions.map((s: any) => `<div><a href="/sessions/${esc(s.id)}"><b>${esc(s.owner)}/${esc(s.repo)} · issue #${esc(s.issueNumber)}</b></a> ${statusChip(s.status)} <span class="chip">${esc(s.role)}</span>
    <div class="muted">scope: <code>${esc((s.allowedPaths ?? []).join(', ') || '(all)')}</code> · ${s.status === 'active' ? 'expires ' + esc(s.expiresAt) : esc(s.endReason ?? s.status)}</div></div>`).join('') || '<p class="muted">No sessions assigned to you.</p>'}</div>`
}

const callHtml = (c: any) => {
  const refused = !!c.refused
  const badge = refused ? '<span class="chip bad">refused: no model call made</span>' : c.sealed === false ? '<span class="chip warn">not sealed</span>' : '<span class="chip ok">sealed on 0G</span>'
  return `<div class="call"><div class="row"><b>${esc(c.kind ?? 'call')}</b>${badge}<span class="muted">${esc(c.createdAt ? new Date(c.createdAt).toLocaleString() : '')} · ${esc(c.model ?? '')}</span></div>
    ${c.question ? `<div class="muted">Q: ${esc(c.question)}</div>` : ''}${c.answer ? text(c.answer) : '<div class="muted">(no answer)</div>'}
    <div class="muted mono">0G request id: ${c.requestId ? esc(c.requestId) : 'none'}</div></div>`
}

async function workspacePage(id: string) {
  if (!me) { app.innerHTML = needSignIn; return }
  const mine = (await api('/api/sessions')).sessions.find((s: any) => s.id === id)
  if (!mine) { app.innerHTML = '<div class="card err" role="alert">Session not found among your sessions. Maintainers manage sessions in the repository &gt; sessions tab.</div>'; return }
  const S = `/api/sessions/${encodeURIComponent(id)}`, repoApi = `/api/repos/${mine.owner}/${mine.repo}`
  const scoped = (p: string) => sapi(id, `${repoApi}${p}`)
  const scopeTxt = mine.role === 'maintainer' ? 'whole repository' : (mine.allowedPaths ?? []).join(', ')
  app.innerHTML = `<div class="banner ${mine.status === 'active' ? '' : 'inactive'}" role="status"><b>Scoped workspace</b> · ${esc(mine.owner)}/${esc(mine.repo)} · role <span class="chip">${esc(mine.role)}</span>
    scope <code>${esc(scopeTxt)}</code> · ${statusChip(mine.status)} · time left <b id="cd" class="mono">${esc(countdown(mine.expiresAt))}</b></div>
    <div class="grid2"><div>
      <div class="card"><h2>Issue #${esc(mine.issueNumber)}</h2><div id="issue" class="muted">Loading…</div></div>
      <div class="card"><h2>Files</h2><div id="crumb" class="crumbs"></div><div id="files" aria-live="polite"></div>
        <form class="row" id="tryf"><label class="sr" for="tryp">Open a path</label><input id="tryp" class="grow" placeholder="open any path, e.g. src/other/file.ts"><button class="ghost">Open</button></form></div>
      <div class="card"><h2>Export</h2><p class="muted">Download a tar of the in-scope files only (no history).</p><button id="ex">Export scoped files</button> <span id="exm" role="alert" class="err"></span></div>
    </div><div>
      <div class="card"><h2>AI assistant</h2><p class="muted">Runs on 0G Private Computer (sealed). Sees only your issue and in-scope files.</p>
        <div class="row"><button id="sum">Summarize issue</button></div>
        <form class="row" id="askf"><label class="sr" for="q">Question</label><input id="q" class="grow" maxlength="2000" placeholder="Ask about the task or in-scope code"><button>Ask</button></form>
        <p id="am" role="alert" class="err"></p><div id="calls" class="list" aria-live="polite"></div></div>
      <div class="card"><h2>Propose a change</h2><p class="muted">Paste a unified diff (<code>git diff</code> output). Every touched path must be in scope.</p>
        <label class="sr" for="patch">Patch</label><textarea id="patch" rows="8" style="width:100%" class="mono" placeholder="diff --git a/…"></textarea>
        <p class="row"><button id="prop">Submit proposal</button></p><div id="pm" role="alert"></div></div>
    </div></div>`
  const cd = $('cd'); tick = setInterval(() => { cd.textContent = countdown(mine.expiresAt) }, 1000)

  sapi(id, `${S}/issue`).then((i) => { $('issue').className = ''; $('issue').innerHTML = `<b>${esc(i.title)}</b> ${chipFor(i.state)}${text(i.body)}` }, (e) => { $('issue').innerHTML = `<span class="err">${esc(e.message)}</span>` })

  const denied = (e: unknown, what: string) => { const er = e as ApiError; return `<div class="denied" role="alert"><b>${er.status === 403 ? 'Access denied' : 'Error'}</b>: ${esc(what)}${er.status === 403 ? ' is outside your session scope or the session is no longer active.' : ''} <span class="muted">(${esc(er.message)})</span></div>` }
  const crumb = (p: string) => { $('crumb').innerHTML = `<button class="link" data-dir="">root</button>${p ? ' / ' + esc(p) : ''}`; wireNav() }
  async function loadDir(path: string) {
    crumb(path)
    try {
      const t = await scoped(`/tree?path=${encodeURIComponent(path)}`)
      const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      $('files').innerHTML = `<div class="list">${path ? `<div><button class="link" data-dir="${esc(up)}">..</button></div>` : ''}${t.entries.map((e: any) => e.restricted ? `<div class="muted">🔒 ${esc(e.name)} <span class="chip">restricted</span></div>`
        : `<div>${e.type === 'tree' ? '📁' : '📄'} <button class="link" data-${e.type === 'tree' ? 'dir' : 'file'}="${esc(e.path)}">${esc(e.name)}</button></div>`).join('') || '<p class="muted">Nothing in scope here.</p>'}</div>`
    } catch (e) { $('files').innerHTML = denied(e, path ? `directory ${path}` : 'the repository root') }
    wireNav()
  }
  async function loadFile(path: string) {
    crumb(path)
    try {
      const b = await scoped(`/blob?path=${encodeURIComponent(path)}`)
      $('files').innerHTML = `<pre>${b.binary ? '(binary file)' : b.truncated ? '(file too large to display)' : esc(b.content)}</pre>`
    } catch (e) { $('files').innerHTML = denied(e, `file ${path}`) }
    wireNav()
  }
  function wireNav() {
    document.querySelectorAll<HTMLButtonElement>('#crumb [data-dir],#files [data-dir]').forEach((b) => { b.onclick = () => loadDir(b.dataset.dir!) })
    document.querySelectorAll<HTMLButtonElement>('#files [data-file]').forEach((b) => { b.onclick = () => loadFile(b.dataset.file!) })
  }
  $('tryf').addEventListener('submit', (e) => { e.preventDefault(); const p = val('tryp'); if (p) loadFile(p) })
  loadDir('')

  $('ex').onclick = async () => {
    say('exm', 'Preparing…', false)
    try {
      const res = await fetch(`${S}/export`, { headers: { 'x-dheet-session': id } })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a')
      a.href = url; a.download = `${mine.repo}-issue-${mine.issueNumber}-scoped.tar`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); say('exm', 'Downloaded.', false)
    } catch (e) { say('exm', (e as Error).message) }
  }

  const calls: any[] = []
  const paint = () => { $('calls').innerHTML = calls.map(callHtml).join('') || '<p class="muted">No assistant calls yet.</p>' }
  api(`${S}/assistant/calls`).then((r) => { calls.push(...(r.calls ?? [])); paint() }, (e) => { $('calls').innerHTML = `<p class="muted">${esc(e.message)}</p>` })
  const ask = async (kind: string, path: string, body: unknown, q?: string) => {
    say('am', 'Waiting for 0G…', false)
    try { const r = await post(`${S}/assistant/${path}`, body); say('am', '', false); calls.unshift({ kind, question: q, answer: r.answer ?? r.reason, refused: r.refused, model: r.model, requestId: r.requestId, sealed: r.sealed, createdAt: r.createdAt }); paint() }
    catch (e) { const er = e as ApiError; say('am', er.status === 429 ? `Rate limit reached (30 calls/hour): ${er.message}` : er.status === 410 ? 'Session expired.' : er.status === 502 ? `0G is unavailable, no answer was produced: ${er.message}` : er.message) }
  }
  $('sum').onclick = () => ask('summarize', 'summarize', {})
  $('askf').addEventListener('submit', (e) => { e.preventDefault(); const q = val('q'); if (q) ask('ask', 'ask', { question: q }, q) })

  ;($('prop') as HTMLButtonElement).onclick = async () => {
    const pm = $('pm'); pm.className = 'muted'; pm.textContent = 'Submitting…'
    try {
      const r = await sapi(id, `${S}/proposals`, { method: 'POST', body: JSON.stringify({ patch: ($('patch') as HTMLTextAreaElement).value }) })
      const n = r.pullRequest?.number ?? r.pullRequest
      pm.className = 'ok-t'; pm.innerHTML = `Proposal created on branch <code>${esc(r.branch)}</code>. Pull request <a href="/${esc(mine.owner)}/${esc(mine.repo)}/pulls/${esc(n)}">#${esc(n)}</a>.`
    } catch (e) {
      const er = e as ApiError; pm.className = 'err'
      pm.innerHTML = `${er.status === 422 ? 'Rejected' : 'Error'}: ${esc(er.message)}${Array.isArray(er.body?.paths) ? `<ul>${er.body.paths.map((p: string) => `<li><code>${esc(p)}</code></li>`).join('')}</ul>` : ''}`
    }
  }
}

// ---------------------------------------------------------------- deployments + verify
async function deploymentsPage() {
  const r = await api('/api/deployments').catch((e: Error) => ({ error: e.message, deployments: [] as any[], source: '' }))
  const items: any[] = r.deployments ?? []
  const badge = (d: any) => [d.publishTx || d.bundleHash ? '<span class="chip ok">published</span>' : '', d.attested ? (d.ok ? '<span class="chip ok">attested OK</span>' : '<span class="chip bad">attested MISMATCH</span>') : '<span class="chip warn">pending attestation</span>'].join('')
  const tx = (label: string, h: string | null) => (isTxHash(h) ? `<a href="${esc(etherscanTx(h))}" target="_blank" rel="noopener">${esc(label)} ${esc(short(h))}</a>` : '')
  app.innerHTML = `<h1>Deployments</h1>
    <section class="card verify" aria-labelledby="vh"><h2 id="vh">Verify this site</h2><p>Prove the frontend you are running matches the release published on-chain. Everything below runs in your browser: it hashes the files it was served, recomputes the bundle hash, and reads the DeployRegistry on Sepolia directly over JSON-RPC.</p>
      <p><button id="vb">Run verification</button></p><div id="vres" aria-live="polite"></div></section>
    <div class="card"><h2>Releases</h2><p class="muted">Data source: ${r.source === 'arkiv' ? '<span class="chip ok">Arkiv</span>' : r.source ? '<span class="chip warn">Postgres fallback (Arkiv unreachable)</span>' : '<span class="chip bad">unavailable</span>'}${r.error ? ` <span class="err">${esc(r.error)}</span>` : ''}</p>
      <div class="list">${items.map((d) => `<div><div class="row"><b>Release #${esc(d.releaseId)}</b>${badge(d)}<span class="muted">${esc(d.publishedAt ?? '')}</span></div>
        <div class="muted mono">commit ${esc(d.commit)}<br>bundleHash ${esc(d.bundleHash)}</div>
        <div>${typeof d.url === 'string' && /^https:\/\//.test(d.url) ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>` : esc(d.url ?? '')} ${tx('publish tx', d.publishTx)} ${tx('attest tx', d.attestTx)} ${d.arkivEntity ? `<span class="chip mono" title="Arkiv entity">Arkiv ${esc(short(d.arkivEntity))}</span>` : ''}</div></div>`).join('') || '<p class="muted">No releases yet.</p>'}</div></div>`
  $('vb').onclick = () => runVerify()
  runVerify()
}

async function runVerify() {
  const out = $('vres'), btn = $('vb') as HTMLButtonElement
  btn.disabled = true; out.innerHTML = '<p class="muted">Verifying…</p>'
  try {
    const build: BuildJson = await (await fetch('/build.json', { cache: 'no-store' })).json()
    const names = Object.keys(build.files ?? {}).sort(), actual: Record<string, string> = {}
    for (const n of names) {
      const res = await fetch(`/${encodeURIComponent(n)}`, { cache: 'no-store' })
      actual[n] = res.ok ? '0x' + (await sha256Hex(new Uint8Array(await res.arrayBuffer()))) : 'http-' + res.status
    }
    const local = await bundleHashOf(actual)
    let chain: OnchainRelease | null = null, att: OnchainAttestation | null = null, chainErr: string | undefined
    try {
      chain = decodeLatestRelease(await ethCall(REGISTRY, SEL_LATEST_RELEASE))
      att = decodeLatestAttestation(await ethCall(ATTESTATIONS, SEL_LATEST_ATTESTATION))
    } catch (e) { chainErr = `could not read chain: ${(e as Error).message}` }
    const apiLatest = await api('/api/deployments/latest').then((x) => x.deployment as { bundleHash: string | null }, () => null)
    const checks: Check[] = evaluate({ build, actual, local, chain, ...(chainErr ? { chainErr } : {}), api: apiLatest, att })
    const hard = checks.slice(0, 3), pass = hard.every((c) => c.status === 'pass')
    out.innerHTML = `<p class="verdict ${pass ? 'ok-t' : 'err'}"><b>${pass ? 'PASS: this site matches the published on-chain release' : 'FAIL: this site does not match the on-chain release'}</b></p>
      <ul class="checks">${checks.map((c) => `<li><span class="chip ${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : 'warn'}">${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'INFO'}</span> ${esc(c.label)}<div class="muted mono">${esc(c.detail)}</div></li>`).join('')}</ul>
      <p class="muted mono">local bundleHash ${esc(local)}${chain ? `<br>release #${esc(chain.id)} commit ${esc(chain.commit)}<br>url ${esc(chain.url)}` : ''}<br>registry <a href="https://sepolia.etherscan.io/address/${REGISTRY}" target="_blank" rel="noopener">${REGISTRY}</a></p>`
  } catch (e) { out.innerHTML = `<p class="err" role="alert">Verification failed to run: ${esc((e as Error).message)}</p>` }
  btn.disabled = false
}

let tick: ReturnType<typeof setInterval> | undefined
async function render() {
  if (tick) { clearInterval(tick); tick = undefined }
  renderNav()
  const url = new URL(location.href), parts = url.pathname.split('/').filter(Boolean)
  try {
    if (parts.length === 0) await home()
    else if (parts[0] === 'new') newRepo()
    else if (parts[0] === 'settings') await settings()
    else if (parts[0] === 'orgs' && parts[1] === 'new') newOrg()
    else if (parts[0] === 'orgs' && parts[1]) await orgPage(parts[1])
    else if (parts[0] === 'deployments') await deploymentsPage()
    else if (parts[0] === 'sessions' && parts[1]) await workspacePage(parts[1])
    else if (parts[0] === 'sessions') await mySessions()
    else if (parts.length >= 2) await repoPage(parts[0]!, parts[1]!, parts[2] ?? 'code', url.searchParams, parts[3])
  } catch (e) { app.innerHTML = `<div class="card err">${esc((e as Error).message)}</div>` }
}
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a')
  if (a && a.origin === location.origin && !a.target && a.pathname !== '#') { e.preventDefault(); history.pushState({}, '', a.href); render() }
})
window.addEventListener('popstate', render)
api<{ user: typeof me }>('/api/me').then((r) => { me = r.user }).catch(() => {}).finally(render)
