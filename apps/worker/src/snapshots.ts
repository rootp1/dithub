import type { SQL } from 'bun'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SwarmStore, publishSnapshot, publishSnapshotPointer, findSnapshotPointer,
  type SnapshotManifest, type SnapshotPointer, type createArkivConnection,
} from '../../../packages/sdk/src/index.ts'
import { withArkivLock } from './arkiv-lock.ts'

type Connection = ReturnType<typeof createArkivConnection>
const hex = (value: string) => Buffer.from(value.replace(/^0x/, ''), 'hex')

export function createSnapshotWorker(args: { sql: SQL; arkiv: Connection; reposDir: string; workDir: string }) {
  const { sql, arkiv } = args
  const url = process.env.SWARM_BEE_URL, batchId = process.env.SWARM_BATCH_ID
  const readUrl = process.env.SWARM_READ_URL
  if (!url || !batchId || !readUrl) { console.log('Swarm recovery disabled: set SWARM_BEE_URL, SWARM_BATCH_ID and SWARM_READ_URL'); return }
  const swarm = new SwarmStore({ url, batchId, readUrl, maxBytes: Number(process.env.SWARM_MAX_BYTES ?? 10 * 1024 ** 3) })

  const tick = async () => {
    const token = crypto.randomUUID()
    const [job] = await sql`UPDATE recovery_snapshots SET status='processing', lease_token=${token}, leased_until=now()+interval '5 minutes',
        attempts=attempts+1, updated_at=now()
      WHERE id=(SELECT candidate.id FROM recovery_snapshots candidate WHERE ((candidate.status='pending' AND candidate.next_attempt_at<=now())
        OR (candidate.status='processing' AND candidate.leased_until<now()))
        AND NOT EXISTS (SELECT 1 FROM recovery_snapshots active WHERE active.repo_id=candidate.repo_id AND active.id<>candidate.id AND active.status='processing')
        ORDER BY candidate.id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`
    if (!job) return false
    let dir: string | undefined
    const heartbeat = setInterval(() => { void sql`UPDATE recovery_snapshots SET leased_until=now()+interval '5 minutes' WHERE id=${job.id} AND lease_token=${token}`.catch(console.error) }, 60_000)
    try {
      const [repo] = await sql`SELECT r.*, coalesce(u.login,o.login)||'/'||r.name AS full_name FROM repos r
        LEFT JOIN users u ON r.owner_kind='user' AND u.id=r.owner_id LEFT JOIN orgs o ON r.owner_kind='org' AND o.id=r.owner_id WHERE r.id=${job.repo_id}`
      if (!repo || repo.deleted_at || repo.visibility !== 'public') {
        await sql`UPDATE recovery_snapshots SET status='skipped', stage='not_public', lease_token=NULL, leased_until=NULL WHERE id=${job.id} AND lease_token=${token}`
        return true
      }
      const repoId = `0x${Buffer.from(repo.dheet_repo_id).toString('hex')}` as `0x${string}`
      const [watermark] = await sql`SELECT max(id) AS id FROM pushes WHERE repo_id=${repo.id}`
      const [hasBranch] = await sql`SELECT 1 FROM git_refs WHERE repo_id=${repo.id} AND name LIKE 'refs/heads/%' LIMIT 1`
      if (!hasBranch) {
        await sql`UPDATE recovery_snapshots SET status='skipped',stage='empty',lease_token=NULL,leased_until=NULL WHERE id=${job.id} AND lease_token=${token}`
        return true
      }
      const jobSwarm = job.batch_id ? new SwarmStore({ url, batchId: job.batch_id, readUrl }) : swarm
      const postage = await jobSwarm.batchStatus()
      await mkdir(join(args.workDir, 'snapshots'), { recursive: true })
      dir = await mkdtemp(join(args.workDir, 'snapshots', 'job-'))
      let manifest = job.manifest as SnapshotManifest | null, pointer = job.pointer as SnapshotPointer | null
      if (!manifest || !pointer) {
        const result = await publishSnapshot({
          swarm, repoPath: join(args.reposDir, `${repoId.slice(2)}.git`), repoId, name: String(repo.full_name), sequence: Number(job.id),
          defaultBranch: repo.default_branch, dir,
          onStage: async (stage) => { await sql`UPDATE recovery_snapshots SET stage=${stage}, updated_at=now() WHERE id=${job.id} AND lease_token=${token}` },
        })
        manifest = result.manifest; pointer = result.pointer
        await sql`UPDATE recovery_snapshots SET manifest=${JSON.stringify(manifest)}::text::jsonb, pointer=${JSON.stringify(pointer)}::text::jsonb,
          verified_at=now(), stage='publishing', batch_id=${batchId} WHERE id=${job.id} AND lease_token=${token}`
      }
      const [stillPublic] = await sql`SELECT 1 FROM repos WHERE id=${repo.id} AND visibility='public' AND deleted_at IS NULL`
      if (!stillPublic) throw new Error('Repository is no longer public; publication stopped')
      const [owned] = await sql`SELECT 1 FROM recovery_snapshots WHERE id=${job.id} AND lease_token=${token} AND leased_until>now()`
      if (!owned) throw new Error('Snapshot lease was lost; publication stopped')
      // Only the short Arkiv section shares the relayer nonce lock with commit anchoring.
      await withArkivLock(async () => {
        const existing = await findSnapshotPointer({ connection: arkiv, repoId, writer: arkiv.account.address, manifestHash: pointer!.hash })
        if (!existing) {
          const published = await publishSnapshotPointer(arkiv, manifest!, pointer!)
          await sql`INSERT INTO arkiv_entities (entity_key,schema,repo_id,tx_hash,expires_at_block)
            VALUES (${hex(published.entityKey)},'dheet-snapshot-v2',${repo.id},${hex(published.txHash)},${published.expiresAt.toString()}) ON CONFLICT DO NOTHING`
          await sql`UPDATE recovery_snapshots SET entity_key=${hex(published.entityKey)}, arkiv_tx=${hex(published.txHash)}, expires_at_block=${published.expiresAt.toString()}
            WHERE id=${job.id} AND lease_token=${token}`
        } else {
          await sql`INSERT INTO arkiv_entities (entity_key,schema,repo_id,tx_hash,expires_at_block)
            VALUES (${hex(existing.entityKey)},'dheet-snapshot-v2',${repo.id},NULL,${existing.expiresAt.toString()}) ON CONFLICT DO NOTHING`
          await sql`UPDATE recovery_snapshots SET entity_key=${hex(existing.entityKey)},expires_at_block=${existing.expiresAt.toString()}
            WHERE id=${job.id} AND lease_token=${token}`
        }
      })
      await sql`UPDATE recovery_snapshots SET status='ready', stage='ready', last_error=NULL, lease_token=NULL, leased_until=NULL,
        postage_checked_at=now(), postage_expires_estimate=now()+${`${postage.ttlSeconds} seconds`}::interval, updated_at=now()
        WHERE id=${job.id} AND lease_token=${token}`
      // This full snapshot also covers older queued pushes; never coalesce a job that another worker has leased.
      await sql`UPDATE recovery_snapshots SET status='skipped',stage='covered_by_newer_snapshot' WHERE repo_id=${repo.id} AND push_id<=${watermark.id} AND status='pending'`
    } catch (error) {
      const failed = Number(job.attempts) >= 8
      const message = String(error).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 400)
      await sql`UPDATE recovery_snapshots SET status=${failed ? 'failed' : 'pending'}, stage=${failed ? 'failed' : 'retrying'}, last_error=${message},
        next_attempt_at=now()+${`${Math.min(3600, 5 * 2 ** Number(job.attempts))} seconds`}::interval,
        lease_token=NULL,leased_until=NULL,updated_at=now() WHERE id=${job.id} AND lease_token=${token}`
      console.error(`snapshot ${job.id}: ${message}`)
    } finally { clearInterval(heartbeat); if (dir) await rm(dir, { recursive: true, force: true }) }
    return true
  }

  const health = async () => {
    const rows = await sql`SELECT DISTINCT batch_id FROM recovery_snapshots WHERE status='ready' AND batch_id IS NOT NULL`
    for (const row of rows) {
      try {
        const status = await new SwarmStore({ url, batchId: row.batch_id }).batchStatus()
        await sql`UPDATE recovery_snapshots SET postage_checked_at=now(),postage_error=NULL,
          postage_expires_estimate=now()+${`${status.ttlSeconds} seconds`}::interval WHERE batch_id=${row.batch_id} AND status='ready'`
      } catch {
        await sql`UPDATE recovery_snapshots SET postage_checked_at=now(),postage_error='Storage funding could not be confirmed',postage_expires_estimate=NULL
          WHERE batch_id=${row.batch_id} AND status='ready'`
      }
    }
  }
  return { tick, health }
}

export function startSnapshotWorker(args: Parameters<typeof createSnapshotWorker>[0]) {
  const worker = createSnapshotWorker(args)
  if (!worker) return
  let lastHealthCheck = 0
  void (async () => {
    for (;;) {
      const worked = await worker.tick().catch((e) => { console.error('snapshot queue error', String(e).replace(/https?:\/\/\S+/g, '[endpoint]')); return false })
      if (Date.now() - lastHealthCheck > 3_600_000) { lastHealthCheck = Date.now(); await worker.health().catch(console.error) }
      if (!worked) await Bun.sleep(2000)
    }
  })()
}
