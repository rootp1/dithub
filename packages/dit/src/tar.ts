// Safe tar extraction (ustar + pax + GNU long names). Anything that could write outside the target is rejected.
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, posix, resolve, sep } from 'node:path'
import { DitError } from './errors.ts'

export interface TarEntry { path: string; type: 'file' | 'dir' | 'symlink' | 'other'; mode: number; data: Buffer; linkname: string }

const MAX_TOTAL = 1024 * 1024 * 1024

const str = (b: Buffer) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString('utf8') }
const oct = (b: Buffer) => {
  if (b[0]! & 0x80) { let n = 0; for (let i = 1; i < b.length; i++) n = n * 256 + b[i]!; return n }   // base-256
  const s = str(b).trim(); return s ? parseInt(s, 8) : 0
}

export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let off = 0, nextPath: string | null = null, nextLink: string | null = null, total = 0
  let globalPax: Record<string, string> = {}
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((x) => x === 0)) break
    const size = oct(h.subarray(124, 136)), typeflag = String.fromCharCode(h[156] || 48)
    // checksum
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
    if (sum !== oct(h.subarray(148, 156))) throw new DitError('corrupt tar archive (bad header checksum)')
    total += size
    if (total > MAX_TOTAL) throw new DitError('archive is unreasonably large; refusing to extract')
    const data = buf.subarray(off + 512, off + 512 + size)
    if (data.length < size) throw new DitError('truncated tar archive')
    off += 512 + Math.ceil(size / 512) * 512
    if (typeflag === 'x' || typeflag === 'g') {
      const rec: Record<string, string> = {}
      let p = 0
      while (p < data.length) {
        const sp = data.indexOf(0x20, p); if (sp < 0) break
        const len = parseInt(data.subarray(p, sp).toString(), 10); if (!len) break
        const kv = data.subarray(sp + 1, p + len - 1).toString('utf8'), eq = kv.indexOf('=')
        if (eq > 0) rec[kv.slice(0, eq)] = kv.slice(eq + 1)
        p += len
      }
      if (typeflag === 'g') globalPax = { ...globalPax, ...rec }
      else { if (rec.path) nextPath = rec.path; if (rec.linkpath) nextLink = rec.linkpath }
      continue
    }
    if (typeflag === 'L') { nextPath = str(data); continue }
    if (typeflag === 'K') { nextLink = str(data); continue }
    const prefix = str(h.subarray(345, 500))
    let path = nextPath ?? globalPax.path ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)))
    const linkname = nextLink ?? str(h.subarray(157, 257))
    nextPath = null; nextLink = null
    const type: TarEntry['type'] = typeflag === '0' || typeflag === '\0' || typeflag === '7' ? 'file' : typeflag === '5' ? 'dir' : typeflag === '2' ? 'symlink' : 'other'
    if (type === 'other') throw new DitError(`archive contains an unsupported entry type "${typeflag}" for ${path}; refusing to extract`)
    if (type === 'dir') path = path.replace(/\/+$/, '')
    entries.push({ path, type, mode: oct(h.subarray(100, 108)) & 0o777, data: Buffer.from(data), linkname })
  }
  return entries
}

/** Validate a member path: relative, no "..", no empty/odd segments, no .git, no backslashes or NULs. */
export function checkMemberPath(p: string): string {
  if (!p || p.includes('\0') || p.includes('\\')) throw new DitError(`unsafe path in archive: ${JSON.stringify(p)}`)
  if (isAbsolute(p) || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new DitError(`archive contains an absolute path: ${p}`)
  const segs = p.split('/')
  for (const s of segs) {
    if (s === '..') throw new DitError(`archive path escapes the target directory: ${p}`)
    if (s === '') throw new DitError(`unsafe path in archive: ${JSON.stringify(p)}`)
    if (s.toLowerCase() === '.git') throw new DitError(`archive contains a .git entry: ${p}`)
  }
  const n = posix.normalize(p)
  if (n.startsWith('..')) throw new DitError(`archive path escapes the target directory: ${p}`)
  return n === '.' ? '' : n
}

/** A symlink is allowed only if it is relative and resolves inside the root. */
export function checkSymlink(root: string, memberPath: string, linkname: string): void {
  if (!linkname || linkname.includes('\0') || isAbsolute(linkname) || linkname.startsWith('/')) throw new DitError(`archive contains a symlink with an absolute target: ${memberPath} -> ${linkname}`)
  const resolved = resolve(root, dirname(memberPath), linkname)
  if (resolved !== resolve(root) && !resolved.startsWith(resolve(root) + sep)) throw new DitError(`archive contains a symlink that escapes the target directory: ${memberPath} -> ${linkname}`)
}

/** Extract into `root` (created if needed). Validates everything before writing the first byte. */
export function extractTar(buf: Buffer, root: string): { files: number } {
  const entries = parseTar(buf)
  const rootAbs = resolve(root)
  const plan = entries.map((e) => ({ ...e, rel: checkMemberPath(e.path) })).filter((e) => e.rel !== '')
  const seen = new Set<string>()
  for (const e of plan) {
    if (seen.has(e.rel)) throw new DitError(`archive lists ${e.rel} twice; refusing to extract`)
    seen.add(e.rel)
    if (e.type === 'symlink') checkSymlink(rootAbs, e.rel, e.linkname)
  }
  // A file may not be written below a path that the archive itself makes a symlink.
  const links = plan.filter((e) => e.type === 'symlink').map((e) => e.rel)
  for (const e of plan) if (links.some((l) => e.rel.startsWith(l + '/'))) throw new DitError(`archive writes through a symlink: ${e.rel}`)

  mkdirSync(rootAbs, { recursive: true })
  let files = 0
  for (const e of plan) {
    const dest = join(rootAbs, e.rel)
    if (!normalize(dest).startsWith(rootAbs + sep)) throw new DitError(`archive path escapes the target directory: ${e.path}`)
    mkdirSync(e.type === 'dir' ? dest : dirname(dest), { recursive: true })
    for (let d = e.type === 'dir' ? dest : dirname(dest); d.length > rootAbs.length; d = dirname(d)) if (lstatSync(d).isSymbolicLink()) throw new DitError(`refusing to write through symlink ${d}`)
    if (e.type === 'file') {
      if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new DitError(`refusing to overwrite symlink ${e.rel}`)
      writeFileSync(dest, e.data, { mode: e.mode & 0o755 || 0o644, flag: 'wx' }); chmodSync(dest, e.mode & 0o111 ? 0o755 : 0o644); files++
    }
  }
  for (const e of plan) if (e.type === 'symlink') { symlinkSync(e.linkname, join(rootAbs, e.rel)); files++ }
  return { files }
}
