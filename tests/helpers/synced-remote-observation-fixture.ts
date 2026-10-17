import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSyncedRemoteObservation, observeSyncedRemoteExposure, retrySyncedRemoteObservationCommit, disposeSyncedRemoteObservation } from '../../src/main/sync/synced-publication'
import { withPublicationFixture, prepared, publishInitialSyncedPublication, disposePreparedSyncedPublication, runtime, encode, hash,
  createRequest, created, applySyncedHostCommand, createRestoreInput, restoreCreated, restoreSyncedHostOperation,
  getSyncedCreateRestoreContext, allTables, totalChanges, snapshot, bodyId, a, b, born, now, ordinary, request, freshBlock, applySyncedHostFinal, editCreatedGroup,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, rejectedCode } from './synced-publication-fixture'
import { syncedLifecycleSemanticHash } from '../../src/main/database/synced-lifecycle-state'
import type { SyncedGroupWire } from '../../src/shared/synced-blocks'

export { openSyncedRemoteObservation, observeSyncedRemoteExposure, retrySyncedRemoteObservationCommit, disposeSyncedRemoteObservation,
  prepared, publishInitialSyncedPublication, disposePreparedSyncedPublication, runtime, encode, hash,
  createRequest, created, applySyncedHostCommand, createRestoreInput, restoreCreated, restoreSyncedHostOperation,
  getSyncedCreateRestoreContext, allTables, totalChanges, snapshot, bodyId, a, editCreatedGroup,
  readSyncedPublishedSnapshot, readSyncedPublishedSnapshotFacts, rejectedCode }
export type Observer = Extract<ReturnType<typeof openSyncedRemoteObservation>, { status: 'ready' }>['observation']
export type Observed = Extract<Awaited<ReturnType<typeof observeSyncedRemoteExposure>>, { status: 'observed' }>
type PublicationFixture = Parameters<Parameters<typeof withPublicationFixture>[0]>[0]
export type Replica = { db: Database.Database; file: string; userDataRoot: string }
export const manifestPath = '/Publication/manifest.json'
export const stableKey = (groupId: string, creationId: string) => 'synced:remote-exposure-observation:v1:' + groupId + ':' + creationId

