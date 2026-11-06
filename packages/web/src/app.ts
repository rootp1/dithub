interface RepoRow { repo_id: string; name: string; sequence: number; manifest_hash: string | null; object_root: string | null; object_count: number; refs_json: string; updated_at: number }
interface RecordRow { id: string; sequence: number; kind: string; author: string; created_at: number; body_json: string }

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const short = (value: string | null) => value ? `${value.slice(0, 10)}…${value.slice(-8)}` : 'not published'
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char] ?? char)

async function showRepo(identifier: string): Promise<void> {
  const response = await fetch(`/api/repos/${encodeURIComponent(identifier)}`)
  if (!response.ok) throw new Error('Repository could not be loaded')
  const { repo, records } = await response.json() as { repo: RepoRow; records: RecordRow[] }
  const refs = JSON.parse(repo.refs_json) as Record<string, string>
  const detail = byId<HTMLElement>('detail')
  detail.hidden = false
  detail.innerHTML = `<div class="section-title"><h2>${escapeHtml(repo.name)}</h2><button id="close">Close</button></div>
    <div class="facts"><div><label>Repository ID</label><code>${repo.repo_id}</code></div><div><label>Manifest</label><code>${repo.manifest_hash ?? 'none'}</code></div><div><label>Object root</label><code>${repo.object_root ?? 'none'}</code></div></div>
    <h3>Refs</h3><div class="records">${Object.entries(refs).map(([name, oid]) => `<article><b>${escapeHtml(name)}</b><code>${oid}</code></article>`).join('') || '<p>No refs</p>'}</div>
    <h3>Signed activity</h3><div class="records">${records.map((record) => `<article><span class="tag">${escapeHtml(record.kind)}</span><b>#${record.sequence}</b><code>${short(record.author)}</code><p>${escapeHtml(record.body_json)}</p></article>`).join('') || '<p>No collaboration records yet.</p>'}</div>`
  byId<HTMLButtonElement>('close').onclick = () => { detail.hidden = true }
  detail.scrollIntoView({ behavior: 'smooth' })
}

async function load(): Promise<void> {
  const response = await fetch('/api/repos')
  if (!response.ok) throw new Error('Indexer unavailable')
  const repos = await response.json() as RepoRow[]
  byId('status').textContent = 'index verified online'
  byId('count').textContent = `${repos.length} indexed`
  byId('repos').innerHTML = repos.map((repo) => `<button class="repo" data-id="${escapeHtml(repo.repo_id)}"><span class="seq">SEQ ${repo.sequence}</span><h3>${escapeHtml(repo.name)}</h3><p>${repo.object_count} objects · ${Object.keys(JSON.parse(repo.refs_json)).length} refs</p><code>${short(repo.manifest_hash)}</code><span class="open">Inspect →</span></button>`).join('') || '<p class="empty">No repositories indexed yet. Publish with the Dithub CLI, then restart the indexer.</p>'
  document.querySelectorAll<HTMLButtonElement>('.repo').forEach((button) => { button.onclick = () => void showRepo(button.dataset.id ?? '') })
}

load().catch((error: unknown) => {
  byId('status').textContent = 'index offline'
  byId('repos').innerHTML = `<p class="empty">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`
})
