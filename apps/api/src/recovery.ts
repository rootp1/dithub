import { privateKeyToAccount } from 'viem/accounts'
import { DEFAULT_RECOVERY_WRITER } from '../../../packages/sdk/src/snapshot-arkiv.ts'
import { sql, toHex } from './db.ts'
import type { RepoRow } from './perm.ts'

export const recoveryEnabled = () => Boolean(process.env.SWARM_BEE_URL && process.env.SWARM_BATCH_ID && process.env.SWARM_READ_URL)
export function recoveryWriter() {
  if (process.env.DHEET_RECOVERY_WRITER) return process.env.DHEET_RECOVERY_WRITER
  if (process.env.DHEET_PRIVATE_KEY) return privateKeyToAccount(process.env.DHEET_PRIVATE_KEY as `0x${string}`).address
  return DEFAULT_RECOVERY_WRITER
}

export function refsCovered(current: Array<{ name: string; oid: string }>, saved: Array<{ name: string; oid: string }>) {
  const relevant = current.filter((ref) => /^refs\/(heads|tags)\//.test(ref.name))
  return relevant.length > 0 && relevant.length === saved.length && relevant.every((ref) => saved.some((other) => other.name === ref.name && other.oid === ref.oid.replace(/^0x/, '')))
}

export async function recoveryStatus(repo: RepoRow) {
  if (repo.visibility !== 'public') return { enabled: false, state: 'private', latest: null, job: null, coversLatest: false }
  const [latest] = await sql`SELECT s.*, a.expires_at_block AS renewed_expires_at_block FROM recovery_snapshots s
    LEFT JOIN arkiv_entities a ON a.entity_key=s.entity_key WHERE s.repo_id=${repo.id} AND s.status='ready' ORDER BY s.id DESC LIMIT 1`
  const [job] = await sql`SELECT id,status,stage,attempts FROM recovery_snapshots WHERE repo_id=${repo.id} AND status IN ('pending','processing','failed') ORDER BY id DESC LIMIT 1`
  const refs = await sql`SELECT name,encode(oid,'hex') AS oid FROM git_refs WHERE repo_id=${repo.id}`
  const coversLatest = latest ? refsCovered(refs as Array<{ name: string; oid: string }>, latest.manifest.refs) : false
  const enabled = recoveryEnabled()
  return { enabled, state: coversLatest ? 'ready' : job?.status === 'failed' ? 'failed' : enabled ? job ? 'pending' : 'not_backed_up' : 'disabled', coversLatest,
    job: job ? { status: job.status, stage: job.stage, attempts: Number(job.attempts) } : null,
    latest: latest ? { manifestHash: latest.pointer.hash, manifestReference: latest.pointer.reference, manifestSize: latest.pointer.size,
      headRef: latest.manifest.headRef, commit: latest.manifest.refs.find((ref: { name: string }) => ref.name === latest.manifest.headRef)?.oid,
      refs: latest.manifest.refs, size: latest.manifest.bundle.size, verifiedAt: latest.verified_at,
      postageCheckedAt: latest.postage_checked_at, postageExpiresEstimate: latest.postage_expires_estimate, postageWarning: latest.postage_error,
      arkivEntity: toHex(latest.entity_key), arkivExpiresAtBlock: String(latest.renewed_expires_at_block ?? latest.expires_at_block ?? ''),
    } : null,
  }
}

export async function queueRecovery(repo: RepoRow) {
  const [push] = await sql`SELECT id FROM pushes WHERE repo_id=${repo.id} ORDER BY id DESC LIMIT 1`
  if (!push) return false
  // A manual backup is a fresh job. Keep the previous ready snapshot available during upload.
  await sql`INSERT INTO recovery_snapshots (repo_id,push_id) VALUES (${repo.id},${push.id}) ON CONFLICT DO NOTHING`
  return true
}
