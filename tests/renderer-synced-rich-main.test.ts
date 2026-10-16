import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { EditorState, type Transaction } from 'prosemirror-state'
import type { SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedGroupMutationResult, SyncedGroupSnapshot,
  SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { getSyncedGroupSnapshots, getSyncedHostHistory, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { getSyncedOperation, restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { seedSyncedRichProvenance, prepareSyncedRichProvenance, setRichNewLinkIntent,
  type RichProvenanceState } from '../src/renderer/src/rich-text/richProvenance'
import { richLinkOccurrence, withRichLinkOccurrence } from '../src/renderer/src/rich-text/linkProvenance'
import { initialize, snapshot, state as sqlState, groupId, other, born, now } from './helpers/synced-content-fixture'

/** All persistence and operation lookups cross the real SQLite repositories.
 * No renderer fixture invents a target, ACK, revision, or history side. */
class MainPort implements SyncedBlocksApi {
  readonly updates: SyncedUpdateGroupInput[] = []
  readonly restores: SyncedRestoreGroupInput[] = []
  readonly lookups: string[] = []
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  dropNextAck = false
  constructor(readonly db: Database.Database) {}
  async getSyncedGroupSnapshots(input: { groupIds: string[] }) { return getSyncedGroupSnapshots(this.db, input) }
  async listSyncedGroups(input: { query: string; offset: number; limit: number }) { return listSyncedGroups(this.db, input) }
  async getSyncedHostHistory(input: { documentId: string }) { return getSyncedHostHistory(this.db, input) }
  async getSyncedOperation(input: { clientOperationId: string }) { this.lookups.push(input.clientOperationId); return getSyncedOperation(this.db, input) }
  private committed(result: SyncedGroupMutationResult) {
    assert.equal(this.db.inTransaction, false)
    if (result.status !== 'saved' || result.replayed) return
    for (const listener of this.listeners) listener({ operationId: result.operationId, affectedInstanceIds: result.snapshot.instances.map(item => item.instanceId),
      changes: [{ groupId, revision: result.snapshot.revision, topologyRevision: result.snapshot.topologyRevision, kind: 'content' }] })
  }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) {
    this.updates.push(structuredClone(input))
    const result = updateSyncedBlockGroup(this.db, input); this.committed(result)
    if (this.dropNextAck && result.status === 'saved') { this.dropNextAck = false; throw new Error('Lost delivery after actual COMMIT') }
    return result
  }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput) {
    this.restores.push(structuredClone(input)); const result = restoreSyncedGroupOperation(this.db, input); this.committed(result); return result
  }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> { throw new Error('No structure writer in this slice') }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> { throw new Error('No host history in this slice') }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}
function scope(value: SyncedGroupSnapshot): SyncedGroupScope {
  const instance = value.instances[0]
  assert.ok(instance)
  return { owner: { kind: 'synced-group', groupId }, instanceId: instance.instanceId, bindingVersion: instance.bindingVersion,
    hostDocumentId: instance.hostDocumentId, windowSessionId: 'real-repository-test-client', hostSession: {}, mountEpoch: {}, bindingEpoch: {},
    domNamespace: randomUUID(), root: () => null, isCurrent: () => true }
}
async function mount(port: MainPort) {
  const workspace = getSyncedWorkspaceController(port)
  await workspace.load([groupId])
  const group = workspace.getGroup(groupId)
  assert.ok(group)
  const binding = group.bind(scope(snapshot(port.db)))
  const seed = seedSyncedRichProvenance(binding.getCurrent().working, { origin: binding.getCurrent().snapshot.origin })
  return { workspace, group, binding, editor: EditorState.create({ doc: seed.doc }), provenance: seed.state }
}
function accept(binding: SyncedGroupBinding, editor: EditorState, provenance: RichProvenanceState, tr: Transaction) {
  const applied = editor.applyTransaction(tr)
  const prepared = prepareSyncedRichProvenance(provenance, { before: editor, transactions: applied.transactions, after: applied.state })
  const before = binding.getCurrent()
  assert.equal(binding.apply({ blocks: prepared.blocks, bindingClaims: prepared.bindingClaims, expectedEditSequence: before.editSequence,
    guards: syncedSnapshotGuard(before.snapshot), bookmark: null, transactionId: randomUUID() }), true)
  return { ...prepared, editor: applied.state, provenance: prepared.nextState }
}
function initializeLinked(db: Database.Database) {
  initialize(db)
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
  const before = snapshot(db), blocks = [{ ...before.blocks[0], content: '[AB](Target.md)' }]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
  db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(blocks[0].content, groupId)
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
}
function renameAndReplace(db: Database.Database): string {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', other)
  const id = randomUUID()
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, 'Target', id, 'Original/Target', born, now)
  return id
}
async function withMain(run: (db: Database.Database, port: MainPort) => Promise<void>) {
  const db = new Database(':memory:')
  try { initializeLinked(db); await run(db, new MainPort(db)) } finally { db.close() }
}

