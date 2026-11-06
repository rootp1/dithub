import { readFileSync, writeFileSync } from 'node:fs'
import { canonicalJson } from './canonical.ts'
import { blake3Hash, sha256 } from './hash.ts'
import { LocalNetworkStore } from './local-store.ts'
import type { Hex, RepositoryManifest, RepositoryRecord } from './types.ts'

interface DheetArchive {
  format: 'dheet-archive'
  version: 1
  createdAt: number
  record: RepositoryRecord
  manifest: RepositoryManifest
  manifestHash: Hex
  chunks: Record<string, string>
  archiveHash: Hex
}

function requiredChunkHashes(manifest: RepositoryManifest): Hex[] {
  return [...new Set([
    ...manifest.bundleChunks.map((chunk) => chunk.hash),
    ...manifest.objects.flatMap((object) => object.chunks.map((chunk) => chunk.hash)),
  ])].sort() as Hex[]
}

function archivePayload(archive: Omit<DheetArchive, 'archiveHash'>): string {
  return canonicalJson(archive)
}

export function exportRepositoryArchive(
  nameOrId: string,
  store: LocalNetworkStore,
  destination: string,
): { archiveHash: Hex; chunks: number; bytes: number } {
  const record = store.getRepo(nameOrId)
  if (!record.manifestHash) throw new Error(`Repository has not been published: ${record.name}`)
  const manifest = store.getManifest(record.manifestHash)
  const chunks = Object.fromEntries(requiredChunkHashes(manifest).map((hash) => [
    hash,
    Buffer.from(store.getChunk(hash)).toString('base64'),
  ]))
  const base = {
    format: 'dheet-archive' as const,
    version: 1 as const,
    createdAt: Math.floor(Date.now() / 1000),
    record,
    manifest,
    manifestHash: record.manifestHash,
    chunks,
  }
  const archive: DheetArchive = { ...base, archiveHash: sha256(archivePayload(base)) }
  const encoded = `${canonicalJson(archive)}\n`
  writeFileSync(destination, encoded, { flag: 'wx' })
  return { archiveHash: archive.archiveHash, chunks: Object.keys(chunks).length, bytes: Buffer.byteLength(encoded) }
}

export function importRepositoryArchive(
  source: string,
  store: LocalNetworkStore,
): { archiveHash: Hex; record: RepositoryRecord; chunks: number } {
  const archive = JSON.parse(readFileSync(source, 'utf8')) as DheetArchive
  if (archive.format !== 'dheet-archive' || archive.version !== 1) throw new Error('Unsupported Dithub archive')
  const { archiveHash, ...base } = archive
  if (sha256(archivePayload(base)) !== archiveHash) throw new Error('Archive hash mismatch')
  if (sha256(canonicalJson(archive.manifest)) !== archive.manifestHash) throw new Error('Archived manifest hash mismatch')
  if (archive.record.manifestHash !== archive.manifestHash) throw new Error('Archive repository/manifest mismatch')
  const required = requiredChunkHashes(archive.manifest)
  for (const hash of required) {
    const encoded = archive.chunks[hash]
    if (!encoded) throw new Error(`Archive is missing chunk ${hash}`)
    const bytes = new Uint8Array(Buffer.from(encoded, 'base64'))
    if (blake3Hash(bytes) !== hash) throw new Error(`Archived chunk hash mismatch: ${hash}`)
    const stored = store.putChunk(bytes)
    if (stored.hash !== hash) throw new Error(`Restored chunk hash mismatch: ${hash}`)
  }
  if (Object.keys(archive.chunks).length !== required.length) throw new Error('Archive contains undeclared chunks')
  const restoredManifestHash = store.putManifest(archive.manifest)
  if (restoredManifestHash !== archive.manifestHash) throw new Error('Restored manifest hash mismatch')
  store.restoreRepo(archive.record)
  return { archiveHash, record: archive.record, chunks: required.length }
}
