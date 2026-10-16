import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { withHostDatabase, a, b, c, bodyId, groupId, secondGroup, command, insertAck, reference,
  request, logical, copy, freshBlock, applied, restoreAck, snapshot, changeBody,
  applySyncedHostFinal, applySyncedHostCommand, allTables, bodyBirth, identity
} from './helpers/synced-host-command-insert-fixture'

/** Both test setups use only the real typed command. No physical registry,
 * journal, lifecycle or parent rows are assembled with fixture SQL. */
function persistedNested(db: Database.Database) {
  const parent = ' registry regression:real parent ', child = ' registry regression:real child '
  const input = command(db, { dirty: working => working.blocks.push({ ...freshBlock(parent, 'Actual parent'), type: 'toggle' },
    { ...freshBlock(child, 'Actual child'), depth: 1, parentBlockId: parent }),
    target: { parentBlockId: parent, beforeBlockId: child, depth: 1 } })
  const ack = insertAck(applySyncedHostCommand(db, input))
  const nested = snapshot(db).instances.find(instance => instance.instanceId === input.action.instanceId)
  assert.ok(nested, 'The real typed writer created a persisted nested registry row')
  assert.equal(nested.parentBlockId, parent); assert.equal(nested.depth, 1); assert.equal(nested.parentType, 'toggle')
  assert.ok(bodyBirth(db, input.action.instanceId), 'The real nested reference has its accepted persistent birth')
  return { input, ack, parent, child, nested: copy(nested) }
}
function births(db: Database.Database, documentId: string) {
  return db.prepare('SELECT id,created_at FROM blocks WHERE document_id=? ORDER BY sort_order').all(documentId)
}
function hostRaw(db: Database.Database, documentId: string) {
  return {
    document: db.prepare('SELECT * FROM documents WHERE id=?').get(documentId),
    blocks: db.prepare('SELECT * FROM blocks WHERE document_id=? ORDER BY sort_order').all(documentId),
    registry: db.prepare('SELECT * FROM synced_instances WHERE host_document_id=? ORDER BY instance_id').all(documentId),
    identities: db.prepare("SELECT * FROM block_identities WHERE last_owner_kind='document' AND last_owner_id=? ORDER BY id").all(documentId)
  }
}
function assertOldNested(db: Database.Database, setup: ReturnType<typeof persistedNested>, originalBirth: string | undefined) {
  const actual = snapshot(db).instances.find(instance => instance.instanceId === setup.input.action.instanceId)
  assert.ok(actual, 'The original persisted nested reference remains registered after the host rewrite')
  assert.deepEqual(actual, setup.nested, 'An unchanged group owner parent role and depth keep the exact original binding')
  assert.equal(bodyBirth(db, setup.input.action.instanceId), originalBirth)
  assert.equal(identity(db, setup.input.action.instanceId)?.created_at, originalBirth)
}

test('persisted nested references retain exact bindings topology IDs births and peer hosts across ordinary host-final edit undo redo', () => withHostDatabase(db => {
  const setup = persistedNested(db)
  const peerInput = command(db, { documentId: b, groupId: secondGroup })
  insertAck(applySyncedHostCommand(db, peerInput))
  const groupBefore = copy(snapshot(db)), peerGroupBefore = copy(snapshot(db, secondGroup))
  const originalBirths = copy(births(db, a)), originalIdentity = copy(identity(db, setup.input.action.instanceId))
  const nestedBirth = bodyBirth(db, setup.input.action.instanceId), otherHosts = [b, c].map(id => copy(hostRaw(db, id)))
  const before = logical(db, a), input = request(db, [a], after => {
    changeBody(after[0], 'An ordinary body edit after a nested reference has really persisted')
    after[0].summary = ' exact ordinary summary \r\n'
  })
  const ack = applied(applySyncedHostFinal(db, input))
  assert.equal(ack.status, 'applied'); assert.ok(ack.historyToken, 'The real ordinary W/A change commits a host journal')
  const after = logical(db, a)
  assert.equal(after.blocks.find(block => block.id === bodyId(a))?.content,
    'An ordinary body edit after a nested reference has really persisted')
  assert.equal(after.summary, ' exact ordinary summary \r\n')
  const verify = () => {
    assertOldNested(db, setup, nestedBirth)
    assert.deepEqual(snapshot(db), groupBefore, 'No reference placement or canonical content changed, so all old group bindings and topology remain exact')
    assert.deepEqual(snapshot(db, secondGroup), peerGroupBefore, 'The independent peer group keeps its original topology and binding')
    assert.deepEqual(births(db, a), originalBirths, 'Every old block keeps its ID original birth and physical order')
    assert.deepEqual(identity(db, setup.input.action.instanceId), originalIdentity)
    assert.deepEqual([b, c].map(id => hostRaw(db, id)), otherHosts, 'Other actual hosts and their registries and retained identities are unchanged')
  }
  verify()
  restoreAck(db, ack, 'undo'); assert.deepEqual(logical(db, a), before); verify()
  restoreAck(db, ack, 'redo'); assert.deepEqual(logical(db, a), after); verify()
}))

