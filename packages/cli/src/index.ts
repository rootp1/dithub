#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LocalNetworkStore,
  anchorRef,
  anchorRefBySignature,
  cloneRepository,
  createCollaborationRecord,
  createArkivConnection,
  initialiseRepository,
  exportRepositoryArchive,
  importRepositoryArchive,
  publishRepository,
  prepareRefAnchor,
  repositoryRemoteUrl,
  renewArkivEntities,
  uploadManifestToArkiv,
  fetchRepositoryFromArkiv,
  createSwarmClient,
  hexToBytes,
  publishPackToSwarm,
  reconstructBundle,
  swarmConfigFromEnv,
  verifyRepository,
  verifyCollaborationRecord,
} from '../../sdk/src/index.ts'

interface ParsedArgs {
  command: string | undefined
  positionals: string[]
  options: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positionals: string[] = []
  const options: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value) continue
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const [rawKey, inlineValue] = value.slice(2).split('=', 2)
    if (!rawKey) throw new Error(`Invalid option: ${value}`)
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue
      continue
    }
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      options[rawKey] = next
      index += 1
    } else {
      options[rawKey] = true
    }
  }
  return { command, positionals, options }
}

function option(args: ParsedArgs, name: string, fallback?: string): string {
  const value = args.options[name]
  if (typeof value === 'string') return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing --${name}`)
}

function positional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positionals[index]
  if (!value) throw new Error(`Missing ${label}`)
  return value
}

function jsonEnabled(args: ParsedArgs): boolean {
  return args.options.json === true
}

function output(args: ParsedArgs, value: unknown, human: string): void {
  console.log(jsonEnabled(args) ? JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) : human)
}

function usage(): never {
  console.error(`dithub <command>

Commands:
  init <name> [--network path] [--repo path]
  push <name|repoId> [--network path] [--repo path]
  arkiv-publish <name|repoId> [--network path] [--access-key key] [--swarm-only]
  arkiv-clone <repoId> <manifestHash> <destination> [--access-key key] [--swarm-key hex] [--no-swarm]
  anchor <name|repoId> --rpc url --chain-id id --ref-registry address [--ref name]
  anchor-signed <name|repoId> --rpc url --chain-id id --ref-registry address [--ref name]
  anchor-plan <name|repoId> --rpc url --chain-id id --ref-registry address [--ref name]
  clone <name|repoId> <destination> [--network path]
  verify <name|repoId> [--network path]
  refs <name|repoId> [--network path]
  whois <name|repoId> [--network path]
  remote-url <name> [--network path]
  archive-export <name|repoId> <file> [--network path]
  archive-import <file> [--network path]
  record-create <name|repoId> --kind pr|review|issue|comment|release --body JSON
  records <name|repoId> [--kind kind]
  renew --entities 0xkey,0xkey [--access-key key]

Options:
  --json        machine-readable output
  --network     local network store (default: .dheet-network)
  --repo        Git repository path (default: current directory)

Swarm: set BEE_URL (and BEE_POSTAGE_BATCH_ID to upload). arkiv-publish then stores the pack on Swarm and
records its refs in the Arkiv manifest; arkiv-clone reads Swarm first and falls back to Arkiv chunks.`)
  process.exit(2)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command || args.options.help === true) usage()
  const networkPath = resolve(option(args, 'network', '.dheet-network'))
  const store = new LocalNetworkStore(networkPath)

  switch (args.command) {
    case 'init': {
      const name = positional(args, 0, 'repository name')
      const repoPath = resolve(option(args, 'repo', '.'))
      const result = initialiseRepository(repoPath, name, store)
      const remoteUrl = repositoryRemoteUrl(name, networkPath)
      output(args, { ...result, networkPath, remoteUrl }, `Initialised ${name}\nrepoId: ${result.repoId}\nremote: ${remoteUrl}`)
      return
    }
    case 'push': {
      const name = positional(args, 0, 'repository name or ID')
      const repoPath = resolve(option(args, 'repo', '.'))
      const result = publishRepository(repoPath, name, store)
      output(
        args,
        result,
        `Published ${result.repo.name} at sequence ${result.repo.sequence}\nmanifest: ${result.manifestHash}\nchunks: ${result.uploadedChunks} uploaded, ${result.reusedChunks} reused`,
      )
      return
    }
    case 'clone': {
      const name = positional(args, 0, 'repository name or ID')
      const destination = resolve(positional(args, 1, 'destination'))
      if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`)
      const manifest = cloneRepository(name, destination, store)
      output(args, manifest, `Cloned ${manifest.name} at sequence ${manifest.sequence} to ${destination}`)
      return
    }
    case 'arkiv-clone': {
      const repoId = positional(args, 0, 'repository ID') as `0x${string}`
      const manifestHash = positional(args, 1, 'manifest hash') as `0x${string}`
      const destination = resolve(positional(args, 2, 'destination'))
      if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`)
      const connection = createArkivConnection({
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        accessKey: option(args, 'access-key', process.env.ARKIV_ACCESS_KEY ?? ''),
      })
      const swarmKey = typeof args.options['swarm-key'] === 'string' ? hexToBytes(args.options['swarm-key']) : undefined
      const manifest = await fetchRepositoryFromArkiv({
        repoId,
        manifestHash,
        connection,
        store,
        ...(args.options['no-swarm'] === true ? { swarm: null } : {}),
        ...(swarmKey ? { swarmKey } : {}),
        log: (message) => console.error(message),
      })
      cloneRepository(repoId, destination, store)
      output(args, manifest, `Fetched ${manifest.name} from Arkiv and cloned to ${destination}`)
      return
    }
    case 'arkiv-publish': {
      const name = positional(args, 0, 'repository name or ID')
      const repo = store.getRepo(name)
      if (!repo.manifestHash) throw new Error('Publish locally before uploading to Arkiv')
      const privateKey = process.env.DHEET_PRIVATE_KEY
      if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) {
        throw new Error('DHEET_PRIVATE_KEY must contain a 32-byte hex private key')
      }
      const connection = createArkivConnection({
        privateKey: privateKey as `0x${string}`,
        accessKey: option(args, 'access-key', process.env.ARKIV_ACCESS_KEY ?? ''),
      })
      const manifest = store.getManifest(repo.manifestHash)
      const swarmConfig = swarmConfigFromEnv()
      if (!swarmConfig && args.options['swarm-only'] === true) throw new Error('--swarm-only needs BEE_URL and BEE_POSTAGE_BATCH_ID')
      const swarm = swarmConfig
        ? await publishPackToSwarm(createSwarmClient(swarmConfig), {
          repoId: manifest.repoId,
          packBytes: reconstructBundle(store, manifest),
          manifest,
        })
        : undefined
      if (!swarm) console.error('Swarm disabled (BEE_URL unset); pack bytes go to Arkiv chunks only')
      const result = await uploadManifestToArkiv({
        manifest,
        localStore: store,
        connection,
        ...(swarm ? { swarm } : {}),
        ...(args.options['swarm-only'] === true ? { uploadChunks: false } : {}),
      })
      output(
        args,
        { ...result, ...(swarm ? { swarm } : {}) },
        `Uploaded manifest to Arkiv\nentity: ${result.manifestEntityKey}\nchunks: ${result.chunkEntities}\nexpires: ${result.expiresAt}${swarm ? `\nswarm pack: ${swarm.packRef}\nswarm manifest: ${swarm.manifestRef}` : ''}`,
      )
      return
    }
    case 'anchor': {
      const name = positional(args, 0, 'repository name or ID')
      const repo = store.getRepo(name)
      if (!repo.manifestHash) throw new Error('Publish locally before anchoring')
      const manifest = store.getManifest(repo.manifestHash)
      const refName = option(args, 'ref', manifest.headRef)
      const ref = manifest.refs.find((candidate) => candidate.name === refName)
      if (!ref) throw new Error(`Manifest does not contain ${refName}`)
      const privateKey = process.env.DHEET_PRIVATE_KEY
      if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) {
        throw new Error('DHEET_PRIVATE_KEY must contain a 32-byte hex private key')
      }
      const result = await anchorRef({
        rpcUrl: option(args, 'rpc'),
        chainId: Number(option(args, 'chain-id')),
        privateKey: privateKey as `0x${string}`,
        refRegistry: option(args, 'ref-registry') as `0x${string}`,
        refName,
        gitOid: ref.oid,
        manifestRoot: manifest.objectRoot,
        force: args.options.force === true,
      })
      output(
        args,
        result,
        `${result.alreadyAnchored ? 'Already anchored' : 'Anchored'} ${refName} at sequence ${result.sequence}\nroot: ${result.refRoot}${result.transactionHash ? `\ntx: ${result.transactionHash}` : ''}`,
      )
      return
    }
    case 'anchor-signed': {
      const name = positional(args, 0, 'repository name or ID')
      const repo = store.getRepo(name)
      if (!repo.manifestHash) throw new Error('Publish locally before anchoring')
      const manifest = store.getManifest(repo.manifestHash)
      const refName = option(args, 'ref', manifest.headRef)
      const ref = manifest.refs.find((candidate) => candidate.name === refName)
      if (!ref) throw new Error(`Manifest does not contain ${refName}`)
      const signerPrivateKey = process.env.DHEET_SIGNER_PRIVATE_KEY
      const relayerPrivateKey = process.env.DHEET_PRIVATE_KEY
      if (!signerPrivateKey || !/^0x[0-9a-f]{64}$/i.test(signerPrivateKey)) throw new Error('DHEET_SIGNER_PRIVATE_KEY is invalid')
      if (!relayerPrivateKey || !/^0x[0-9a-f]{64}$/i.test(relayerPrivateKey)) throw new Error('DHEET_PRIVATE_KEY is invalid')
      const result = await anchorRefBySignature({
        rpcUrl: option(args, 'rpc'),
        chainId: Number(option(args, 'chain-id')),
        signerPrivateKey: signerPrivateKey as `0x${string}`,
        relayerPrivateKey: relayerPrivateKey as `0x${string}`,
        refRegistry: option(args, 'ref-registry') as `0x${string}`,
        refName,
        gitOid: ref.oid,
        manifestRoot: manifest.objectRoot,
        force: args.options.force === true,
      })
      output(args, result, `Relayed signed anchor for ${refName} at sequence ${result.sequence}\ntx: ${result.transactionHash}`)
      return
    }
    case 'anchor-plan': {
      const name = positional(args, 0, 'repository name or ID')
      const repo = store.getRepo(name)
      if (!repo.manifestHash) throw new Error('Publish locally before anchoring')
      const manifest = store.getManifest(repo.manifestHash)
      const refName = option(args, 'ref', manifest.headRef)
      const ref = manifest.refs.find((candidate) => candidate.name === refName)
      if (!ref) throw new Error(`Manifest does not contain ${refName}`)
      const result = await prepareRefAnchor({
        rpcUrl: option(args, 'rpc'),
        chainId: Number(option(args, 'chain-id')),
        refRegistry: option(args, 'ref-registry') as `0x${string}`,
        refName,
        gitOid: ref.oid,
        manifestRoot: manifest.objectRoot,
        force: args.options.force === true,
      })
      output(args, result, JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
      return
    }
    case 'verify': {
      const name = positional(args, 0, 'repository name or ID')
      const result = verifyRepository(name, store)
      output(
        args,
        result,
        result.valid
          ? `Verified ${result.objectCount} objects and ${result.chunkCount} chunks\nmanifest: ${result.manifestHash}`
          : `Verification failed:\n${result.errors.join('\n')}`,
      )
      if (!result.valid) process.exitCode = 1
      return
    }
    case 'refs': {
      const repo = store.getRepo(positional(args, 0, 'repository name or ID'))
      output(args, repo.refs, Object.entries(repo.refs).map(([name, oid]) => `${oid} ${name}`).join('\n'))
      return
    }
    case 'whois': {
      const repo = store.getRepo(positional(args, 0, 'repository name or ID'))
      output(args, repo, `${repo.name}\nrepoId: ${repo.repoId}\nsequence: ${repo.sequence}\nmanifest: ${repo.manifestHash ?? 'none'}`)
      return
    }
    case 'remote-url': {
      const name = positional(args, 0, 'repository name')
      const remoteUrl = repositoryRemoteUrl(name, networkPath)
      output(args, { remoteUrl }, remoteUrl)
      return
    }
    case 'archive-export': {
      const name = positional(args, 0, 'repository name or ID')
      const destination = resolve(positional(args, 1, 'archive destination'))
      const result = exportRepositoryArchive(name, store, destination)
      output(args, { ...result, destination }, `Exported ${result.chunks} chunks to ${destination}\narchive: ${result.archiveHash}`)
      return
    }
    case 'archive-import': {
      const source = resolve(positional(args, 0, 'archive source'))
      const result = importRepositoryArchive(source, store)
      output(args, result, `Recovered ${result.record.name} at sequence ${result.record.sequence}\narchive: ${result.archiveHash}`)
      return
    }
    case 'record-create': {
      const repo = store.getRepo(positional(args, 0, 'repository name or ID'))
      const kind = option(args, 'kind')
      if (!['pr', 'review', 'issue', 'comment', 'release'].includes(kind)) throw new Error(`Unsupported record kind: ${kind}`)
      const privateKey = process.env.DHEET_PRIVATE_KEY
      if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) {
        throw new Error('DHEET_PRIVATE_KEY must contain a 32-byte hex private key')
      }
      const existing = store.listCollaborationRecords(repo.repoId)
      const record = await createCollaborationRecord({
        repoId: repo.repoId,
        kind: kind as 'pr' | 'review' | 'issue' | 'comment' | 'release',
        sequence: existing.length + 1,
        nonce: existing.length,
        body: JSON.parse(option(args, 'body')) as unknown,
        privateKey: privateKey as `0x${string}`,
        chainId: Number(option(args, 'chain-id', '1')),
      })
      if (!(await verifyCollaborationRecord(record, Number(option(args, 'chain-id', '1'))))) {
        throw new Error('Generated collaboration signature did not verify')
      }
      store.appendCollaborationRecord(record)
      output(args, record, `Created ${record.kind} record ${record.id} at sequence ${record.sequence}`)
      return
    }
    case 'records': {
      const repo = store.getRepo(positional(args, 0, 'repository name or ID'))
      const kind = args.options.kind
      const records = store.listCollaborationRecords(repo.repoId).filter((record) => typeof kind !== 'string' || record.kind === kind)
      output(args, records, records.map((record) => `${record.sequence} ${record.kind} ${record.id} ${record.author}`).join('\n'))
      return
    }
    case 'renew': {
      const privateKey = process.env.DHEET_PRIVATE_KEY
      if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('DHEET_PRIVATE_KEY is invalid')
      const entityKeys = option(args, 'entities').split(',').map((value) => value.trim())
      if (entityKeys.some((value) => !/^0x[0-9a-f]{64}$/i.test(value))) throw new Error('Every entity key must be 32-byte hex')
      const connection = createArkivConnection({
        privateKey: privateKey as `0x${string}`,
        accessKey: option(args, 'access-key', process.env.ARKIV_ACCESS_KEY ?? ''),
      })
      const results = await renewArkivEntities({ entityKeys: entityKeys as `0x${string}`[], connection })
      output(args, results, results.map((result) => `${result.entityKey} → ${result.expiresAt} (${result.transactionHash})`).join('\n'))
      return
    }
    default:
      usage()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
