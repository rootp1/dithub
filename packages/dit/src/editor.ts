import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DitError } from './errors.ts'

/** Open $GIT_EDITOR/$VISUAL/$EDITOR on a temp file seeded with `initial`; lines starting with "#" are dropped. */
export function editText(initial: string): string {
  if (!process.stdin.isTTY) throw new DitError('no title/body given and there is no terminal to open an editor', 2, 'Pass -t/--title and -b/--body.')
  const editor = process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR || 'vi'
  const dir = mkdtempSync(join(tmpdir(), 'dit-edit-'))
  const file = join(dir, 'MESSAGE.md')
  try {
    writeFileSync(file, initial, { mode: 0o600 })
    const r = spawnSync('sh', ['-c', `${editor} "$1"`, 'dit-editor', file], { stdio: 'inherit' })
    if (r.status !== 0) throw new DitError('editor exited with an error; aborting')
    return readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** First line is the title, the rest (after a blank line) the body. */
export function splitTitleBody(text: string): { title: string; body: string } {
  const [first = '', ...rest] = text.split('\n')
  return { title: first.trim(), body: rest.join('\n').trim() }
}
