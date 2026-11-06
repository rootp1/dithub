// Test-only stand-in for apps/api/src/sessions.ts (same contract). Used by e2e-assistant.ts when the real module is absent.
export interface StubSession { id: string; repoId: number; repoIdHex: string; issueId: number; issueNumber: number; userId: number; role: 'contractor' | 'employee' | 'maintainer'; allowedPaths: string[]; ref: string; expiresAt: Date }
export const stubSessions = new Map<string, StubSession>()
export const stubEvents: { sessionId: string; actorId: number | null; kind: string; detail: Record<string, unknown> }[] = []
export async function loadSessionForUser(sessionId: string, userId: number) {
  const s = stubSessions.get(sessionId)
  return s && s.userId === userId ? s : null
}
export const pathInScope = (allowed: string[], path: string) => allowed.some((a) => (a.endsWith('/') ? path.startsWith(a) : path === a || path.startsWith(a + '/')))
export async function logSessionEvent(sessionId: string, actorId: number | null, kind: string, detail: Record<string, unknown>) { stubEvents.push({ sessionId, actorId, kind, detail }) }
