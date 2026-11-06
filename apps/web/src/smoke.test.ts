// Pure-function smoke tests (no DOM). Also statically guards app.ts against obvious unsafe patterns.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { esc, renderDiff, parseDiff, etherscanTx, isTxHash } from './helpers.ts'

const src = readFileSync(resolve(import.meta.dir, 'app.ts'), 'utf8')
const XSS = `"><img src=x onerror=alert(1)>'`

test('esc neutralises attribute and tag breakouts', () => {
  const o = esc(XSS)
  expect(o).not.toMatch(/[<>"']/)
})
test('diff renderer neutralises hostile file names and lines', () => {
  const h = renderDiff(parseDiff(`diff --git a/${XSS} b/${XSS}\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${XSS}\n+${XSS}\n`))
  expect(h).not.toContain('<img')
  expect(h).toContain('&lt;img')
})
test('etherscan links only for real tx hashes', () => {
  expect(etherscanTx('0x' + 'ab'.repeat(32))).toBe('https://basescan.org/tx/0x' + 'ab'.repeat(32))
  expect(isTxHash('0x12')).toBe(false)
})
test('app.ts never puts tokens in URLs and never uses document.write/eval', () => {
  expect(src).not.toMatch(/document\.write|eval\(|new Function/)
  expect(src).not.toMatch(/[?&](token|access_token)=/)
})
test('every scoped browse call goes through sapi (x-dheet-session)', () => {
  expect(src).toContain("'x-dheet-session'")
  for (const m of src.matchAll(/scoped\(`([^`]+)`/g)) expect(m[1]).toMatch(/^\/(tree|blob)/)
  expect(src).toMatch(/const scoped = \(p: string\) => sapi\(id,/)
})
test('template interpolations in app.ts innerHTML are escaped or known-safe', () => {
  // Heuristic: any ${...} inside a template that is not wrapped by esc()/helper calls and refers to raw user fields.
  const risky = [...src.matchAll(/\$\{(?:[a-z]+)\.(?:title|body|author|login|name|subject|answer|question|content|user)\}/g)].map((m) => m[0]).filter((x) => x !== '${r.name}') // r.name only feeds history.pushState
  expect(risky).toEqual([])
})
