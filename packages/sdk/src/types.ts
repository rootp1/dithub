export type Hex = `0x${string}`
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag'
export type GitObjectFormat = 'sha1' | 'sha256'

export interface ChunkDescriptor {
  index: number
  size: number
  hash: Hex
}

export interface ObjectDescriptor {
  dheetOid: Hex
  gitOid: Hex
  gitOidHex: string
  gitAlgorithm: GitObjectFormat
  type: GitObjectType
  rawSize: number
  chunks: ChunkDescriptor[]
}

export interface RefDescriptor {
  name: string
  oid: string
}

export interface RepositoryManifest {
  protocol: 'dheet'
  version: 1
  repoId: Hex
  name: string
  sequence: number
  createdAt: number
  gitObjectFormat: GitObjectFormat
  previousManifest: Hex | null
  bundleHash: Hex
  bundleChunks: ChunkDescriptor[]
  objects: ObjectDescriptor[]
  refs: RefDescriptor[]
  headRef: string
  objectRoot: Hex
}

export interface RepositoryRecord {
  repoId: Hex
  name: string
  sequence: number
  manifestHash: Hex | null
  refs: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface PublishResult {
  repo: RepositoryRecord
  manifest: RepositoryManifest
  manifestHash: Hex
  uploadedChunks: number
  reusedChunks: number
}

export interface VerificationResult {
  valid: boolean
  manifestHash: Hex
  objectCount: number
  chunkCount: number
  errors: string[]
}

export type CollaborationKind = 'pr' | 'review' | 'issue' | 'comment' | 'release'

export interface CollaborationRecord<T = unknown> {
  version: 1
  repoId: Hex
  id: Hex
  kind: CollaborationKind
  sequence: number
  author: Hex
  createdAt: number
  nonce: number
  bodyHash: Hex
  body: T
  signature: Hex
}

export interface PrivateChunkEnvelope {
  version: 1
  algorithm: 'xchacha20-poly1305'
  repoId: Hex
  keyEpoch: number
  nonce: Hex
  plaintextHash: Hex
  ciphertextHash: Hex
  ciphertext: Uint8Array
}
