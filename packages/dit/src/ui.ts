// Output helpers: colour only on a TTY with NO_COLOR unset, tables, JSON.
const colorOn = (stream: { isTTY?: boolean }) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const wrap = (code: string, on: () => boolean) => (s: string) => (on() ? `\x1b[${code}m${s}\x1b[0m` : s)
const out = () => colorOn(process.stdout), err = () => colorOn(process.stderr)

export const c = {
  bold: wrap('1', out), dim: wrap('2', out), red: wrap('31', out), green: wrap('32', out), yellow: wrap('33', out), cyan: wrap('36', out), magenta: wrap('35', out),
}
export const e = {
  bold: wrap('1', err), red: wrap('31', err), yellow: wrap('33', err), dim: wrap('2', err),
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

export function printJson(v: unknown): void { process.stdout.write(JSON.stringify(v, null, 2) + '\n') }
export const info = (msg: string) => process.stderr.write(msg + '\n')

/** Left-aligned table. Colour codes in cells do not count towards width. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - stripAnsi(cell).length))).join('  ').trimEnd()
  return [c.bold(line(headers)), ...rows.map(line)].join('\n')
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function countdown(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000)
  if (s <= 0) return 'expired'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m left` : `${m}m ${s % 60}s left`
}

export const short = (hex: string | null | undefined, n = 10) => (hex ? hex.replace(/^0x/, '').slice(0, n) : '-')
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
