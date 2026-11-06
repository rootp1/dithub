#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { LocalNetworkStore } from '../../sdk/src/local-store.ts'

export function buildIndex(networkPath: string, databasePath: string): Database {
  const store = new LocalNetworkStore(networkPath)
  const database = new Database(databasePath, { create: true })
  database.run('PRAGMA journal_mode = WAL')
  database.run(`CREATE TABLE IF NOT EXISTS repositories (
    repo_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, sequence INTEGER NOT NULL,
    manifest_hash TEXT, object_root TEXT, object_count INTEGER NOT NULL,
    refs_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    kind TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL,
    body_json TEXT NOT NULL, signature TEXT NOT NULL,
    UNIQUE(repo_id, sequence)
  )`)
  const upsertRepo = database.prepare(`INSERT INTO repositories
    (repo_id,name,sequence,manifest_hash,object_root,object_count,refs_json,updated_at)
    VALUES ($repoId,$name,$sequence,$manifestHash,$objectRoot,$objectCount,$refsJson,$updatedAt)
    ON CONFLICT(repo_id) DO UPDATE SET name=excluded.name,sequence=excluded.sequence,
    manifest_hash=excluded.manifest_hash,object_root=excluded.object_root,
    object_count=excluded.object_count,refs_json=excluded.refs_json,updated_at=excluded.updated_at`)
  const upsertRecord = database.prepare(`INSERT INTO records
    (id,repo_id,sequence,kind,author,created_at,body_json,signature)
    VALUES ($id,$repoId,$sequence,$kind,$author,$createdAt,$bodyJson,$signature)
    ON CONFLICT(id) DO NOTHING`)
  database.transaction(() => {
    for (const repo of store.listRepositories()) {
      const manifest = repo.manifestHash ? store.getManifest(repo.manifestHash) : null
      upsertRepo.run({
        repoId: repo.repoId,
        name: repo.name,
        sequence: repo.sequence,
        manifestHash: repo.manifestHash,
        objectRoot: manifest?.objectRoot ?? null,
        objectCount: manifest?.objects.length ?? 0,
        refsJson: JSON.stringify(repo.refs),
        updatedAt: repo.updatedAt,
      })
      for (const record of store.listCollaborationRecords(repo.repoId)) {
        upsertRecord.run({
          id: record.id,
          repoId: record.repoId,
          sequence: record.sequence,
          kind: record.kind,
          author: record.author,
          createdAt: record.createdAt,
          bodyJson: JSON.stringify(record.body),
          signature: record.signature,
        })
      }
    }
  })()
  return database
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } })
}

export function startIndexer(args: { networkPath: string; databasePath: string; port: number; webRoot?: string }) {
  const database = buildIndex(args.networkPath, args.databasePath)
  const webRoot = resolve(args.webRoot ?? 'packages/web/dist')
  return Bun.serve({
    port: args.port,
    routes: {
      '/api/health': () => json({ ok: true }),
      '/api/repos': () => json(database.query('SELECT * FROM repositories ORDER BY updated_at DESC').all()),
      '/api/repos/:repo': (request) => {
        const repo = database.query('SELECT * FROM repositories WHERE repo_id = ? OR name = ?').get(request.params.repo, request.params.repo)
        if (!repo) return json({ error: 'Repository not found' }, 404)
        const records = database.query('SELECT * FROM records WHERE repo_id = ? ORDER BY sequence ASC').all((repo as { repo_id: string }).repo_id)
        return json({ repo, records })
      },
    },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const target = resolve(webRoot, relative)
      if (!target.startsWith(`${webRoot}/`) && target !== join(webRoot, 'index.html')) return new Response('Forbidden', { status: 403 })
      const fallback = join(webRoot, 'index.html')
      const file = Bun.file(existsSync(target) ? target : fallback)
      if (!(await file.exists())) return new Response('Explorer is not built', { status: 404 })
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
      return new Response(file, { headers: { 'content-type': types[extname(file.name ?? '')] ?? 'application/octet-stream' } })
    },
  })
}

if (import.meta.main) {
  const networkPath = resolve(process.env.DHEET_NETWORK ?? '.dheet-network')
  const databasePath = resolve(process.env.DHEET_INDEX ?? join(networkPath, 'index.sqlite'))
  const port = Number(process.env.PORT ?? '8787')
  const server = startIndexer({ networkPath, databasePath, port })
  console.log(`Dheet indexer and explorer listening on ${server.url}`)
}
