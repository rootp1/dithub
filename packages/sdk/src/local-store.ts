import {
  existsSync,
  readdirSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson } from './canonical.ts'
import { blake3Hash, hexToBytes, sha256 } from './hash.ts'
import type {
  CollaborationRecord,
  Hex,
  RepositoryManifest,
  RepositoryRecord,
} from './types.ts'

interface NameRegistry {
  [name: string]: Hex
}

export class LocalNetworkStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.path('chunks'), { recursive: true })
    mkdirSync(this.path('manifests'), { recursive: true })
    mkdirSync(this.path('repos'), { recursive: true })
    mkdirSync(this.path('collaboration'), { recursive: true })
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  registerName(name: string, repoId: Hex): void {
    const names = this.readJson<NameRegistry>('names.json', {})
    const current = names[name]
    if (current && current !== repoId) throw new Error(`Name already registered: ${name}`)
    names[name] = repoId
    this.writeJsonAtomic('names.json', names)
  }

  resolveName(nameOrId: string): Hex {
    if (/^0x[0-9a-f]{64}$/i.test(nameOrId)) return nameOrId.toLowerCase() as Hex
    const repoId = this.readJson<NameRegistry>('names.json', {})[nameOrId]
    if (!repoId) throw new Error(`Unknown repository: ${nameOrId}`)
    return repoId
  }

  getRepo(nameOrId: string): RepositoryRecord {
    const repoId = this.resolveName(nameOrId)
    const record = this.readJson<RepositoryRecord | null>(join('repos', `${repoId.slice(2)}.json`), null)
    if (!record) throw new Error(`Repository state is missing: ${repoId}`)
    return record
  }

  createRepo(name: string, repoId: Hex, now = Math.floor(Date.now() / 1000)): RepositoryRecord {
    this.registerName(name, repoId)
    const relative = join('repos', `${repoId.slice(2)}.json`)
    const existing = this.readJson<RepositoryRecord | null>(relative, null)
    if (existing) return existing
    const record: RepositoryRecord = {
      repoId,
      name,
      sequence: 0,
      manifestHash: null,
      refs: {},
      createdAt: now,
      updatedAt: now,
    }
    this.writeJsonAtomic(relative, record)
    return record
  }

  putChunk(bytes: Uint8Array): { hash: Hex; reused: boolean } {
    const hash = blake3Hash(bytes)
    const relative = join('chunks', hash.slice(2))
    const target = this.path(relative)
    if (existsSync(target)) {
      const existing = new Uint8Array(readFileSync(target))
      if (blake3Hash(existing) !== hash) throw new Error(`Stored chunk is corrupt: ${hash}`)
      return { hash, reused: true }
    }
    this.writeBytesAtomic(relative, bytes)
    return { hash, reused: false }
  }

  getChunk(hash: Hex): Uint8Array {
    const target = this.path('chunks', hash.slice(2))
    if (!existsSync(target)) throw new Error(`Missing chunk: ${hash}`)
    const bytes = new Uint8Array(readFileSync(target))
    if (blake3Hash(bytes) !== hash) throw new Error(`Chunk hash mismatch: ${hash}`)
    return bytes
  }

  putManifest(manifest: RepositoryManifest): Hex {
    const encoded = canonicalJson(manifest)
    const hash = sha256(encoded)
    this.writeBytesAtomic(join('manifests', `${hash.slice(2)}.json`), Buffer.from(encoded))
    return hash
  }

  getManifest(hash: Hex): RepositoryManifest {
    const relative = join('manifests', `${hash.slice(2)}.json`)
    const raw = readFileSync(this.path(relative), 'utf8')
    if (sha256(raw) !== hash) throw new Error(`Manifest hash mismatch: ${hash}`)
    return JSON.parse(raw) as RepositoryManifest
  }

  compareAndSwapRepo(
    repoId: Hex,
    expectedSequence: number,
    expectedManifest: Hex | null,
    nextManifest: Hex,
    refs: Record<string, string>,
  ): RepositoryRecord {
    return this.withRepoLock(repoId, () => {
      const relative = join('repos', `${repoId.slice(2)}.json`)
      const current = this.getRepo(repoId)
      if (current.sequence !== expectedSequence || current.manifestHash !== expectedManifest) {
        throw new Error(
          `Ref CAS failed: expected sequence ${expectedSequence}/${expectedManifest ?? 'none'}, ` +
            `found ${current.sequence}/${current.manifestHash ?? 'none'}`,
        )
      }
      const updated: RepositoryRecord = {
        ...current,
        sequence: current.sequence + 1,
        manifestHash: nextManifest,
        refs: Object.fromEntries(Object.entries(refs).sort(([left], [right]) => left.localeCompare(right))),
        updatedAt: Math.floor(Date.now() / 1000),
      }
      this.writeJsonAtomic(relative, updated)
      return updated
    })
  }

  listRepositories(): RepositoryRecord[] {
    return readdirSync(this.path('repos'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.readJson<RepositoryRecord>(join('repos', name), null as never))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  restoreRepo(record: RepositoryRecord): void {
    if (!record.manifestHash) throw new Error('Cannot restore a repository without a manifest')
    this.getManifest(record.manifestHash)
    this.withRepoLock(record.repoId, () => {
      const relative = join('repos', `${record.repoId.slice(2)}.json`)
      const existing = this.readJson<RepositoryRecord | null>(relative, null)
      if (existing && canonicalJson(existing) !== canonicalJson(record)) {
        throw new Error(`Repository restore conflicts with existing state: ${record.repoId}`)
      }
      this.registerName(record.name, record.repoId)
      this.writeJsonAtomic(relative, record)
    })
  }

  appendCollaborationRecord(record: CollaborationRecord): void {
    const directory = join('collaboration', record.repoId.slice(2))
    const existing = this.listCollaborationRecords(record.repoId)
    if (record.sequence !== existing.length + 1) {
      throw new Error(`Collaboration sequence must be ${existing.length + 1}, received ${record.sequence}`)
    }
    if (existing.some((candidate) => candidate.id === record.id)) {
      throw new Error(`Collaboration record already exists: ${record.id}`)
    }
    this.writeJsonAtomic(join(directory, `${String(record.sequence).padStart(12, '0')}-${record.id.slice(2)}.json`), record)
  }

  listCollaborationRecords(repoId: Hex): CollaborationRecord[] {
    const directory = this.path('collaboration', repoId.slice(2))
    if (!existsSync(directory)) return []
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => this.readJson<CollaborationRecord>(join('collaboration', repoId.slice(2), name), null as never))
  }

  private withRepoLock<T>(repoId: Hex, action: () => T): T {
    const lockPath = this.path('repos', `${repoId.slice(2)}.lock`)
    const deadline = Date.now() + 10_000
    let descriptor: number | undefined
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lockPath, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for repository lock: ${repoId}`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try {
      return action()
    } finally {
      closeSync(descriptor)
      rmSync(lockPath, { force: true })
    }
  }

  private readJson<T>(relative: string, fallback: T): T {
    const target = this.path(relative)
    if (!existsSync(target)) return fallback
    return JSON.parse(readFileSync(target, 'utf8')) as T
  }

  private writeJsonAtomic(relative: string, value: unknown): void {
    this.writeBytesAtomic(relative, Buffer.from(`${canonicalJson(value)}\n`))
  }

  private writeBytesAtomic(relative: string, value: Uint8Array): void {
    const target = this.path(relative)
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, value)
      renameSync(temporary, target)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
