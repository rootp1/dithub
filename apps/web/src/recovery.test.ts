import { test, expect } from 'bun:test'
import { recoveryPanel } from './recovery.ts'

test('recovery UI distinguishes older snapshots, retrying, readiness, privacy and funding warnings', () => {
  const latest = { commit: '<script>', size: 3 * 1024 ** 2, verifiedAt: new Date().toISOString(), postageCheckedAt: new Date().toISOString(), postageExpiresEstimate: new Date(Date.now() + 30 * 86400_000).toISOString() }
  const pending = recoveryPanel({ state: 'pending', enabled: true, latest, coversLatest: false, job: { stage: 'retrying' } }, true, '/api/recovery')
  expect(pending).toContain('Newer changes are not covered')
  expect(pending).toContain('Retrying automatically')
  expect(pending).not.toContain('<script>')
  expect(pending).not.toContain('<button')
  const ready = recoveryPanel({ state: 'ready', enabled: true, latest, coversLatest: true }, true, '/api/recovery')
  expect(ready).toContain('Latest branches and tags backed up')
  expect(ready).toContain('Download recovery instructions')
  expect(ready).toContain('Back up now')
  expect(recoveryPanel({ state: 'ready', enabled: true, latest: { ...latest, postageWarning: 'expired' } }, false, '/r')).toContain('funding needs attention')
  expect(recoveryPanel({ state: 'private', enabled: false }, true, '/r')).not.toContain('Back up now')
})
