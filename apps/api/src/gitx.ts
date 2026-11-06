// git runner with per-call env and binary-safe input/output (the shared git() helper has a fixed env).
export interface GitxResult { code: number; out: string; err: string; buf: Buffer }
export async function gitx(dir: string, args: string[], opts: { env?: Record<string, string>; input?: string | Uint8Array } = {}): Promise<GitxResult> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], {
    stdin: opts.input === undefined ? 'ignore' : typeof opts.input === 'string' ? new TextEncoder().encode(opts.input) : opts.input,
    stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...(opts.env ?? {}) },
  })
  const [buf, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited])
  const b = Buffer.from(buf)
  return { code, out: b.toString('utf8'), err, buf: b }
}
