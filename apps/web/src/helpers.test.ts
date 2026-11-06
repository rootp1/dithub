import { expect, test } from 'bun:test'
import { avatarHtml, avatarHue, countdown, esc, isPlaceholderLogin, isTxHash, parseDiff, parsePaths, renderDiff, usernameProblem } from './helpers.ts'

test('esc escapes all html metacharacters', () => {
  expect(esc(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;')
  expect(esc(null)).toBe('')
})
test('parsePaths', () => { expect(parsePaths(' src/payments/ \n\nlib\n')).toEqual(['src/payments', 'lib']) })
test('countdown', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  expect(countdown('2026-01-01T01:02:03Z', now)).toBe('1:02:03')
  expect(countdown('2025-12-31T00:00:00Z', now)).toBe('expired')
  expect(countdown('garbage', now)).toBe('expired')
})
test('isTxHash', () => { expect(isTxHash('0x' + 'a'.repeat(64))).toBe(true); expect(isTxHash('javascript:alert(1)')).toBe(false) })
const D = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 keep
-old <script>
+new <b>
diff --git a/x b/x
new file mode 100644
--- /dev/null
+++ b/x
@@ -0,0 +1 @@
+--- looks like header
`
test('parseDiff counts and kinds', () => {
  const f = parseDiff(D)
  expect(f.map((x) => [x.path, x.additions, x.deletions])).toEqual([['src/a.ts', 1, 1], ['x', 1, 0]])
  expect(f[0]!.lines.filter((l) => l.kind === 'hunk').length).toBe(1)
})
test('renderDiff escapes content', () => {
  const h = renderDiff(parseDiff(D))
  expect(h).not.toContain('<script>'); expect(h).not.toContain('<b>')
  expect(h).toContain('&lt;script&gt;')
  expect(renderDiff(parseDiff('diff --git a/"><img onerror=1> b/"><img onerror=1>\n'))).not.toContain('<img')
  expect(parseDiff('')).toEqual([])
})

test('usernameProblem mirrors the API rule and refuses route names', () => {
  expect(usernameProblem('arnav-dev')).toBeNull()
  expect(usernameProblem('a')).toBeNull()
  expect(usernameProblem('')).not.toBeNull()
  expect(usernameProblem('Arnav')).toMatch(/lowercase/)
  expect(usernameProblem('-bad')).not.toBeNull()
  expect(usernameProblem('bad-')).not.toBeNull()
  expect(usernameProblem('has space')).not.toBeNull()
  expect(usernameProblem('a'.repeat(40))).not.toBeNull()
  expect(usernameProblem('a'.repeat(39))).toBeNull()
  expect(usernameProblem('docs')).toMatch(/reserved/)
  expect(usernameProblem('settings')).toMatch(/reserved/)
})
test('isPlaceholderLogin detects the auto-created name only', () => {
  const w = '0x1A2b3C4d5E6f708192a3B4c5D6e7F8091a2B3c4D'
  expect(isPlaceholderLogin('u-1a2b3c4d', w)).toBe(true)
  expect(isPlaceholderLogin('arnav', w)).toBe(false)
  expect(isPlaceholderLogin('u-1a2b3c4d', null)).toBe(false)
})
test('avatarHue is stable and in range; avatarHtml escapes', () => {
  expect(avatarHue('arnav')).toBe(avatarHue('arnav'))
  expect(avatarHue('arnav')).toBeGreaterThanOrEqual(0)
  expect(avatarHue('arnav')).toBeLessThan(360)
  expect(avatarHtml('<script>')).not.toContain('<script>')
  expect(avatarHtml('')).toContain('>?<')
})
