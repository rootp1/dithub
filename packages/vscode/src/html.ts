// Pure HTML builders for the webviews (no `vscode` import, unit-tested). Strict CSP, nonce'd script/style, everything escaped; the chat script renders with textContent only.
import { escapeHtml, type Task } from './core.ts'

export const MAX_QUESTION = 2000

export function csp(n: string): string { return `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'` }

const STYLE = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:12px 16px}
h1{font-size:1.15em;margin:0 0 4px}.mut{color:var(--vscode-descriptionForeground)}
.log{display:flex;flex-direction:column;gap:10px;margin:12px 0 88px}
.msg{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px}
.q{background:var(--vscode-textBlockQuote-background)}.who{font-size:.85em;color:var(--vscode-descriptionForeground);margin-bottom:4px}
.text{white-space:pre-wrap;word-wrap:break-word;font-family:var(--vscode-editor-font-family)}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;font-size:.85em;color:var(--vscode-descriptionForeground)}
.badge{border-radius:10px;padding:0 8px;border:1px solid var(--vscode-panel-border)}
.sealed{background:var(--vscode-testing-iconPassed);color:var(--vscode-editor-background);border-color:transparent}
.refused{border-color:var(--vscode-editorWarning-foreground)}.refused .label{color:var(--vscode-editorWarning-foreground);font-weight:600}
.error{border-color:var(--vscode-errorForeground);color:var(--vscode-errorForeground)}
form{position:fixed;left:0;right:0;bottom:0;padding:10px 16px;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-panel-border);display:flex;gap:8px}
textarea{flex:1;resize:none;height:44px;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:6px}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 12px;cursor:pointer}
button.sec{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button:disabled{opacity:.5;cursor:default}
`

// Runs inside the webview. Plain DOM + textContent only.
const SCRIPT = `
(function(){
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log'), form = document.getElementById('f'), q = document.getElementById('q'), send = document.getElementById('send'), sum = document.getElementById('sum'), status = document.getElementById('status');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };
  function meta(m) {
    const row = el('div', 'meta');
    if (m.refused) { row.appendChild(el('span', 'badge', 'refused: no model call was made')); if (m.reason) row.appendChild(el('span', '', 'reason: ' + m.reason)); return row; }
    if (m.sealed) row.appendChild(el('span', 'badge sealed', 'sealed on 0G'));
    else row.appendChild(el('span', 'badge', 'not sealed'));
    if (m.model) row.appendChild(el('span', '', 'model: ' + m.model));
    row.appendChild(el('span', '', '0G request: ' + (m.requestId || 'n/a')));
    if (m.teeVerified === true) row.appendChild(el('span', 'badge', 'TEE verified'));
    if (m.filesUsed && m.filesUsed.length) row.appendChild(el('span', '', 'files: ' + m.filesUsed.join(', ')));
    if (m.createdAt) row.appendChild(el('span', '', new Date(m.createdAt).toLocaleString()));
    return row;
  }
  function addQuestion(text, kind) { const d = el('div', 'msg q'); d.appendChild(el('div', 'who', kind === 'summarize' ? 'You asked for a summary' : 'You')); d.appendChild(el('div', 'text', text)); log.appendChild(d); }
  function addAnswer(m) {
    const d = el('div', 'msg' + (m.refused ? ' refused' : '') + (m.failed ? ' error' : ''));
    const who = el('div', 'who'); if (m.refused) who.appendChild(el('span', 'label', 'REFUSED ')); who.appendChild(document.createTextNode(m.refused ? '(the question was outside the task scope)' : m.failed ? '0G call failed' : '0G assistant'));
    d.appendChild(who); d.appendChild(el('div', 'text', m.answer == null ? '(no answer)' : m.answer)); if (!m.failed) d.appendChild(meta(m)); log.appendChild(d); window.scrollTo(0, document.body.scrollHeight);
  }
  function addError(text) { const d = el('div', 'msg error'); d.appendChild(el('div', 'text', text)); log.appendChild(d); window.scrollTo(0, document.body.scrollHeight); }
  function busy(on) { send.disabled = on; sum.disabled = on; q.disabled = on; status.textContent = on ? 'Waiting for 0G…' : ''; }
  window.addEventListener('message', (ev) => {
    const m = ev.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'history' && Array.isArray(m.calls)) { log.textContent = ''; if (!m.calls.length) log.appendChild(el('div', 'mut', 'No questions yet. Ask about the task, or press "Summarize task".')); for (const c of m.calls) { if (c.kind === 'ask' && c.question) addQuestion(c.question, 'ask'); else addQuestion('Summarize the task', 'summarize'); addAnswer(c); } window.scrollTo(0, document.body.scrollHeight); }
    else if (m.type === 'question') addQuestion(String(m.text || ''), m.kind);
    else if (m.type === 'answer' && m.data) addAnswer(m.data);
    else if (m.type === 'error') addError(String(m.text || 'error'));
    else if (m.type === 'busy') busy(!!m.on);
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); const text = q.value.trim(); if (!text) return; vscode.postMessage({ type: 'ask', question: text.slice(0, ${MAX_QUESTION}) }); q.value = ''; });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  sum.addEventListener('click', () => vscode.postMessage({ type: 'summarize' }));
  vscode.postMessage({ type: 'ready' });
})();
`

export function chatHtml(task: Pick<Task, 'repo' | 'issue' | 'allowedPaths'>, n: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(n)}">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Ask 0G</title><style nonce="${n}">${STYLE}</style></head><body>
<h1>Ask 0G about #${escapeHtml(task.issue.number)} ${escapeHtml(task.issue.title)}</h1>
<div class="mut">${escapeHtml(task.repo.owner)}/${escapeHtml(task.repo.name)} · answers use only the issue and your in-scope files (${escapeHtml(task.allowedPaths.join(', '))}) and run sealed on 0G Private Computer.</div>
<div class="mut" id="status" aria-live="polite"></div>
<div class="log" id="log"></div>
<form id="f"><textarea id="q" maxlength="${MAX_QUESTION}" placeholder="Ask about this task… (Enter to send, Shift+Enter for a new line)" aria-label="Question"></textarea><button id="send" type="submit">Ask</button><button id="sum" class="sec" type="button">Summarize task</button></form>
<script nonce="${n}">${SCRIPT}</script></body></html>`
}

