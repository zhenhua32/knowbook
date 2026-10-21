import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { createV3Fixture, type V3Fixture } from './synced-backup-v3-fixture'
import { mkdirSync } from 'node:fs'
import { withPublicationFixture, prepared, publishInitialSyncedPublication, disposePreparedSyncedPublication, runtime } from './synced-publication-fixture'
import { openSyncedRemoteObservation, observeSyncedRemoteExposure, disposeSyncedRemoteObservation, type Observer } from './synced-remote-observation-fixture'

/** Real online backup and independent read-only connection. The existing
 * fixture owns the enclosing isolated root and its normal final cleanup. */
export async function withObserver2Copy<T>(source: Database.Database, sourceFile: string,
  run: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const file = join(dirname(sourceFile), 'capsule2-observer-' + randomUUID() + '.db')
  await source.backup(file)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { db.pragma('foreign_keys=ON'); db.pragma('query_only=ON'); return await run(db) }
  finally { db.close() }
}
/** A third real ordinary document, not the canonical target of f.groupId. */
export function writeObserver2Unrelated501(f: V3Fixture) {
  const id = f.store.createDocument(null), title = '独'.repeat(501), detail = f.store.getDocumentDetail(id)
  assert.ok(detail)
  f.store.updateDocument(id, { title, summary: 'Independent ordinary source', blocks: detail.blocks })
  assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE host_document_id=?').get(id), undefined)
  return { id, title }
}

/** Full Store schema is installed before the genuine Main create in
 * createV3Fixture. Existing group-bearing databases are never reopened as a
 * Store or repaired with ad-hoc DDL. Publication and observation still use
 * their actual Main HTTP APIs; only the enclosing fixture owns cleanup. */
export async function withFullStoreObservationFixture(run: (fixture: {
  db: Database.Database; file: string; createAck: V3Fixture['created']
  publish: () => Promise<void>; open: () => Observer
  observe: (observer: Observer) => Promise<Awaited<ReturnType<typeof observeSyncedRemoteExposure>>>
}) => Promise<void>): Promise<void> {
  await withPublicationFixture(async outer => {
    const source = createV3Fixture(join(outer.root, 'capsule2-observer-source-' + randomUUID()))
    const replicaRoot = join(outer.root, 'capsule2-observer-replica-' + randomUUID())
    const file = join(replicaRoot, 'storage', 'knowbook.db')
    const observers: Observer[] = [], jobs = new Set<Promise<unknown>>()
    let replica: Database.Database | undefined
    const track = <T>(promise: Promise<T>): Promise<T> => {
      jobs.add(promise); void promise.catch(() => {}); outer.track(promise); return promise
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      await source.db.backup(file)
      const db = new Database(file); replica = db
      db.pragma('foreign_keys=ON')
      await run({ db, file, createAck: source.created,
        publish: async () => {
          const handle = await prepared(source.db, { attemptId: randomUUID(), userDataRoot: source.userDataRoot, target: outer.target })
          try { assert.equal((await track(publishInitialSyncedPublication(source.db, handle, runtime))).status, 'confirmed') }
          finally { disposePreparedSyncedPublication(handle) }
          assert.ok(outer.server.files.get('/Publication/manifest.json'), 'The actual full Store sender publishes its original manifest before observation')
        },
        open: () => {
          const value = openSyncedRemoteObservation(db, { userDataRoot: replicaRoot, target: outer.target })
          assert.ok(value.status === 'ready', 'A real writable full Store schema27 replica produces its opaque observer')
          if (value.status !== 'ready') throw new Error('A genuine observer is required')
          assert.ok(Object.isFrozen(value) && Object.isFrozen(value.observation), 'The actual observer handle remains immutable')
          observers.push(value.observation); return value.observation
        },
        observe: observer => track(observeSyncedRemoteExposure(observer, { ...runtime }))
      })
      outer.server.assertNoHookErrors()
    } finally {
      for (const observer of observers) disposeSyncedRemoteObservation(observer)
      await Promise.allSettled([...jobs])
      try { if (replica?.open) replica.close() }
      finally { source.close() }
    }
  })
}