test('real PM claims preserve renamed targets, same-body new intent, lost-ACK lookup and exact group Undo Redo through the shared controller', async () => withMain(async (db, port) => {
  const mounted = await mount(port), { binding, workspace } = mounted
  try {
    const original = snapshot(db), replacement = renameAndReplace(db)
    const identities = db.prepare('SELECT * FROM block_identities ORDER BY id').all(), routes = db.prepare('SELECT * FROM document_block_routes ORDER BY rowid').all()
    const typed = accept(binding, mounted.editor, mounted.provenance, mounted.editor.tr.insertText('x', 2))
    assert.equal(typed.bindingClaims[0].kind, 'continue')
    assert.equal(await binding.flush(), true)
    assert.deepEqual(snapshot(db).bindings[0].target, original.bindings[0].target)
    assert.equal(snapshot(db).blocks[0].content, '[AxB](Target.md)')

    const current = typed.editor.doc.firstChild!, oldMark = current.firstChild!.marks.find(mark => mark.type.name === 'link')!
    const mark = withRichLinkOccurrence(oldMark, randomUUID()), tr = typed.editor.tr.addMark(1, 1 + current.content.size, mark)
    setRichNewLinkIntent(tr, { stepIndex: tr.steps.length - 1, from: 1, to: 1 + current.content.size, token: richLinkOccurrence(mark)! })
    const renewed = accept(binding, typed.editor, typed.provenance, tr)
    assert.deepEqual(renewed.blocks, typed.blocks)
    assert.deepEqual(renewed.bindingClaims.map(claim => claim.kind), ['new'])
    assert.equal(await binding.undo(), true, 'The unsent same-body intent is a real local history frame')
    assert.equal(await binding.redo(), true)
    port.dropNextAck = true
    assert.equal(await binding.flush(), false)
    const committed = snapshot(db)
    assert.deepEqual(committed.bindings[0].target, { kind: 'document', id: replacement, state: 'live' })
    assert.equal(binding.getCurrent().dirty, true)
    assert.equal(await binding.flush(), true)
    assert.equal(port.updates.length, 2, 'The uncertain second delivery is not resubmitted')
    assert.deepEqual(port.lookups, [port.updates[1].clientOperationId])
    assert.equal(await binding.undo(), true)
    assert.deepEqual(snapshot(db).bindings[0].target, original.bindings[0].target)
    assert.equal(await binding.redo(), true)
    assert.deepEqual(snapshot(db).bindings, committed.bindings)
    assert.deepEqual(port.restores.map(input => input.direction), ['undo', 'redo'])
    const replay = getSyncedOperation(db, { clientOperationId: port.updates[1].clientOperationId })
    assert.ok(replay.status === 'committed' && 'snapshot' in replay.result)
    assert.deepEqual(replay.result.snapshot, committed)
    assert.equal(replay.result.replayed, true)
    assert.notEqual(replay.result.snapshot.revision, snapshot(db).revision)
    assert.deepEqual(db.prepare('SELECT * FROM block_identities ORDER BY id').all(), identities)
    assert.deepEqual(db.prepare('SELECT * FROM document_block_routes ORDER BY rowid').all(), routes)
    assert.equal(snapshot(db).blocks[0].createdAt, born)
  } finally { binding.dispose(); assert.equal(workspace.dispose(), true) }
}))

test('two actual SQLite clients reject a stale PM candidate CAS without rewriting the winner or discarding the rejected working body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-rich-provenance-')), path = join(directory, 'isolated.db')
  const db = new Database(path)
  let second: Database.Database | undefined
  try {
    initializeLinked(db); db.pragma('journal_mode=WAL')
    second = new Database(path); second.pragma('foreign_keys=ON')
    const first = await mount(new MainPort(db)), peerPort = new MainPort(second), peer = await mount(peerPort)
    try {
      accept(first.binding, first.editor, first.provenance, first.editor.tr.insertText('first', 2))
      accept(peer.binding, peer.editor, peer.provenance, peer.editor.tr.insertText('second', 2))
      assert.equal(await first.binding.flush(), true)
      const committed = sqlState(db)
      assert.equal(await peer.binding.flush(), false)
      assert.equal(peer.binding.getCurrent().phase, 'conflict')
      assert.equal(peer.binding.getCurrent().dirty, true)
      assert.equal(peer.binding.getCurrent().working[0].content, '[AsecondB](Target.md)')
      assert.deepEqual(sqlState(db), committed)
      assert.equal(peerPort.updates.length, 1)
      assert.equal((db.prepare('SELECT count(*) AS n FROM synced_group_history').get() as { n: number }).n, 1)
    } finally {
      first.binding.dispose(); peer.binding.dispose()
      assert.equal(first.workspace.dispose(), true)
      assert.equal(peer.workspace.dispose(), false, 'The rejected dirty registry is not silently disposed')
    }
  } finally {
    second?.close(); db.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('knowbook-rich-provenance-'))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('actual SQL trigger failure rolls back every table while the accepted PM/controller candidate remains dirty and can retry', async () => withMain(async (db, port) => {
  const mounted = await mount(port), { binding, workspace } = mounted
  try {
    const candidate = accept(binding, mounted.editor, mounted.provenance, mounted.editor.tr.insertText('draft', 2)), before = sqlState(db)
    db.exec(`CREATE TRIGGER fail_rich_provenance BEFORE INSERT ON synced_group_blocks BEGIN SELECT RAISE(ABORT,'injected rich write failure'); END`)
    assert.equal(await binding.flush(), false)
    assert.deepEqual(sqlState(db), before)
    assert.equal(binding.getCurrent().dirty, true)
    assert.deepEqual(binding.getCurrent().working, candidate.blocks)
    assert.equal(candidate.editor.doc.textContent, 'AdraftB')
    db.exec('DROP TRIGGER fail_rich_provenance')
    assert.equal(await binding.flush(), true)
    assert.equal(snapshot(db).blocks[0].content, '[AdraftB](Target.md)')
    assert.equal(snapshot(db).blocks[0].createdAt, born)
  } finally { binding.dispose(); assert.equal(workspace.dispose(), true) }
}))
