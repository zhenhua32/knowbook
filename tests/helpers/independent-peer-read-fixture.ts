import assert from 'node:assert/strict'
import { readonlyRequests } from './synced-initial-incoming-fixture'
import type { createPublicationHttpServer } from './synced-publication-http-fixture'

type Server = Pick<Awaited<ReturnType<typeof createPublicationHttpServer>>, 'files' | 'requests'>

/** Only two independent profile consumers of an already published snapshot.
 * Both settle before fixture cleanup. HTTP reads and every remote byte are
 * checked, so this cannot overlap a producer with its dependent receiver. */
export async function independentPeerReads<A, B>(server: Server, phase: string,
  operations: readonly [() => Promise<A>, () => Promise<B>]): Promise<readonly [A, B]> {
  const before = [...server.files].map(([path, bytes]) => [path, Buffer.from(bytes)] as const)
  const requestStart = server.requests.length, startedAt = performance.now()
  const [first, second] = await Promise.allSettled([
    Promise.resolve().then(operations[0]), Promise.resolve().then(operations[1])
  ])
  console.log('[independent-peer-reads]', JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - startedAt),
    requests: server.requests.length - requestStart }))
  readonlyRequests(server.requests.slice(requestStart))
  assert.deepEqual([...server.files], before, 'Both independent profile reads preserve the complete original remote file map and bytes')
  if (first.status === 'rejected') throw first.reason
  if (second.status === 'rejected') throw second.reason
  return [first.value, second.value]
}