export function taskHtml(task: Pick<Task, 'repo' | 'issue' | 'allowedPaths' | 'role' | 'expiresAt' | 'ref'>, issue: { number: number; title: string; body: string | null; state: string }, n: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Task</title><style nonce="${n}">${STYLE} .paths{margin:6px 0 0 18px;padding:0}.body{margin-top:14px;border-top:1px solid var(--vscode-panel-border);padding-top:12px}</style></head><body>
<h1>#${escapeHtml(issue.number)} ${escapeHtml(issue.title)}</h1>
<div class="mut">${escapeHtml(task.repo.owner)}/${escapeHtml(task.repo.name)} @ ${escapeHtml(task.ref)} · issue ${escapeHtml(issue.state)} · role ${escapeHtml(task.role)} · access until ${escapeHtml(new Date(task.expiresAt).toLocaleString())}</div>
<div style="margin-top:10px">You can read and change only:</div><ul class="paths">${task.allowedPaths.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join('')}</ul>
<div class="body text">${escapeHtml(issue.body?.trim() ? issue.body : '(no description)')}</div>
</body></html>`
}

export type FromWebview = { type: 'ready' } | { type: 'summarize' } | { type: 'ask'; question: string }
export function parseMsg(m: unknown): FromWebview | null {
  if (!m || typeof m !== 'object') return null
  const x = m as Record<string, unknown>
  if (x.type === 'ready' || x.type === 'summarize') return { type: x.type }
  if (x.type === 'ask' && typeof x.question === 'string' && x.question.trim() && x.question.length <= MAX_QUESTION) return { type: 'ask', question: x.question.trim() }
  return null
}
