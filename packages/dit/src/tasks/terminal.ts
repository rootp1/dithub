import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { DitError, UsageError } from '../errors.ts'
import type { Change } from './core.ts'
import type { Draft } from './drafts.ts'

export async function prompt(label: string, fallback = ''): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError('this step needs a terminal', 'Supply the required flags; use --yes to confirm reviewed changes in scripts.')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try { return (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback }
  finally { rl.close() }
}

export async function confirm(label: string, yes: boolean): Promise<void> {
  if (yes) return
  if (!/^(y|yes)$/i.test(await prompt(`${label} [y/N]`))) throw new DitError('cancelled; no changes were submitted')
}

/** Source editing must preserve # lines, whitespace and final newlines exactly. */
export function editSource(path: string, content: string): string {
  if (!process.stdin.isTTY) throw new UsageError('editing needs a terminal', 'Use --from <file> or --from - to read UTF-8 text from stdin.')
  const dir = mkdtempSync(join(tmpdir(), 'dit-task-edit-'))
  const file = join(dir, basename(path))
  try {
    writeFileSync(file, content, { mode: 0o600 })
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
    const result = spawnSync('sh', ['-c', `${editor} "$1"`, 'dit-task-editor', file], { stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new DitError('editor failed; the previous draft was kept')
    return decodeText(readFileSync(file))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength > 1_000_000 || bytes.includes(0)) throw new DitError('task files must be UTF-8 text of at most 1 MB')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new DitError('task files must be valid UTF-8 text') }
}

export function taskDiff(changes: Change[], drafts: Record<string, Draft>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dit-task-diff-'))
  try {
    return changes.map((change) => {
      const d = drafts[change.path]!
      const before = `a/${change.path}`, after = `b/${change.path}`
      for (const [path, content] of [[before, d.original ?? ''], [after, d.content]]) {
        mkdirSync(dirname(join(dir, path!)), { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, path!), content!, { mode: 0o600 })
      }
      const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', d.original === null ? '/dev/null' : before, after], { cwd: dir, encoding: 'utf8', maxBuffer: 8_000_000 })
      if (r.error || (r.status !== 0 && r.status !== 1)) throw new DitError(`could not produce the diff: ${r.error?.message ?? r.stderr}`)
      return r.stdout.replace(/^(diff --git |--- |\+\+\+ |index ).*$/gm, (line) => line.replace(/\ba\/a\//g, 'a/').replace(/\bb\/b\//g, 'b/').replace(/\ba\/b\//g, 'a/'))
    }).join('')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
