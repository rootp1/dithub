#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  LocalNetworkStore,
  isolatedGitEnvironment,
  materialiseBareRepository,
  parseRepositoryRemoteUrl,
  publishRepository,
} from '../../sdk/src/index.ts'

function runService(service: string, repositoryPath: string): number {
  const result = spawnSync(service, [repositoryPath], {
    env: isolatedGitEnvironment(),
    stdio: 'inherit',
  })
  return result.status ?? 1
}

function readLines(): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffered = ''
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of Bun.stdin.stream()) {
        buffered += decoder.decode(chunk, { stream: true })
        while (buffered.includes('\n')) {
          const newline = buffered.indexOf('\n')
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          yield line
        }
      }
      if (buffered) yield buffered
    },
  }
}

async function main(): Promise<void> {
  const url = process.argv[3] ?? process.argv[2]
  if (!url) throw new Error('Missing Dheet remote URL')
  const parsed = parseRepositoryRemoteUrl(url)
  const store = new LocalNetworkStore(parsed.networkPath)

  for await (const line of readLines()) {
    if (line === 'capabilities') {
      process.stdout.write('connect\n\n')
      continue
    }
    if (line === '') continue
    if (!line.startsWith('connect ')) throw new Error(`Unsupported remote-helper command: ${line}`)
    const service = line.slice('connect '.length)
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      process.stdout.write('unsupported\n')
      return
    }

    const directory = mkdtempSync(join(tmpdir(), 'dheet-remote-'))
    const barePath = join(directory, 'repository.git')
    try {
      materialiseBareRepository(parsed.name, barePath, store)
      process.stdout.write('\n')
      const status = runService(service, barePath)
      if (status !== 0) process.exit(status)
      if (service === 'git-receive-pack') publishRepository(barePath, parsed.name, store)
      return
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
