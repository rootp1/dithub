// The outbox worker and the deployments mirror write to Arkiv from the same relayer wallet. Concurrent transactions collide on the
// nonce ("Execution error without revert data"), so every Arkiv write section runs through this single in-process queue.
let tail: Promise<unknown> = Promise.resolve()

export function withArkivLock<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work)
  tail = result.catch(() => undefined)
  return result
}