type FixtureOptions = { asset?: boolean; secondCreate?: boolean; orphan?: boolean }
export async function withObservationFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: FixtureOptions = {}) {
  await withPublicationFixture(async outer => {
    const fixture = await setup(outer, options)
    try {
      assert.equal((fixture.db.prepare('SELECT count(*) AS n FROM synced_exposure_attempts').get() as { n: number }).n, 0)
      assert.equal((fixture.db.prepare('SELECT count(*) AS n FROM synced_group_exposure_members').get() as { n: number }).n, 0)
      await run(fixture); outer.server.assertNoHookErrors()
    } finally { await fixture.close() }
  })
}
async function setup(outer: PublicationFixture, options: FixtureOptions) {
  // A starts without unrelated groups/pins; the create itself is the authority.
  const source = outer.variant(27)
  const actualAssets: Array<{ name: string; bytes: Buffer }> = []
  let content = 'Original observation canonical body'
  if (options.asset) {
    const bytes = Buffer.from('actual observation asset bytes'), [asset] = await source.assets.import([{ name: 'observation actual.png', bytes }])
    actualAssets.push({ name: asset.name, bytes })
    content += ' ![asset](<' + asset.url + '>)'
  }
  source.db.prepare("UPDATE blocks SET content=?,tags_json='[]' WHERE id=?").run(content, bodyId(a))
  const createInput = createRequest(source.db), createAck = created(applySyncedHostCommand(source.db, createInput))
  let second: { input: ReturnType<typeof createRequest>; ack: ReturnType<typeof created> } | null = null
  if (options.secondCreate) {
    source.db.prepare('INSERT INTO documents(id,title,slug,path,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(b, 'Second observation host', 'second-observation', 'Home/Second observation host', '', born, now)
    ordinary(source.db, bodyId(b), { owner: b, type: 'paragraph' })
    source.db.prepare("UPDATE blocks SET content=?,tags_json='[]' WHERE id=?").run('Second independently created group', bodyId(b))
    const input = createRequest(source.db, { documentId: b, groupId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
    second = { input, ack: created(applySyncedHostCommand(source.db, input)) }
  }
  if (options.orphan) {
    const input = request(source.db, [a], after => { after[0].blocks = [freshBlock(randomUUID(), 'Explicit host paragraph after the last reference')] })
    assert.equal(applySyncedHostFinal(source.db, input).status, 'applied')
  }
  const connections: Database.Database[] = [], observers: Observer[] = [], jobs = new Set<Promise<unknown>>(), releases: Array<() => void> = []
  const replicaRoot = join(outer.root, 'replica-B-' + randomUUID()), file = join(replicaRoot, 'storage', 'knowbook.db')
  mkdirSync(dirname(file), { recursive: true })
  await source.db.backup(file) // Includes committed WAL; never copy only a live main file.
  const connect = (path = file) => { const db = new Database(path); db.pragma('foreign_keys=ON'); connections.push(db); return db }
  let current = connect()
  const track = <T>(promise: Promise<T>): Promise<T> => { jobs.add(promise); void promise.catch(() => {}); outer.track(promise); return promise }
  const open = (replica: Replica = { db: current, file, userDataRoot: replicaRoot }, target = outer.target) => {
    const value = openSyncedRemoteObservation(replica.db, { userDataRoot: replica.userDataRoot, target })
    assert.ok(value.status === 'ready', 'A real writable schema27 replica produces its opaque observer')
    if (value.status !== 'ready') throw new Error('A genuine observer is required')
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.observation), 'The public open shell and actual opaque identity are immutable without cloning the handle')
    observers.push(value.observation); return value.observation
  }
  return { outer, source, createInput, createAck, second, actualAssets, file, userDataRoot: replicaRoot, get db() { return current },
    get replica(): Replica { return { db: current, file, userDataRoot: replicaRoot } },
    server: outer.server, target: outer.target, connect, track, open,
    observe: (observer: Observer, signal?: AbortSignal) => track(observeSyncedRemoteExposure(observer, { ...runtime, ...(signal ? { signal } : {}) })),
    gateGet: (matches: (path: string) => boolean) => {
      const entered = outer.gate(), release = outer.gate(); let used = false
      releases.push(entered.release, release.release)
      outer.server.setHook(async request => {
        if (!used && request.method === 'GET' && matches(request.path)) { used = true; entered.release(); await release.promise }
      })
      return { entered: entered.promise, release: release.release,
        wait: (job: Promise<unknown>) => Promise.race([entered.promise, job.then(() => { throw new Error('The real HTTP job completed without reaching its expected gate') })]) }
    },
    publish: async () => {
      const handle = await prepared(source.db, source.input())
      try { assert.equal((await track(publishInitialSyncedPublication(source.db, handle, runtime))).status, 'confirmed') }
      finally { disposePreparedSyncedPublication(handle) }
      const bytes = outer.server.files.get(manifestPath)
      assert.ok(bytes, 'The actual sender publishes its original manifest before observation')
      return Buffer.from(bytes)
    },
    reopen: () => { if (current.open) current.close(); current = connect(); return current },
    closeConnections: () => { for (const db of connections) if (db.open) db.close() },
    childReopen: async (input: ReturnType<typeof createRestoreInput>['input']) => {
      for (const db of connections) if (db.open) db.close()
      const inputFile = join(outer.root, 'child-restore-' + randomUUID() + '.json')
      writeFileSync(inputFile, encode(input) + '\n', { flag: 'wx' })
      const script = resolve(dirname(fileURLToPath(import.meta.url)), 'synced-remote-observation-reopen-child.mjs')
      const args = ['--import', 'tsx', script, file, inputFile], started = new Date().toISOString()
      const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      const settled = track(new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
        child.once('error', reject); child.once('close', (status, signal) => resolveResult({ status, signal }))
      }))
      const result = await settled, output = Buffer.concat(stdout).toString(), errors = Buffer.concat(stderr).toString()
      assert.equal(result.status, 0, 'The actual current-source reopen child succeeds: ' + errors); assert.equal(result.signal, null)
      return { ...result, pid: child.pid, executable: process.execPath, args, cwd: process.cwd(), started, finished: new Date().toISOString(), scriptSHA256: hash(readFileSync(script)), inputSHA256: hash(readFileSync(inputFile)), stdout: output, stderr: errors, report: JSON.parse(output) as { status: string; beforeHash: string; afterHash: string; context: unknown; inverse: unknown } }
    },
    clone: async () => {
      const userDataRoot = join(outer.root, 'separate-file-' + randomUUID()), file = join(userDataRoot, 'storage', 'knowbook.db')
      mkdirSync(dirname(file), { recursive: true }); await current.backup(file)
      return { db: connect(file), file, userDataRoot }
    },
    close: async () => {
      // outer owns every gate and releases them before awaiting tracked promises.
      // Do that here as well, before these B connections are closed.
      outer.server.setHook(undefined)
      for (const observer of observers) disposeSyncedRemoteObservation(observer)
      releases.forEach(release => release())
      await Promise.allSettled([...jobs])
      for (const db of connections) if (db.open) db.close()
    }
  }
}

