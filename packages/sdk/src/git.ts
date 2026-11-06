import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { chunkBytes } from './chunks.ts'
import { dheetOid, gitOid, sha256, toBytes32GitOid } from './hash.ts'
import { isolatedGitEnvironment } from './process.ts'
import type { GitObjectFormat, GitObjectType, ObjectDescriptor, RefDescriptor } from './types.ts'

function runGit(repoPath: string, args: string[], options: { encoding?: BufferEncoding | null; maxBuffer?: number } = {}) {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    env: isolatedGitEnvironment(),
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString() : result.stderr
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
  return result.stdout
}

export function assertGitRepository(repoPath: string): void {
  runGit(repoPath, ['rev-parse', '--git-dir'])
}

export function gitObjectFormat(repoPath: string): GitObjectFormat {
  const output = String(runGit(repoPath, ['rev-parse', '--show-object-format'])).trim()
  if (output !== 'sha1' && output !== 'sha256') throw new Error(`Unsupported Git object format: ${output}`)
  return output
}

export function listRefs(repoPath: string): RefDescriptor[] {
  const output = String(runGit(repoPath, ['for-each-ref', '--format=%(refname)%00%(objectname)']))
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, oid] = line.split('\0')
      if (!name || !oid) throw new Error(`Malformed ref row: ${line}`)
      return { name, oid }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function currentHeadRef(repoPath: string): string {
  const output = runGit(repoPath, ['symbolic-ref', '-q', 'HEAD'])
  const headRef = String(output).trim()
  if (!headRef.startsWith('refs/heads/')) throw new Error(`Detached or invalid HEAD: ${headRef}`)
  return headRef
}

export function createBundle(repoPath: string): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), 'dheet-bundle-'))
  const bundlePath = join(directory, 'repository.bundle')
  try {
    runGit(repoPath, ['bundle', 'create', bundlePath, '--all'])
    return new Uint8Array(readFileSync(bundlePath))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export interface ExportedObject {
  descriptor: ObjectDescriptor
  chunks: Uint8Array[]
}

export function exportReachableObjects(repoPath: string): ExportedObject[] {
  const algorithm = gitObjectFormat(repoPath)
  const output = String(runGit(repoPath, ['rev-list', '--objects', '--all']))
  const objectIds = [...new Set(output.split('\n').filter(Boolean).map((line) => line.split(' ')[0]).filter(Boolean))]
  return objectIds.map((oid) => exportObject(repoPath, oid as string, algorithm))
}

function exportObject(repoPath: string, oid: string, algorithm: GitObjectFormat): ExportedObject {
  const type = String(runGit(repoPath, ['cat-file', '-t', oid])).trim() as GitObjectType
  if (!['blob', 'tree', 'commit', 'tag'].includes(type)) throw new Error(`Unsupported Git object type: ${type}`)
  const payload = runGit(repoPath, ['cat-file', type, oid], { encoding: null })
  if (!Buffer.isBuffer(payload)) throw new Error(`Unable to read object ${oid}`)
  const computedGitOid = gitOid(type, payload, algorithm).slice(2)
  if (computedGitOid !== oid.toLowerCase()) throw new Error(`Git OID mismatch for ${oid}`)
  const chunked = chunkBytes(payload)
  return {
    descriptor: {
      dheetOid: dheetOid(type, payload),
      gitOid: toBytes32GitOid(oid),
      gitOidHex: oid,
      gitAlgorithm: algorithm,
      type,
      rawSize: payload.byteLength,
      chunks: chunked.descriptors,
    },
    chunks: chunked.chunks,
  }
}

export function bundleHash(bundle: Uint8Array) {
  return sha256(bundle)
}

export function runGitFsck(repoPath: string): void {
  runGit(repoPath, ['fsck', '--full', '--strict'])
}