test('late receipt failure with a persisted nested P rolls back every table and exact command retry preserves old binding and birth', () => withHostDatabase(db => {
  const setup = persistedNested(db), peerInput = command(db, { documentId: b, groupId: secondGroup })
  insertAck(applySyncedHostCommand(db, peerInput))
  const originalGroup = copy(snapshot(db)), peerGroup = copy(snapshot(db, secondGroup))
  const nestedBirth = bodyBirth(db, setup.input.action.instanceId), oldBirths = copy(births(db, a))
  const originalIdentity = copy(identity(db, setup.input.action.instanceId)), originalPeer = copy(hostRaw(db, b))
  const input = command(db, { groupId: secondGroup,
    target: { parentBlockId: setup.parent, beforeBlockId: setup.child, depth: 1 },
    dirty: working => { changeBody(working, '[Host B](Host%20B.md)'); working.summary = ' accepted retry W summary \t' } })
  const frozen = copy(input)
  assert.equal(identity(db, input.action.instanceId), undefined)
  db.exec("CREATE TRIGGER fail_nested_command_receipt BEFORE INSERT ON synced_operations BEGIN SELECT RAISE(ABORT,'injected nested command receipt'); END")
  const before = allTables(db)
  assert.throws(() => applySyncedHostCommand(db, input), /injected nested command receipt/)
  assert.deepEqual(allTables(db), before, 'The late error restores old nested registry physical parents identities links indexes journals cursors pins and ACKs')
  assert.deepEqual(input, frozen, 'The original complete dirty command remains unchanged after the failed transaction')
  assert.equal(identity(db, input.action.instanceId), undefined, 'The rejected new reference acquires no retained birth authority')
  assertOldNested(db, setup, nestedBirth)
  db.exec('DROP TRIGGER fail_nested_command_receipt')
  const ack = insertAck(applySyncedHostCommand(db, input))
  assert.equal(ack.operationId, input.clientOperationId); assert.deepEqual(input, frozen)
  const actual = logical(db, a)
  assert.deepEqual(actual.blocks.filter(block => block.id !== input.action.instanceId), input.hostsWorkingBefore[0].workingBefore.blocks)
  assert.equal(actual.summary, input.hostsWorkingBefore[0].workingBefore.summary)
  assert.deepEqual(actual.blocks.find(block => block.id === input.action.instanceId), reference(input.action.instanceId, secondGroup, 1, setup.parent))
  assertOldNested(db, setup, nestedBirth)
  assert.deepEqual(identity(db, setup.input.action.instanceId), originalIdentity)
  assert.deepEqual(births(db, a).filter(row => (row as { id: string }).id !== input.action.instanceId), oldBirths)
  assert.deepEqual(snapshot(db), originalGroup, 'Inserting another group does not change old main-group bindings or topology')
  const currentPeer = snapshot(db, secondGroup), fresh = currentPeer.instances.find(instance => instance.instanceId === input.action.instanceId)
  assert.ok(fresh, 'The successfully retried actual command registers its one new reference in the typed target group')
  assert.equal(fresh.hostDocumentId, a); assert.equal(fresh.parentBlockId, setup.parent); assert.equal(fresh.depth, 1); assert.equal(fresh.parentType, 'toggle')
  assert.ok(fresh.bindingVersion, 'The successfully retried new registry has a real fresh binding')
  assert.notEqual(currentPeer.topologyRevision, peerGroup.topologyRevision)
  assert.deepEqual(currentPeer.instances.filter(instance => instance.instanceId !== input.action.instanceId), peerGroup.instances,
    'The preexisting peer instance keeps its exact original binding')
  assert.deepEqual(hostRaw(db, b), originalPeer, 'The peer host physical and ownership rows remain unchanged')
  const newBirth = bodyBirth(db, input.action.instanceId)
  assert.ok(newBirth, 'The exact original command retry accepts one actual new reference birth')
  assert.equal(identity(db, input.action.instanceId)?.created_at, newBirth)
  assert.equal((db.prepare('SELECT count(*) AS count FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as { count: number }).count, 1)
}))
