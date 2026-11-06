import { describe, expect, test } from 'bun:test'
import { signSession, verifySession, sessionSecret } from './session-token.ts'

const secret = 'x'.repeat(32)
const other = 'y'.repeat(32)
const nowS = () => Math.floor(Date.now() / 1000)

describe('session tokens', () => {
  test('round trip', () => {
    const t = signSession({ uid: 7, ver: 2 }, secret)
    expect(t.startsWith('v1.')).toBe(true)
    const p = verifySession(t, { secret })
    expect(p?.uid).toBe(7)
    expect(p?.ver).toBe(2)
    expect(p!.exp).toBeGreaterThan(nowS())
  })

  test('rejects a tampered payload', () => {
    const t = signSession({ uid: 7, ver: 0 }, secret)
    const [v, , sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ uid: 1, ver: 0, exp: nowS() + 999 })).toString('base64url')
    expect(verifySession(`${v}.${forged}.${sig}`, { secret })).toBeNull()
  })

  test('rejects a tampered signature, wrong secret and malformed input', () => {
    const t = signSession({ uid: 7, ver: 0 }, secret)
    const flipped = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA')
    expect(verifySession(flipped, { secret })).toBeNull()
    expect(verifySession(t.slice(0, -4), { secret })).toBeNull()
    expect(verifySession(t, { secret: other })).toBeNull()
    expect(verifySession('v2' + t.slice(2), { secret })).toBeNull()
    expect(verifySession('garbage', { secret })).toBeNull()
    expect(verifySession('', { secret })).toBeNull()
    expect(verifySession('v1..', { secret })).toBeNull()
  })

  test('rejects expired tokens', () => {
    const t = signSession({ uid: 7, ver: 0, exp: nowS() - 1 }, secret)
    expect(verifySession(t, { secret })).toBeNull()
    const later = signSession({ uid: 7, ver: 0, exp: nowS() + 60 }, secret)
    expect(verifySession(later, { secret })).not.toBeNull()
    expect(verifySession(later, { secret, now: nowS() + 61 })).toBeNull()
  })

  test('rejects after a version bump', () => {
    const t = signSession({ uid: 7, ver: 3 }, secret)
    expect(verifySession(t, { secret, version: 3 })).not.toBeNull()
    expect(verifySession(t, { secret, version: 4 })).toBeNull()
  })

  test('rejects a non-integer payload even when signed', () => {
    const t = signSession({ uid: 1.5 as number, ver: 0 }, secret)
    expect(verifySession(t, { secret })).toBeNull()
  })

  test('dev fallback secret is stable within the process', () => {
    if (process.env.SESSION_SECRET) return
    const a = sessionSecret(), b = sessionSecret()
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
    expect(verifySession(signSession({ uid: 1, ver: 0 }), {})).not.toBeNull()
  })
})
