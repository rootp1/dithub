import { esc } from './helpers.ts'

export function recoveryPanel(status: any, canWrite: boolean, endpoint: string) {
  const latest = status.latest
  const label = status.state === 'private' ? 'Public backup unavailable for private repositories' : status.state === 'disabled' ? 'Recovery backups are not enabled'
    : status.state === 'failed' ? 'Latest backup needs attention' : status.state === 'pending' ? 'Backing up repository…'
    : status.state === 'ready' ? 'Latest branches and tags backed up' : 'No recovery snapshot yet'
  const progress: Record<string, string> = { queued: 'Waiting to start', preparing: 'Preparing repository', uploading: 'Uploading snapshot', verifying: 'Checking downloaded copy', publishing: 'Recording recovery instructions', retrying: 'Retrying automatically' }
  const checked = latest?.postageCheckedAt ? new Date(latest.postageCheckedAt).getTime() : 0
  const fundingWarning = latest && (latest.postageWarning || Date.now() - checked > 2 * 3600_000 || !latest.postageExpiresEstimate || new Date(latest.postageExpiresEstimate).getTime() < Date.now() + 7 * 86400_000)
  return `<section class="card" aria-label="Repository recovery"><h2>Repository recovery</h2>
    <p role="status"><span class="chip ${status.state === 'ready' ? 'ok' : 'warn'}">${esc(label)}</span></p>
    ${status.job && status.state === 'pending' ? `<p class="muted">${esc(progress[status.job.stage] ?? 'Waiting for backup')}.</p>` : ''}
    ${latest ? `<p>Recoverable snapshot: <code>${esc(latest.commit?.slice(0, 12))}</code> · ${(latest.size / 1024 ** 2).toFixed(1)} MiB<br><span class="muted">Download verified ${esc(new Date(latest.verifiedAt).toLocaleString())}. ${status.coversLatest ? '' : 'Newer changes are not covered by this snapshot.'}</span></p>
      ${fundingWarning ? '<p class="chip warn">Storage funding needs attention or a recent check.</p>' : `<p class="muted">Storage funding estimate: ${esc(new Date(latest.postageExpiresEstimate).toLocaleDateString())}. This date can change.</p>`}
      <p><a href="${esc(endpoint)}/instructions" download>Download recovery instructions</a></p><p class="muted">Run the command in the downloaded file to restore without this server. Git LFS objects are not included.</p>` : ''}
    ${canWrite && status.enabled && status.state !== 'pending' ? '<button id="recovery-retry">Back up now</button><p id="recovery-error" role="alert"></p>' : ''}
  </section>`
}