export function requireObserved(value: Awaited<ReturnType<typeof observeSyncedRemoteExposure>>): Observed {
  assert.ok(value.status === 'observed', 'A complete real remote closure is returned only after durable observation commit')
  if (value.status !== 'observed') throw new Error('Expected a real committed observation')
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.groups) && value.groups.every(group => Object.isFrozen(group)), 'Committed diagnostic results and every group entry are deeply readonly')
  return value
}
export function invariantTables(db: Database.Database) {
  const { synced_operations: _operations, synced_exposure_attempts: _attempts, synced_group_exposure_members: _members, synced_group_lifecycle: _lifecycle, ...rest } = allTables(db)
  return rest
}
export type Marker = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
export function marker(db: Database.Database, key: string): Marker {
  const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(key) as Marker | undefined
  assert.ok(row, 'The real observation commits its exact closed marker operation row'); return row
}
export function markerRows(db: Database.Database) {
  return db.prepare("SELECT * FROM synced_operations WHERE client_operation_id LIKE 'synced:remote-exposure-observation:v1:%' ORDER BY client_operation_id").all() as Marker[]
}
export function exposureRows(db: Database.Database) {
  return { attempts: db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(), members: db.prepare('SELECT * FROM synced_group_exposure_members ORDER BY attempt_id,group_id').all() }
}
export function localHash(db: Database.Database, groupId: string) {
  const value = snapshot(db, groupId), wire: SyncedGroupWire = { kind: 'synced-group', id: value.groupId, creationId: value.creationId, createdAt: value.createdAt, origin: value.origin, blocks: value.blocks, bindings: value.bindings }
  return syncedLifecycleSemanticHash(wire)
}
export function refusedRestore(db: Database.Database, context: ReturnType<typeof createRestoreInput>['input']) {
  const before = allTables(db), changes = totalChanges(db), result = restoreSyncedHostOperation(db, { ...context, clientOperationId: randomUUID() })
  assert.deepEqual(result, { status: 'unsupported', reason: 'lifecycle' })
  assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
}
type RawRecord = Record<string, any> // Only untrusted remote corruption fixtures; never an API authority.
export function remoteManifest(server: PublicationFixture['server']) {
  const bytes = server.files.get(manifestPath); assert.ok(bytes, 'Remote mutation starts from the actual sender manifest')
  return JSON.parse(bytes.toString()) as { version: number; workspaceId: string; entries: Record<string, string>; syncedInstances: Array<{ documentId: string; instanceId: string; groupId: string; groupHash: string }> }
}
export function alterRemoteRecord(server: PublicationFixture['server'], key: string, change: (record: RawRecord) => void) {
  const value = remoteManifest(server), old = server.files.get('/Publication/objects/' + value.entries[key] + '.json')
  assert.ok(old, 'Mutations begin at a real sender object, not caller-supplied observation facts')
  const record = JSON.parse(old.toString()) as RawRecord; change(record)
  const next = Buffer.from(encode(record)), digest = hash(next)
  server.files.set('/Publication/objects/' + digest + '.json', next); value.entries[key] = digest
  for (const instance of value.syncedInstances) if (key === 'group:' + instance.groupId) instance.groupHash = digest
  server.files.set(manifestPath, Buffer.from(encode(value)))
}
/** Independent literal wire oracle: hashes actual served Buffers; asset aliases
 * are known from this fixture's real import, never borrowed from observer facts. */
export function expectedClosure(server: PublicationFixture['server'], actualAssets: Array<{ name: string; bytes: Buffer }>) {
  const original = server.files.get(manifestPath); assert.ok(original, 'The closure oracle starts at the actual published manifest bytes')
  const manifest = remoteManifest(server)
  const records = Object.entries(manifest.entries).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, digest]) => {
    const bytes = server.files.get('/Publication/objects/' + digest + '.json'); assert.ok(bytes, 'Each independent closure record is present as actual HTTP bytes')
    assert.equal(hash(bytes), digest); return { key, hash: digest, bytes: bytes.length }
  })
  const assets = new Map<string, { path: string; hash: string; bytes: number; names: string[] }>()
  for (const item of actualAssets) {
    const digest = hash(item.bytes), path = 'assets/' + digest, bytes = server.files.get('/Publication/' + path)
    assert.ok(bytes, 'The actual sender uploaded this fixture attachment with independently known bytes and alias')
    assert.deepEqual(bytes, item.bytes); assert.equal(hash(bytes), digest)
    const entry = assets.get(path) ?? { path, hash: digest, bytes: bytes.length, names: [] }
    entry.names.push(item.name); assets.set(path, entry)
  }
  return hash(encode({ kind: 'synced-remote-initial-closure', version: 1, manifest: { hash: hash(original), bytes: original.length }, records,
    assets: [...assets.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map(entry => ({ ...entry, names: [...new Set(entry.names)].sort() })) }))
}
