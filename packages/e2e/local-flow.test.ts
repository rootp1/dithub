import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  LocalNetworkStore,
  cloneRepository,
  createCollaborationRecord,
  exportRepositoryArchive,
  importRepositoryArchive,
  repositoryRemoteUrl,
  verifyRepository,
} from '../sdk/src/index.ts'
import { buildIndex } from '../indexer/src/index.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dheet-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

function run(command: string, args: string[], cwd?: string, extraEnv: Record<string, string> = {}): string {
  const result = Bun.spawnSync([command, ...args], {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.exitCode})\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    )
  }
  return result.stdout.toString().trim()
}

function configureIdentity(repository: string, name: string): void {
  run('git', ['config', 'user.name', name], repository)
  run('git', ['config', 'user.email', `${name.toLowerCase()}@example.test`], repository)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('local end-to-end Git transport', () => {
  test('Alice publishes, Bob clones and pushes, fresh clone verifies', async () => {
    const root = temporaryDirectory('e2e')
    const network = join(root, 'network')
    const alice = join(root, 'alice')
    const bob = join(root, 'bob')
    const fresh = join(root, 'fresh')
    const cli = resolve('packages/cli/src/index.ts')
    const helperPath = `${resolve('bin')}:${process.env.PATH ?? ''}`

    run('git', ['init', '-b', 'main', alice])
    configureIdentity(alice, 'Alice')
    writeFileSync(join(alice, 'README.md'), '# demo\n')
    run('git', ['add', 'README.md'], alice)
    run('git', ['commit', '-m', 'initial'], alice)

    run('bun', [cli, 'init', 'demo.local', '--network', network, '--repo', alice, '--json'])
    run('bun', [cli, 'push', 'demo.local', '--network', network, '--repo', alice, '--json'])

    const store = new LocalNetworkStore(network)
    expect(verifyRepository('demo.local', store).valid).toBe(true)
    const remoteUrl = repositoryRemoteUrl('demo.local', network)

    run('git', ['clone', remoteUrl, bob], undefined, { PATH: helperPath })
    configureIdentity(bob, 'Bob')
    writeFileSync(join(bob, 'README.md'), '# demo\n\nBob was here.\n')
    run('git', ['add', 'README.md'], bob)
    run('git', ['commit', '-m', 'bob update'], bob)
    run('git', ['push', 'origin', 'HEAD:refs/heads/main'], bob, { PATH: helperPath })

    const afterPush = store.getRepo('demo.local')
    expect(afterPush.sequence).toBe(2)
    expect(verifyRepository('demo.local', store).valid).toBe(true)
    const issue = await createCollaborationRecord({
      repoId: afterPush.repoId,
      kind: 'issue',
      sequence: 1,
      nonce: 0,
      body: { title: 'Verify the explorer', state: 'open' },
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      createdAt: 1_700_000_000,
    })
    store.appendCollaborationRecord(issue)

    run('git', ['clone', remoteUrl, fresh], undefined, { PATH: helperPath })
    expect(readFileSync(join(fresh, 'README.md'), 'utf8')).toContain('Bob was here.')
    run('git', ['fsck', '--full', '--strict'], fresh)

    const archive = join(root, 'demo.dheet-archive')
    exportRepositoryArchive('demo.local', store, archive)
    const recoveredNetwork = join(root, 'recovered-network')
    const recovered = join(root, 'recovered')
    const recoveredStore = new LocalNetworkStore(recoveredNetwork)
    importRepositoryArchive(archive, recoveredStore)
    expect(verifyRepository('demo.local', recoveredStore).valid).toBe(true)
    cloneRepository('demo.local', recovered, recoveredStore)
    expect(readFileSync(join(recovered, 'README.md'), 'utf8')).toContain('Bob was here.')
    run('git', ['fsck', '--full', '--strict'], recovered)

    const index = buildIndex(network, join(root, 'index.sqlite'))
    expect((index.query('SELECT COUNT(*) AS count FROM repositories').get() as { count: number }).count).toBe(1)
    expect((index.query('SELECT COUNT(*) AS count FROM records').get() as { count: number }).count).toBe(1)
    index.close()
  })
})
