import { test, expect } from 'bun:test'
import { SQL } from 'bun'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beeFixture, sampleRepo } from '../../../packages/sdk/test/swarm-fixture.ts'
import { snapshotGit, snapshotAttribute } from '../../../packages/sdk/src/index.ts'
import { createSnapshotWorker } from '../src/snapshots.ts'

// Explicit opt-in: run only against an isolated, migrated test database.
const db = process.env.SWARM_TEST_DATABASE_URL
;(db ? test : test.skip)('push queue, retry, persisted pointers, recovery status, privacy, funding and lease recovery (Postgres)', async () => {
  process.env.DATABASE_URL = db!
  process.env.INTERNAL_TOKEN = 'test-internal-token-at-least-24-characters'
  const dir = await mkdtemp(join(tmpdir(), 'swarm-worker-')), bee = beeFixture()
  const reposDir = join(dir, 'repos'); await mkdir(reposDir)
  process.env.REPOS_DIR = reposDir
  process.env.SWARM_BEE_URL = bee.url; process.env.SWARM_BATCH_ID = 'aa'.repeat(32); process.env.SWARM_READ_URL = bee.url
  const sql = new SQL(db!)
  const repoId = '78'.repeat(32), writer = `0x${'ab'.repeat(20)}` as `0x${string}`
  let repoNum: number | undefined, userId: number | undefined, arkivWrites = 0
  let persisted: Record<string, unknown> | undefined
  const arkiv = {
    account: { address: writer },
    publicClient: {
      select: () => { const query: any = { from: () => query, where: () => query, orderBy: () => query, limit: () => query, fetch: async () => ({ entities: persisted ? [persisted] : [] }) }; return query },
      waitForTransactionReceipt: async () => ({}),
    },
    walletClient: { createEntity: async (_schema: unknown, fields: any) => {
      arkivWrites++
      persisted = { reference: fields.reference, size: fields.size, manifestHash: fields.manifestHash, ctime: fields.ctime, $key: `0x${'cc'.repeat(32)}`, $expiresAt: 9_000_000n }
      return { entityKey: `0x${'cc'.repeat(32)}`, txHash: `0x${'dd'.repeat(32)}`, expiresAt: 9_000_000n }
    } },
  }
  try {
    const source = await sampleRepo(dir), tip = await snapshotGit(['rev-parse', 'HEAD'], source)
    await snapshotGit(['clone', '--mirror', '--', source, join(reposDir, `${repoId}.git`)])
    const [user] = await sql`INSERT INTO users (login) VALUES (${'swarm-test-' + crypto.randomUUID().slice(0, 8)}) RETURNING id,login`
    userId = Number(user.id)
    const [repo] = await sql`INSERT INTO repos (dheet_repo_id,owner_kind,owner_id,name) VALUES (${Buffer.from(repoId,'hex')},'user',${user.id},'large') RETURNING *`
    repoNum = Number(repo.id)
    const repoRow = { ...repo, id: repoNum, owner_login: user.login }
    const { recordRefUpdates } = await import('../../api/src/internal.ts')
    await recordRefUpdates(repoRow as never, null, `0x${repoId}`, [{ ref: 'refs/heads/main', oldOid: '0'.repeat(40), newOid: tip }])
    expect(Number((await sql`SELECT count(*) AS n FROM recovery_snapshots WHERE repo_id=${repoNum}`)[0].n)).toBe(1)
    const worker = createSnapshotWorker({ sql, arkiv: arkiv as never, reposDir, workDir: dir })!
    bee.failNextUpload()
    expect(await worker.tick()).toBe(true)
    let [job] = await sql`SELECT * FROM recovery_snapshots WHERE repo_id=${repoNum}`
    expect(job.status).toBe('pending'); expect(job.stage).toBe('retrying'); expect(arkivWrites).toBe(0)
    await sql`UPDATE recovery_snapshots SET next_attempt_at=now() WHERE id=${job.id}`
    expect(await worker.tick()).toBe(true)
    ;[job] = await sql`SELECT * FROM recovery_snapshots WHERE repo_id=${repoNum}`
    expect(job.status).toBe('ready'); expect(arkivWrites).toBe(1)
    expect(job.manifest.bundle.size).toBeGreaterThan(2_000_000)
    expect(snapshotAttribute(persisted!.manifestHash)).toBe(job.pointer.hash)
    expect(Number((await sql`SELECT count(*) AS n FROM arkiv_entities WHERE repo_id=${repoNum}`)[0].n)).toBe(1)
    const { recoveryStatus, refsCovered, queueRecovery } = await import('../../api/src/recovery.ts')
    expect(refsCovered([{ name: 'refs/heads/main', oid: '0x' + tip }], [{ name: 'refs/heads/main', oid: tip }])).toBe(true)
    // Record all refs in the DB as a receive hook does.
    for (const ref of job.manifest.refs) await sql`INSERT INTO git_refs (repo_id,name,oid) VALUES (${repoNum},${ref.name},${Buffer.from(ref.oid,'hex')}) ON CONFLICT DO NOTHING`
    expect((await recoveryStatus(repoRow as never)).coversLatest).toBe(true)
    const api = (await import('../../api/src/index.ts')).default
    const instructions = await api.fetch(new Request(`http://localhost/api/repos/${user.login}/large/recovery/instructions`))
    expect(instructions.status).toBe(200)
    expect((await instructions.json()).pointer.hash).toBe(job.pointer.hash)
    expect((await api.fetch(new Request(`http://localhost/api/repos/${user.login}/large/recovery`, { method: 'POST' }))).status).toBe(403)
    await sql`UPDATE git_refs SET oid=${Buffer.from('99'.repeat(20),'hex')} WHERE repo_id=${repoNum} AND name='refs/heads/main'`
    expect((await recoveryStatus(repoRow as never)).coversLatest).toBe(false)
    bee.setTTL(0); await worker.health()
    expect((await recoveryStatus(repoRow as never)).latest?.postageWarning).toContain('could not be confirmed')
    bee.setTTL(86400 * 30)
    // Rediscover after an interrupted DB write: no second Arkiv publication, tracking remains renewable.
    const uploads = bee.calls.filter((call) => call.startsWith('POST')).length
    await sql`UPDATE recovery_snapshots SET status='processing',leased_until=now()-interval '1 minute' WHERE id=${job.id}`
    expect(await worker.tick()).toBe(true)
    expect(arkivWrites).toBe(1)
    expect(bee.calls.filter((call) => call.startsWith('POST')).length).toBe(uploads)
    await queueRecovery(repoRow as never)
    expect(Number((await sql`SELECT count(*) AS n FROM recovery_snapshots WHERE repo_id=${repoNum} AND status='ready'`)[0].n)).toBe(1)
    expect(Number((await sql`SELECT count(*) AS n FROM recovery_snapshots WHERE repo_id=${repoNum} AND status='pending'`)[0].n)).toBe(1)
    await sql`UPDATE repos SET visibility='private' WHERE id=${repoNum}`
    await worker.tick()
    expect((await sql`SELECT stage FROM recovery_snapshots WHERE repo_id=${repoNum} ORDER BY id DESC LIMIT 1`)[0].stage).toBe('not_public')
    expect((await api.fetch(new Request(`http://localhost/api/repos/${user.login}/large/recovery`))).status).toBe(404)
  } finally {
    if (repoNum) { await sql`DELETE FROM arkiv_entities WHERE repo_id=${repoNum}`; await sql`DELETE FROM repos WHERE id=${repoNum}` }
    if (userId) await sql`DELETE FROM users WHERE id=${userId}`
    await sql.close(); bee.stop(); await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
