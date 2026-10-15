import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { DatabaseEmbedSnapshot } from '../src/shared/contracts'
import { databaseEmbedSnapshots } from '../src/renderer/src/features/database/model/databaseEmbedSnapshots'
import { coordinateDatabaseCellWrite, coordinateDatabaseCellWrites } from '../src/renderer/src/features/database/model/databaseCellWrites'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const missing = (databaseId: string): DatabaseEmbedSnapshot => ({ status: 'missing', databaseId })
async function withSnapshots(run: (state: {
  reads: Array<ReturnType<typeof deferred<DatabaseEmbedSnapshot>> & { id: string }>;
  subscribe: (id: string, listener?: () => void) => () => void; mutate: () => void; subscriptions: () => number
}) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const reads: Array<ReturnType<typeof deferred<DatabaseEmbedSnapshot>> & { id: string }> = []
  const observers = new Set<() => void>(), disposers = new Set<() => void>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
    getDatabaseEmbedSnapshot: (id: string) => { const read = { id, ...deferred<DatabaseEmbedSnapshot>() }; reads.push(read); return read.promise },
    onWorkspaceMutated: (listener: () => void) => { observers.add(listener); return () => observers.delete(listener) }
  } } })
  try {
    await run({ reads, subscribe: (id, listener = () => {}) => {
      const dispose = databaseEmbedSnapshots.subscribe(id, listener); disposers.add(dispose)
      return () => { disposers.delete(dispose); dispose() }
    }, mutate: () => observers.forEach(listener => listener()), subscriptions: () => observers.size })
  } finally {
    disposers.forEach(dispose => dispose())
    for (const read of reads) read.resolve(missing(read.id))
    await setImmediate()
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('two inline hosts share one atomic source request and one event subscription while remaining independently subscribed', async () => {
  await withSnapshots(async ({ reads, subscribe, subscriptions }) => {
    let first = 0, second = 0
    const stopFirst = subscribe('shared', () => first++), stopSecond = subscribe('shared', () => second++)
    assert.equal(reads.length, 1); assert.equal(subscriptions(), 1)
    const refresh = databaseEmbedSnapshots.refresh('shared')
    reads[0].resolve(missing('shared')); assert.deepEqual(await refresh, missing('shared'))
    assert.equal(first, 1); assert.equal(second, 1)
    assert.equal(databaseEmbedSnapshots.state('shared').status, 'ready')
    stopFirst(); assert.equal(subscriptions(), 1)
    stopSecond(); assert.equal(subscriptions(), 0)
    subscribe('shared'); assert.equal(reads.length, 2, 'a new document session must not retain a previous session cache')
  })
})

test('workspace mutations invalidate in-flight reads and publish only the newest source generation', async () => {
  await withSnapshots(async ({ reads, subscribe, mutate }) => {
    let publications = 0
    subscribe('source', () => publications++)
    const current = databaseEmbedSnapshots.refresh('source')
    mutate(); mutate()
    reads[0].resolve(missing('obsolete-result'))
    await setImmediate()
    assert.equal(publications, 0); assert.equal(reads.length, 2)
    assert.equal(reads[1].id, 'source')
    reads[1].resolve(missing('current-result'))
    assert.deepEqual(await current, missing('current-result'))
    assert.equal(publications, 1)
    assert.deepEqual(databaseEmbedSnapshots.state('source').snapshot, missing('current-result'))
  })
})

test('a failed source refresh retains its last valid snapshot and can be retried without a poisoned promise', async () => {
  await withSnapshots(async ({ reads, subscribe }) => {
    subscribe('source')
    reads[0].resolve(missing('source')); await setImmediate()
    const failed = databaseEmbedSnapshots.invalidate('source')
    reads[1].reject(new Error('Permission denied'))
    await assert.rejects(failed, /Permission denied/)
    assert.equal(databaseEmbedSnapshots.state('source').status, 'error')
    assert.deepEqual(databaseEmbedSnapshots.state('source').snapshot, missing('source'))
    const retry = databaseEmbedSnapshots.refresh('source')
    reads[2].resolve(missing('recovered'))
    await retry
    assert.equal(databaseEmbedSnapshots.state('source').status, 'ready')
    assert.equal(databaseEmbedSnapshots.state('source').error, undefined)
    assert.deepEqual(databaseEmbedSnapshots.state('source').snapshot, missing('recovered'))
  })
})

test('unsubscribed source reads cannot publish into a newly mounted source cache with the same ID', async () => {
  await withSnapshots(async ({ reads, subscribe }) => {
    const old = subscribe('same'); old()
    let publications = 0
    subscribe('same', () => publications++)
    reads[0].resolve(missing('old-session')); await setImmediate()
    assert.equal(publications, 0); assert.equal(databaseEmbedSnapshots.state('same').snapshot, undefined)
    reads[1].resolve(missing('new-session')); await setImmediate()
    assert.equal(publications, 1); assert.deepEqual(databaseEmbedSnapshots.state('same').snapshot, missing('new-session'))
  })
})

test('returning to an inactive source refreshes mutations observed while another source kept the document cache alive', async () => {
  await withSnapshots(async ({ reads, subscribe, mutate }) => {
    const stopFirst = subscribe('first'); subscribe('second')
    reads[0].resolve(missing('first-old')); reads[1].resolve(missing('second')); await setImmediate()
    stopFirst(); mutate()
    assert.equal(reads.length, 3); assert.equal(reads[2].id, 'second')
    subscribe('first'); assert.equal(reads.length, 4); assert.equal(reads[3].id, 'first')
    reads[2].resolve(missing('second-new')); reads[3].resolve(missing('first-new')); await setImmediate()
    assert.deepEqual(databaseEmbedSnapshots.state('first').snapshot, missing('first-new'))
  })
})

test('physical writes serialize the same source record field, recover after failure and do not block different cells', async () => {
  const first = deferred<void>(), second = deferred<void>(), events: string[] = []
  const firstWrite = coordinateDatabaseCellWrite('source', 'record', 'notes', () => { events.push('first'); return first.promise })
  const caught = firstWrite.catch(error => error)
  const secondWrite = coordinateDatabaseCellWrite('source', 'record', 'notes', () => { events.push('second'); return second.promise })
  const independent = coordinateDatabaseCellWrite('source', 'record', 'other', async () => { events.push('independent') })
  await independent
  assert.deepEqual(events, ['first', 'independent'])
  first.reject(new Error('First failed')); assert.match(String(await caught), /First failed/)
  await setImmediate(); assert.deepEqual(events, ['first', 'independent', 'second'])
  second.resolve(); await secondWrite
  await coordinateDatabaseCellWrite('source', 'record', 'notes', async () => { events.push('third') })
  assert.deepEqual(events, ['first', 'independent', 'second', 'third'])
})

test('multi-cell writes synchronously reserve all unique keys and keep each original IPC atomic without lock-order deadlocks', async () => {
  const first = deferred<void>(), batch = deferred<void>(), events: string[] = []
  const cells = [{ recordId: 'row', fieldId: 'a' }, { recordId: 'row', fieldId: 'b' }]
  const one = coordinateDatabaseCellWrite('batch-source', 'row', 'a', () => { events.push('first'); return first.promise })
  const atomic = coordinateDatabaseCellWrites('batch-source', [cells[1], cells[0], cells[0]], () => { events.push('batch'); return batch.promise })
  const later = coordinateDatabaseCellWrites('batch-source', cells, async () => { events.push('later') })
  const peer = coordinateDatabaseCellWrite('batch-source', 'row', 'b', async () => { events.push('peer') })
  await setImmediate(); assert.deepEqual(events, ['first'])
  first.resolve(); await one; await setImmediate(); assert.deepEqual(events, ['first', 'batch'])
  batch.resolve(); await Promise.all([atomic, later, peer])
  assert.deepEqual(events, ['first', 'batch', 'later', 'peer'])
})
