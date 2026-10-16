import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, getMarkdownHeadingRewrites } from '../src/shared/markdownLinkMaintenance'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, getSyncedOperationWithLinkSource,
  releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import { ordinary } from './helpers/synced-content-fixture'
import { withHostDatabase, a, b, c, bodyId, secondGroup, groupId, instanceId, born, now,
  request, logical, copy, guards, freshBlock, applied, edit, restoreInput, restoreAck, snapshot, groupEdit,
  applySyncedHostFinal, restoreSyncedHostOperation, getSyncedHostHistory,
  allTables, withoutOperations, totalChanges, identity, bodyBirth, changeBody } from './helpers/synced-host-final-fixture'

const encode = canonicalSyncedPortableJson
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function unchanged(db: Database.Database, run: () => ReturnType<typeof applySyncedHostFinal>, status?: string) {
  const before = allTables(db), result = run()
  assert.ok(result.status !== 'applied' && result.status !== 'noop', 'The rejected request cannot report an accepted structure ACK')
  if (status) assert.equal(result.status, status)
  assert.deepEqual(allTables(db), before, 'Rejected structure requests preserve every persistent table')
  return result
}
function historyRows(db: Database.Database) { return db.prepare('SELECT * FROM synced_host_history ORDER BY id').all() }
function mappings(db: Database.Database) { return db.prepare('SELECT * FROM synced_host_history_documents ORDER BY document_id,position').all() }
function operationRow(db: Database.Database, id: string) {
  const row = db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(id) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  assert.ok(row, 'The actual successful writer committed its exact operation row')
  return row
}
function corruptStoredAck(db: Database.Database, operationId: string,
  mutate: (root: Record<string, unknown>, ack: Record<string, unknown>) => void, label: string) {
  const row = copy(operationRow(db, operationId)), raw = JSON.parse(row.result_json) as Record<string, unknown>
  const found: Array<Record<string, unknown>> = []
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value) && (value as Record<string, unknown>).operationId === operationId && Array.isArray((value as Record<string, unknown>).hosts)) found.push(value as Record<string, unknown>)
    for (const child of Object.values(value)) walk(child)
  }
  walk(raw); assert.equal(found.length, 1, 'The actual stored envelope contains exactly its original structure ACK')
  mutate(raw, found[0])
  db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(raw), operationId)
  try {
    const before = allTables(db)
    assert.throws(() => getSyncedOperation(db, { clientOperationId: operationId }), /收据|结构|kind|ack/i, label)
    assert.deepEqual(allTables(db), before)
  } finally { db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(row.result_json, operationId) }
}
function expectLogical(db: Database.Database, expected: { documentId: string; title: string; summary: string; blocks: unknown[] }) {
  assert.equal(encode(logical(db, expected.documentId)), encode(expected), 'Actual host rows contain the exact logical side')
}
function redoChain(db: Database.Database) {
  const prefix = edit(db, [c], 'peer executed prefix')
  const ab = edit(db, [a, b], 'shared AB'), bc = edit(db, [b, c], 'shared BC'), tail = edit(db, [c], 'peer tail')
  restoreAck(db, tail.ack, 'undo'); restoreAck(db, bc.ack, 'undo'); restoreAck(db, ab.ack, 'undo')
  return { prefix, ab, bc, tail }
}
function nestedReference(db: Database.Database, depth: number) {
  db.transaction(() => {
    db.prepare('DELETE FROM synced_instances WHERE instance_id=?').run(instanceId)
    let parent: string | null = null
    for (let index = 0; index < depth; index++) {
      const id = ' actual-parent:' + index
      ordinary(db, id, { owner: a, type: 'toggle', depth: index, parent: parent ?? undefined, sort: index })
      parent = id
    }
    db.prepare('UPDATE blocks SET depth=?,parent_block_id=?,sort_order=? WHERE id=?').run(depth, parent, depth, instanceId)
    db.prepare('UPDATE blocks SET sort_order=? WHERE id=?').run(depth + 1, bodyId(a))
    db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
      .run(instanceId, groupId, a, randomUUID(), parent, depth)
    db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=?').run(randomUUID(), groupId)
  })()
}
function deeperCanonical(db: Database.Database) {
  const root = syncedCanonicalEdits(snapshot(db).blocks)[0], first = ' newcanonical:depth1 ', second = ' newcanonical:depth2 '
  return groupEdit(db, [{ ...root, type: 'toggle' }, { ...freshBlock(first, 'level one'), type: 'toggle', depth: 1, parentBlockId: root.id },
    { ...freshBlock(second, 'level two'), depth: 2, parentBlockId: first }])
}

test('dirty W is the exact logical Undo side while P only guards concurrency and the writer commits A', () => withHostDatabase(db => {
  const persisted = logical(db, a), input = request(db, [a], (after, before) => {
    changeBody(before[0].workingBefore, 'unacknowledged W text')
    before[0].workingBefore.summary = ' raw W summary \r\n'
    after[0] = { documentId: a, ...copy(before[0].workingBefore) }
    changeBody(after[0], 'final A text')
    after[0].summary = ' raw A summary \t'
    const block = after[0].blocks.find(block => block.id === bodyId(a))!
    block.type = 'todo'; block.checked = true; block.tags = ['精确', 'metadata']; block.highlight = 'yellow'
    block.markdownFormat = { listMarker: '+', listLoose: true }
  })
  const birth = bodyBirth(db, bodyId(a)), routes = copy(allTables(db).document_block_routes)
  const ack = applied(applySyncedHostFinal(db, input))
  assert.equal(ack.status, 'applied'); assert.ok(ack.historyToken, 'The nonidentity W to A operation has an actual history token')
  assert.notEqual(encode(persisted.blocks), encode(input.hostsWorkingBefore[0].workingBefore.blocks))
  assert.deepEqual(ack.hosts[0].logicalBefore, input.hostsWorkingBefore[0].workingBefore)
  assert.equal(ack.hosts[0].logicalBeforeHash, sha(encode(input.hostsWorkingBefore[0].workingBefore)))
  expectLogical(db, input.finalAfter[0]); assert.equal(bodyBirth(db, bodyId(a)), birth)
  assert.deepEqual(allTables(db).document_block_routes, routes)
  restoreAck(db, ack, 'undo')
  expectLogical(db, { documentId: a, ...input.hostsWorkingBefore[0].workingBefore })
  restoreAck(db, ack, 'redo'); expectLogical(db, input.finalAfter[0])
  assert.equal(bodyBirth(db, bodyId(a)), birth)
}))

test('a W-only new child deleted by A receives retained birth authority and real inverse restores its original identity', () => withHostDatabase((db, second) => {
  const id = ' 新W-only:__proto__\0 ', input = request(db, [a], (after, before) => {
    before[0].workingBefore.blocks.push(freshBlock(id, 'This dirty child never existed in P or A'))
    changeBody(after[0], 'A deletes the W-only child')
  })
  assert.equal(identity(db, id), undefined); assert.equal(bodyBirth(db, id), undefined)
  const ack = applied(applySyncedHostFinal(db, input)), retained = identity(db, id)
  assert.ok(retained && retained.created_at, 'Main recorded the first accepted birth even though A has no physical child')
  assert.equal(retained.state, 'retained'); assert.equal(retained.last_owner_kind, 'document'); assert.equal(retained.last_owner_id, a)
  assert.ok(Number.isFinite(Date.parse(retained.created_at)), 'The recorded first birth is a valid actual Main timestamp')
  assert.equal(bodyBirth(db, id), undefined)
  const reopened = second()
  restoreAck(reopened, ack, 'undo')
  assert.equal(bodyBirth(reopened, id), retained.created_at)
  expectLogical(reopened, { documentId: a, ...input.hostsWorkingBefore[0].workingBefore })
  restoreAck(reopened, ack, 'redo')
  assert.equal(bodyBirth(reopened, id), undefined)
  assert.deepEqual(identity(reopened, id), retained)
}))

test('multi-host final authority preserves each dirty W metadata and restores all hosts atomically', () => withHostDatabase(db => {
  const input = request(db, [a, b], (after, before) => {
    for (let index = 0; index < before.length; index++) {
      changeBody(before[index].workingBefore, 'dirty W ' + index)
      after[index] = { documentId: before[index].documentId, ...copy(before[index].workingBefore) }
      after[index].summary = ' summary ' + index + ' \n'
      changeBody(after[index], 'final A ' + index)
    }
  })
  const births = [bodyBirth(db, bodyId(a)), bodyBirth(db, bodyId(b))], untouched = logical(db, c)
  const ack = applied(applySyncedHostFinal(db, input))
  assert.deepEqual(new Set(ack.hosts.map(host => host.documentId)), new Set([a, b]))
  for (const side of input.finalAfter) expectLogical(db, side)
  restoreAck(db, ack, 'undo')
  for (const side of input.hostsWorkingBefore) expectLogical(db, { documentId: side.documentId, ...side.workingBefore })
  restoreAck(db, ack, 'redo')
  assert.deepEqual([bodyBirth(db, bodyId(a)), bodyBirth(db, bodyId(b))], births)
  assert.deepEqual(logical(db, c), untouched)
}))

test('title changes and command mode are explicitly unsupported without normalization history pruning or any write', () => {
  for (const side of ['W', 'A', 'both', 'command'] as const) withHostDatabase(db => {
    redoChain(db)
    const input = request(db)
    let value: unknown = input
    if (side === 'W' || side === 'both') input.hostsWorkingBefore[0].workingBefore.title += ' changed'
    if (side === 'A' || side === 'both') input.finalAfter[0].title += ' changed'
    if (side === 'command') {
      const { finalAfter: _after, newRefSources: _sources, reason: _reason, ...base } = input
      value = { ...base, mode: 'command', action: { kind: 'delete', selection: { documentId: a, selectedRootIds: [bodyId(a)] } } }
    }
    const count = totalChanges(db), result = unchanged(db, () => applySyncedHostFinal(db, value), 'unsupported')
    assert.ok(result.status === 'unsupported', 'The internal result identifies the unsupported narrow-slice capability')
    assert.equal(result.reason, side === 'command' ? 'command' : 'title-change')
    assert.equal(totalChanges(db), count, 'Unsupported requests do not even execute provisional DML')
  })
})

test('true noop stores only its original operation ACK and never initializes history or prunes a branch', () => withHostDatabase(db => {
  const input = request(db), before = withoutOperations(db), changes = totalChanges(db)
  assert.throws(() => getSyncedHostHistory(db, { documentId: a }), /初始化|state|history/)
  const ack = applied(applySyncedHostFinal(db, input))
  assert.equal(ack.status, 'noop'); assert.equal(ack.historyToken, null)
  assert.deepEqual(withoutOperations(db), before)
  assert.equal(totalChanges(db), changes + 1, 'Only the exact noop receipt is inserted')
  const stored = operationRow(db, input.clientOperationId), after = allTables(db)
  assert.equal(encode(applied(applySyncedHostFinal(db, input))), encode({ ...ack, replayed: true }))
  assert.deepEqual(allTables(db), after)
  assert.deepEqual(operationRow(db, input.clientOperationId), stored)
}))

test('P differs from W while A equals W commits applied with no identity journal and prunes only the real Redo suffix', () => withHostDatabase(db => {
  const prefix = edit(db, [a], 'executed prefix'), tail = edit(db, [a], 'redo tail')
  restoreAck(db, tail.ack, 'undo')
  const rows = historyRows(db), pins = copy(allTables(db).synced_group_pins), state = getSyncedHostHistory(db, { documentId: a })
  const input = request(db, [a], (after, before) => {
    changeBody(before[0].workingBefore, 'dirty W becomes persistent without a structural delta')
    after[0] = { documentId: a, ...copy(before[0].workingBefore) }
  })
  const ack = applied(applySyncedHostFinal(db, input))
  assert.equal(ack.status, 'applied'); assert.equal(ack.historyToken, null)
  expectLogical(db, input.finalAfter[0])
  assert.deepEqual(historyRows(db), rows, 'No identity W to A journal can trap an Undo tail')
  assert.deepEqual(allTables(db).synced_group_pins, pins)
  const history = getSyncedHostHistory(db, { documentId: a })
  assert.equal(history.undoToken, prefix.ack.historyToken); assert.equal(history.redoToken, null)
  assert.notEqual(history.cursor, state.cursor)
}))

test('last-reference deletion uses an explicit real fresh paragraph and an empty persisted host is rejected', () => withHostDatabase(db => {
  const empty = request(db, [a], after => { after[0].blocks = [] })
  unchanged(db, () => applySyncedHostFinal(db, empty))
  const id = ' explicit-last-empty:paragraph ', input = request(db, [a], after => { after[0].blocks = [freshBlock(id, '')] })
  const before = snapshot(db), ack = applied(applySyncedHostFinal(db, input))
  assert.deepEqual(logical(db, a).blocks.map(block => block.id), [id])
  assert.equal(snapshot(db).instances.length, 0)
  assert.equal(snapshot(db).creationId, before.creationId)
  assert.equal((db.prepare('SELECT state FROM synced_group_lifecycle WHERE group_id=?').get(groupId) as { state: string }).state, 'active')
  assert.ok((allTables(db).synced_group_pins as Array<{ group_id: string; pin_id: string }>).some(pin => pin.group_id === groupId && pin.pin_id === ack.historyToken), 'The removed-side group has a real persistent journal pin')
  restoreAck(db, ack, 'undo')
  assert.equal(snapshot(db).instances[0].instanceId, instanceId)
  assert.notEqual(snapshot(db).instances[0].bindingVersion, before.instances[0].bindingVersion)
}))

test('P W A group and existing-instance guards form exact closures and stale or excess claims cannot partially save', () => {
  for (const kind of ['missing-group', 'extra-group', 'missing-instance', 'extra-instance', 'stale-group', 'stale-topology', 'stale-binding', 'stale-host'] as const) withHostDatabase(db => {
    const input = request(db, [a], after => changeBody(after[0], 'guarded body'))
    if (kind === 'missing-group') input.groups = []
    else if (kind === 'extra-group') { const extra = snapshot(db, secondGroup); input.groups.push({ groupId: secondGroup, expectedRevision: extra.revision, expectedTopologyRevision: extra.topologyRevision }) }
    else if (kind === 'missing-instance') input.expectedInstances = []
    else if (kind === 'extra-instance') input.expectedInstances.push({ instanceId: randomUUID(), hostDocumentId: b, bindingVersion: randomUUID() })
    else if (kind === 'stale-group') input.groups[0].expectedRevision = randomUUID()
    else if (kind === 'stale-topology') input.groups[0].expectedTopologyRevision = randomUUID()
    else if (kind === 'stale-binding') input.expectedInstances[0].bindingVersion = randomUUID()
    else input.hostsWorkingBefore[0].expectedPersistedUpdatedAt = born
    unchanged(db, () => applySyncedHostFinal(db, input))
  })
})

test('foreign canonical and cross-host identities cannot be claimed through a final-side DTO', () => {
  for (const kind of ['foreign-live', 'foreign-retained', 'canonical', 'cross-host-transfer', 'retarget-ref'] as const) withHostDatabase(db => {
    const input = request(db, kind === 'cross-host-transfer' ? [a, b] : [a], after => changeBody(after[0], 'identity checked'))
    if (kind === 'foreign-live') input.finalAfter[0].blocks.push(freshBlock(bodyId(b)))
    else if (kind === 'foreign-retained') { db.prepare('DELETE FROM blocks WHERE id=?').run(bodyId(b)); ordinary(db, 'foreign keeper', { owner: b }); input.finalAfter[0].blocks.push(freshBlock(bodyId(b))) }
    else if (kind === 'canonical') input.finalAfter[0].blocks.push(freshBlock(snapshot(db).blocks[0].id))
    else if (kind === 'cross-host-transfer') {
      const selected = input.finalAfter[0].blocks.find(block => block.id === bodyId(a))!
      input.finalAfter[0].blocks = input.finalAfter[0].blocks.filter(block => block.id !== selected.id); input.finalAfter[1].blocks.push(selected)
    } else {
      input.finalAfter[0].blocks.find(block => block.id === instanceId)!.content = JSON.stringify({ version: 1, groupId: secondGroup })
      Object.assign(input, guards(db, [a], input.finalAfter))
    }
    unchanged(db, () => applySyncedHostFinal(db, input))
  })
})

test('same-host retained recovery preserves a known birth while null birth and foreign owner remain unavailable', () => {
  for (const kind of ['known', 'null', 'foreign'] as const) withHostDatabase(db => {
    const id = ' retained:历史普通块 ', owner = kind === 'foreign' ? b : a
    db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'document',?,'retained',?)")
      .run(id, owner, kind === 'null' ? null : born)
    const input = request(db, [a], after => after[0].blocks.push(freshBlock(id, 'explicit same-host recovery')))
    if (kind !== 'known') { unchanged(db, () => applySyncedHostFinal(db, input)); return }
    const ack = applied(applySyncedHostFinal(db, input))
    assert.equal(bodyBirth(db, id), born); assert.equal(identity(db, id)?.last_owner_id, a)
    restoreAck(db, ack, 'undo'); assert.equal(bodyBirth(db, id), undefined)
    restoreAck(db, ack, 'redo'); assert.equal(bodyBirth(db, id), born)
  })
})

test('fresh references require actual working or internal creation proof and preserve current canonical bodies', () => {
  for (const source of ['working', 'internal', 'internal-other-group'] as const) withHostDatabase(db => {
    const id = randomUUID(), targetGroup = source === 'internal-other-group' ? secondGroup : groupId, before = snapshot(db, targetGroup)
    const input = request(db, [a, b], after => after[1].blocks.push({ ...freshBlock(id), type: 'synced-block', content: JSON.stringify({ version: 1, groupId: targetGroup }) }))
    input.newRefSources = source === 'working' ? [{ kind: 'working', instanceId: id, sourceDocumentId: a, sourceInstanceId: instanceId }]
      : [{ kind: 'internal', instanceId: id, identity: { workspaceScope: '00000000-0000-0000-0000-000000000900', groupId: targetGroup, creationId: before.creationId } }]
    const ack = applied(applySyncedHostFinal(db, input)), after = snapshot(db, targetGroup)
    assert.equal(after.instances.length, before.instances.length + 1); assert.deepEqual(after.blocks, before.blocks); assert.equal(after.revision, before.revision)
    assert.notEqual(after.topologyRevision, before.topologyRevision)
    const inserted = after.instances.find(instance => instance.instanceId === id)
    assert.ok(inserted && inserted.hostDocumentId === b, 'The actual registry owns the new reference at the true target host')
    restoreAck(db, ack, 'undo'); assert.equal(snapshot(db, targetGroup).instances.length, before.instances.length)
    restoreAck(db, ack, 'redo'); assert.equal(snapshot(db, targetGroup).instances.length, before.instances.length + 1)
    assert.notEqual(snapshot(db, targetGroup).instances.find(instance => instance.instanceId === id)?.bindingVersion, inserted.bindingVersion)
  })
})

test('forged fresh-reference sources and reusing an existing instance cannot acquire reference authority', () => {
  for (const kind of ['missing', 'scope', 'creation', 'working-source', 'existing-id'] as const) withHostDatabase(db => {
    const id = kind === 'existing-id' ? instanceId : randomUUID(), current = snapshot(db)
    const input = request(db, [a, b], after => after[1].blocks.push({ ...freshBlock(id), type: 'synced-block', content: JSON.stringify({ version: 1, groupId }) }))
    input.newRefSources = kind === 'missing' ? [] : kind === 'working-source'
      ? [{ kind: 'working', instanceId: id, sourceDocumentId: a, sourceInstanceId: randomUUID() }]
      : [{ kind: 'internal', instanceId: id, identity: { workspaceScope: kind === 'scope' ? randomUUID() : '00000000-0000-0000-0000-000000000900', groupId, creationId: kind === 'creation' ? randomUUID() : current.creationId } }]
    unchanged(db, () => applySyncedHostFinal(db, input))
  })
})

test('ordinary front insertion changes sort order without inventing a new reference binding or topology revision', () => withHostDatabase(db => {
  const before = snapshot(db), input = request(db, [a], after => after[0].blocks.unshift(freshBlock(' front:新块 ', 'front text')))
  applied(applySyncedHostFinal(db, input))
  const after = snapshot(db)
  assert.equal(after.instances[0].bindingVersion, before.instances[0].bindingVersion)
  assert.equal(after.topologyRevision, before.topologyRevision)
  assert.equal((db.prepare('SELECT sort_order FROM blocks WHERE id=?').get(instanceId) as { sort_order: number }).sort_order, 1)
}))

test('shared Redo pruning follows real AB BC suffixes while preserving peer executed prefix journals pins and old ACKs', () => withHostDatabase(db => {
  const chain = redoChain(db), beforeRows = historyRows(db), beforePins = copy(allTables(db).synced_group_pins)
  const oldAcks = [chain.prefix, chain.ab, chain.bc, chain.tail].map(item => operationRow(db, item.input.clientOperationId))
  const beforeB = getSyncedHostHistory(db, { documentId: b }), beforeC = getSyncedHostHistory(db, { documentId: c })
  edit(db, [a], 'new real edit truncates shared Redo')
  assert.deepEqual(historyRows(db).filter((row: unknown) => beforeRows.some(prior => (prior as { id: string }).id === (row as { id: string }).id)), beforeRows)
  assert.deepEqual((allTables(db).synced_group_pins as unknown[]).filter(pin => (beforePins as unknown[]).some(prior => encode(prior) === encode(pin))), beforePins)
  const rows = mappings(db) as Array<{ history_id: string; document_id: string; position: number }>
  assert.ok(!rows.some(row => [chain.ab.ack.historyToken, chain.bc.ack.historyToken, chain.tail.ack.historyToken].includes(row.history_id)), 'Every real shared Redo suffix mapping was removed across all peers')
  assert.ok(rows.some(row => row.document_id === c && row.history_id === chain.prefix.ack.historyToken), 'The peer executed prefix mapping remains')
  assert.equal(getSyncedHostHistory(db, { documentId: c }).undoToken, chain.prefix.ack.historyToken)
  assert.equal(getSyncedHostHistory(db, { documentId: b }).redoToken, null)
  assert.notEqual(getSyncedHostHistory(db, { documentId: b }).cursor, beforeB.cursor)
  assert.notEqual(getSyncedHostHistory(db, { documentId: c }).cursor, beforeC.cursor)
  for (const row of oldAcks) assert.deepEqual(operationRow(db, row.client_operation_id), row)
}))

test('late receipt SQL failure rolls back host rows ownership indexes shared pruning journal pins and cursors', () => withHostDatabase(db => {
  redoChain(db)
  const input = request(db, [a], after => { changeBody(after[0], 'must roll back'); after[0].blocks.push(freshBlock(' rollback:new-child ')) })
  db.exec(`CREATE TRIGGER fixture_fail_host_receipt BEFORE INSERT ON synced_operations
    BEGIN SELECT RAISE(ABORT,'injected late host receipt failure'); END;`)
  const before = allTables(db)
  assert.throws(() => applySyncedHostFinal(db, input), /injected late host receipt failure/)
  assert.deepEqual(allTables(db), before)
  db.exec('DROP TRIGGER fixture_fail_host_receipt')
  const ack = applied(applySyncedHostFinal(db, input))
  assert.equal(ack.operationId, input.clientOperationId); expectLogical(db, input.finalAfter[0])
  assert.equal((db.prepare('SELECT count(*) AS n FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as { n: number }).n, 1)
}))

test('two independent SQLite connections accept one CAS writer and preserve the other complete W on conflict', () => withHostDatabase((db, second) => {
  const peer = second(), first = request(db, [a], after => changeBody(after[0], 'first client'))
  const stale = request(peer, [a], (after, before) => { changeBody(before[0].workingBefore, 'peer dirty W'); changeBody(after[0], 'peer A') }), frozen = copy(stale)
  applied(applySyncedHostFinal(db, first))
  unchanged(peer, () => applySyncedHostFinal(peer, stale), 'conflict')
  assert.deepEqual(stale, frozen)
  expectLogical(peer, first.finalAfter[0])
}))

test('a projection-invalid dirty W can be corrected to legal A while Undo of that W preserves its token and refuses the invalid graph', () => withHostDatabase(db => {
  deeperCanonical(db)
  const input = request(db, [a], (after, before) => {
    const original = copy(before[0].workingBefore.blocks), reference = copy(original.find(block => block.id === instanceId)!)
    const containers = Array.from({ length: 5 }, (_, depth) => ({ ...freshBlock(' W-only-container:' + depth), type: 'toggle', depth,
      parentBlockId: depth ? ' W-only-container:' + (depth - 1) : null }))
    reference.depth = 5; reference.parentBlockId = containers.at(-1)!.id
    before[0].workingBefore.blocks = [...containers, reference, ...original.filter(block => block.id !== instanceId)]
    changeBody(after[0], 'A corrects the dirty invalid projection')
  })
  const ack = applied(applySyncedHostFinal(db, input)), tail = getSyncedHostHistory(db, { documentId: a })
  expectLogical(db, input.finalAfter[0])
  unchanged(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
  assert.deepEqual(getSyncedHostHistory(db, { documentId: a }), tail)
}))

test('pure-reference inverse uses current canonical content and rejects later depth growth instead of replaying old group snapshots', () => {
  for (const tooDeep of [false, true]) withHostDatabase(db => {
    nestedReference(db, 5)
    const input = request(db, [a], after => { const ref = after[0].blocks.find(block => block.id === instanceId)!; ref.depth = 0; ref.parentBlockId = null })
    const ack = applied(applySyncedHostFinal(db, input))
    if (tooDeep) deeperCanonical(db); else groupEdit(db)
    const current = snapshot(db), tail = getSyncedHostHistory(db, { documentId: a })
    if (tooDeep) {
      unchanged(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
      assert.deepEqual(getSyncedHostHistory(db, { documentId: a }), tail)
    } else {
      restoreAck(db, ack, 'undo')
      assert.deepEqual(snapshot(db).blocks, current.blocks)
      assert.equal(snapshot(db).revision, current.revision)
      assert.equal(snapshot(db).instances[0].depth, 5)
    }
  })
})

test('strict final validation covers an unrelated group occurrence in a host outside the submitted W set', () => withHostDatabase(db => {
  // This is an explicitly corrupt preexisting projection, not a successful
  // writer-generated state. The supported request must not repair or hide it.
  db.transaction(() => {
    const root = (db.prepare('SELECT id FROM synced_group_blocks WHERE group_id=?').get(secondGroup) as { id: string }).id
    db.prepare("UPDATE synced_group_blocks SET type='toggle' WHERE id=?").run(root)
    db.prepare(`INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,created_at)
      VALUES(?,?,?,1,'paragraph','nested',0,1,'[]',?)`).run(' unrelated:canonical-child ', secondGroup, root, born)
    let parent: string | null = null
    for (let depth = 0; depth < 6; depth++) {
      const id = ' unrelated:host-parent:' + depth
      ordinary(db, id, { owner: c, type: 'toggle', depth, parent: parent ?? undefined, sort: depth }); parent = id
    }
    const id = randomUUID()
    db.prepare('INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, c, parent, 6, 'synced-block', JSON.stringify({ version: 1, groupId: secondGroup }), 0, 6, '[]', born, now)
    db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
      .run(id, secondGroup, c, randomUUID(), parent, 6)
    db.prepare('UPDATE blocks SET sort_order=7 WHERE id=?').run(bodyId(c))
    db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=?').run(randomUUID(), secondGroup)
  })()
  const input = request(db, [a], after => changeBody(after[0], 'must validate the complete graph'))
  assert.deepEqual(input.groups.map(group => group.groupId), [groupId])
  unchanged(db, () => applySyncedHostFinal(db, input))
}))

test('real incoming heading links remain unchanged when P to W or P to A would require an unsupported rewrite', () => {
  for (const changed of ['W', 'A'] as const) withHostDatabase(db => {
    db.prepare("UPDATE blocks SET type='heading-2',content='Old section' WHERE id=?").run(bodyId(a))
    const source = '[Old section](Host%20A.md#old-section)'
    db.prepare('UPDATE blocks SET content=? WHERE id=?').run(source, bodyId(b))
    const link = collectDocumentMarkdownLinks(logical(db, b).blocks)[0]
    assert.ok(link, 'The incoming fixture is an actual parsed Markdown link')
    db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), b, a, 'Old section', born)
    db.prepare('INSERT INTO markdown_link_sources(source_document_id,source_block_id,source_offset,url,kind,target_path,fragment) VALUES(?,?,?,?,?,?,?)')
      .run(b, bodyId(b), link.start, link.url, 'markdown', 'Home/Host A', 'old-section')
    const input = request(db, [a], (after, before) => {
      changeBody(changed === 'W' ? before[0].workingBefore : after[0], 'New section')
      if (changed === 'W') after[0].summary = 'A corrects the heading but W still changed it'
    })
    const target = changed === 'W' ? input.hostsWorkingBefore[0].workingBefore : input.finalAfter[0]
    assert.ok(getMarkdownHeadingRewrites(getMarkdownHeadingTargets(logical(db, a).blocks, logical(db, a).title), getMarkdownHeadingTargets(target.blocks, target.title)).size > 0,
      'This fixture actually changes a heading target')
    const count = totalChanges(db), result = unchanged(db, () => applySyncedHostFinal(db, input), 'unsupported')
    assert.ok(result.status === 'unsupported', 'Heading closure is explicitly outside the narrow writer')
    assert.equal(result.reason, 'heading-rewrite'); assert.equal(totalChanges(db), count)
  })
})

test('an inverse cannot overwrite a later heading edit or rewrite incoming references through an old structural token', () => withHostDatabase(db => {
  db.prepare("UPDATE blocks SET type='heading-2',content='Stable section' WHERE id=?").run(bodyId(a))
  const input = request(db, [a], after => { after[0].summary = 'supported raw summary change' })
  const ack = applied(applySyncedHostFinal(db, input))
  db.prepare("UPDATE blocks SET content='Later heading' WHERE id=?").run(bodyId(a))
  db.prepare("UPDATE documents SET updated_at='2030-01-01T00:00:00.000Z' WHERE id=?").run(a)
  const source = '[Later heading](Host%20A.md#later-heading)'
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(source, bodyId(b))
  db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), b, a, 'Later heading', born)
  const tail = getSyncedHostHistory(db, { documentId: a })
  unchanged(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
  assert.deepEqual(getSyncedHostHistory(db, { documentId: a }), tail)
}))

test('exact structure ACK replay preserves complete original DocumentDetail after children links groups and current state change', () => withHostDatabase(db => {
  const child = ' child:document ', childPath = 'Home/Host A/Child'
  db.prepare('INSERT INTO documents(id,title,slug,path,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(child, 'Child', child, childPath, a, born, now)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[Host B](Host%20B.md)', bodyId(a))
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[Host A](Host%20A.md)', bodyId(b))
  for (const [from, to, label] of [[a, b, 'Host B'], [b, a, 'Host A']]) {
    db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), from, to, label, born)
  }
  const input = request(db, [a], after => { after[0].summary = ' exact summary \r\n' }), ack = applied(applySyncedHostFinal(db, input))
  const detail = ack.hosts.find(host => host.documentId === a)?.after
  assert.ok(detail, 'The real ACK has a complete actual host DocumentDetail')
  assert.deepEqual(Object.keys(detail).sort(), ['id', 'title', 'path', 'summary', 'updatedAt', 'blocks', 'children', 'outgoingLinks', 'backlinks'].sort())
  assert.deepEqual(detail.children, [{ id: child, title: 'Child', path: childPath }])
  assert.ok(detail.outgoingLinks.some(link => link.id === b && link.path === 'Home/Host B'), 'Actual outgoing links are present, not filled with an empty array')
  assert.ok(detail.backlinks.some(link => link.id === b && link.label === 'Host A' && link.contextSnippet?.includes('Host A')), 'Actual backlinks include their real context snippet')
  assert.equal(detail.summary, ' exact summary \r\n')
  const original = copy(ack), row = copy(operationRow(db, input.clientOperationId)), rowHash = sha(row.result_json)
  db.prepare("UPDATE documents SET title='Later child',path='Home/Host A/Later child' WHERE id=?").run(child)
  db.prepare("UPDATE links SET label='later link label' WHERE source_document_id=? OR target_document_id=?").run(a, a)
  edit(db, [a], 'later host body'); groupEdit(db)
  const before = allTables(db), replay = applied(applySyncedHostFinal(db, input)), lookup = getSyncedOperation(db, { clientOperationId: input.clientOperationId })
  assert.equal(lookup.status, 'committed')
  if (lookup.status !== 'committed') throw new Error('The actual committed structural receipt must be found')
  assert.equal(encode(replay), encode({ ...original, replayed: true }))
  assert.equal(encode(lookup.result), encode({ ...original, replayed: true }))
  assert.deepEqual(allTables(db), before)
  assert.equal(sha(operationRow(db, input.clientOperationId).result_json), rowHash)
  const changed = copy(input); changeBody(changed.finalAfter[0], 'different request with old op')
  unchanged(db, () => applySyncedHostFinal(db, changed), 'idempotency-mismatch')
}))

test('stored structure ACK corruption fails closed and never gives a group-owned canonical source ticket', () => withHostDatabase(db => {
  const { ack } = edit(db, [a], 'actual stored ACK')
  const owner = captureSyncedBaselineOwner(db, { groupId })
  assert.equal(owner.status, 'ready')
  if (owner.status !== 'ready') throw new Error('The actual group owner must be captured')
  try {
    assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId }), /收据|结构|kind|ack/i)
    assert.throws(() => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId }), /收据|结构|kind|ack/i)
    for (const kind of ['closed-envelope', 'wrong-operation', 'stored-replayed', 'missing-detail', 'null-token-with-delta']) {
      corruptStoredAck(db, ack.operationId, (root, actual) => {
        if (kind === 'closed-envelope') root.unexpected = 'not allowed'
        else if (kind === 'wrong-operation') actual.operationId = randomUUID()
        else if (kind === 'stored-replayed') actual.replayed = true
        else if (kind === 'null-token-with-delta') actual.historyToken = null
        else delete (actual.hosts as Array<{ after: Record<string, unknown> }>)[0].after.children
      }, kind)
    }
    const identity = request(db, [a], (after, before) => {
      changeBody(before[0].workingBefore, 'physical new W with no logical delta')
      after[0] = { documentId: a, ...copy(before[0].workingBefore) }
    }), nullAck = applied(applySyncedHostFinal(db, identity))
    assert.equal(nullAck.status, 'applied'); assert.equal(nullAck.historyToken, null)
    corruptStoredAck(db, nullAck.operationId, (_root, actual) => { actual.historyToken = randomUUID() }, 'nonnull token without a logical W/A delta')
    const noop = applied(applySyncedHostFinal(db, request(db)))
    assert.equal(noop.status, 'noop')
    corruptStoredAck(db, noop.operationId, (_root, actual) => { actual.affectedInstanceIds = [instanceId] }, 'noop cannot claim affected instances')
  } finally { releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId }) }
}))

test('redo pruning rejects corrupted real journals or participant mappings rather than trusting caller-provided sets', () => {
  for (const kind of ['action-shape', 'before-hash', 'missing-peer'] as const) withHostDatabase(db => {
    const first = edit(db, [a, b], 'real shared journal')
    restoreAck(db, first.ack, 'undo')
    if (kind === 'action-shape') {
      const row = db.prepare('SELECT action_json FROM synced_host_history WHERE id=?').get(first.ack.historyToken) as { action_json: string }
      const raw = JSON.parse(row.action_json) as Record<string, unknown>; raw.unexpected = 'not a closed journal'
      db.prepare('UPDATE synced_host_history SET action_json=? WHERE id=?').run(JSON.stringify(raw), first.ack.historyToken)
    } else if (kind === 'before-hash') db.prepare('UPDATE synced_host_history SET before_hash=? WHERE id=?').run('0'.repeat(64), first.ack.historyToken)
    else db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=? AND document_id=?').run(first.ack.historyToken, b)
    const input = request(db, [a], after => changeBody(after[0], 'must not prune corrupted authority')), before = allTables(db)
    assert.throws(() => applySyncedHostFinal(db, input), /日志|历史|journal|history|hash|参与|分支/i, kind)
    assert.deepEqual(allTables(db), before)
  })
})

test('caller-owned transactions cannot turn a savepoint into a durable structure ACK or inverse', () => withHostDatabase(db => {
  const first = edit(db, [a], 'actual journal'), next = request(db, [a], after => changeBody(after[0], 'outer transaction must fail'))
  const restore = restoreInput(db, first.ack, 'undo'), before = allTables(db)
  db.transaction(() => {
    assert.throws(() => applySyncedHostFinal(db, next), /独占|外层|事务|transaction/i)
    assert.throws(() => restoreSyncedHostOperation(db, restore), /独占|外层|事务|transaction/i)
  })()
  assert.deepEqual(allTables(db), before)
}))

test('inverse birth and owner authority comes from the real journal and cannot be replaced by generic same-host recovery', () => {
  for (const kind of ['missing-birth', 'changed-birth', 'foreign-owner'] as const) withHostDatabase(db => {
    const id = ' inverse-only:retained ', input = request(db, [a], (after, before) => {
      before[0].workingBefore.blocks.push(freshBlock(id, 'original W birth'))
      changeBody(after[0], 'A omits the journal-only child')
    })
    const ack = applied(applySyncedHostFinal(db, input)), original = identity(db, id)
    assert.ok(original?.created_at, 'The real writer stored the exact journal-only child birth')
    if (kind === 'foreign-owner') db.prepare('UPDATE block_identities SET last_owner_id=? WHERE id=?').run(b, id)
    else db.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(kind === 'missing-birth' ? null : born, id)
    const tail = getSyncedHostHistory(db, { documentId: a })
    unchanged(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
    assert.deepEqual(getSyncedHostHistory(db, { documentId: a }), tail)
    db.prepare('UPDATE block_identities SET last_owner_id=?,created_at=? WHERE id=?').run(original.last_owner_id, original.created_at, id)
    restoreAck(db, ack, 'undo')
    assert.equal(bodyBirth(db, id), original.created_at, 'Restoring the actual journal authority makes the same inverse valid')
  })
})

test('a fresh current CAS does not let an old token cross another host operation tail', () => withHostDatabase(db => {
  const earlier = edit(db, [a], 'earlier exact side'), later = edit(db, [a], 'later exact side')
  unchanged(db, () => restoreSyncedHostOperation(db, restoreInput(db, earlier.ack, 'undo')), 'conflict')
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, later.ack.historyToken)
  restoreAck(db, later.ack, 'undo')
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, earlier.ack.historyToken)
  restoreAck(db, earlier.ack, 'undo')
  expectLogical(db, { documentId: a, ...earlier.input.hostsWorkingBefore[0].workingBefore })
}))

test('a late inverse receipt failure rolls back restored rows retained identities topology and cursor before exact retry', () => withHostDatabase(db => {
  const input = request(db, [a], after => { after[0].blocks = [freshBlock(' inverse:A-only ', 'only final A')] })
  const ack = applied(applySyncedHostFinal(db, input)), restore = restoreInput(db, ack, 'undo')
  db.exec(`CREATE TRIGGER fixture_fail_inverse_receipt BEFORE INSERT ON synced_operations
    BEGIN SELECT RAISE(ABORT,'injected inverse receipt failure'); END;`)
  const before = allTables(db)
  assert.throws(() => restoreSyncedHostOperation(db, restore), /injected inverse receipt failure/)
  assert.deepEqual(allTables(db), before)
  db.exec('DROP TRIGGER fixture_fail_inverse_receipt')
  applied(restoreSyncedHostOperation(db, restore))
  expectLogical(db, { documentId: a, ...input.hostsWorkingBefore[0].workingBefore })
}))

test('inverse rejects a missing older host mapping even when the requested latest journal and current tail are intact', () => withHostDatabase(db => {
  const first = edit(db, [a], 'first real journal'), second = edit(db, [a], 'second real journal')
  const state = db.prepare('SELECT position FROM synced_host_history_state WHERE document_id=?').get(a) as { position: number }
  assert.equal(state.position, 2, 'The real writer produced a two-operation executed history chain')
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, second.ack.historyToken)
  assert.equal(db.prepare('DELETE FROM synced_host_history_documents WHERE document_id=? AND history_id=? AND position=1').run(a, first.ack.historyToken).changes, 1,
    'Only the older actual mapping is removed; the latest requested journal and mapping remain intact')
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, second.ack.historyToken,
    'The ordinary tail reader alone still sees the latest token and cannot prove prefix continuity')
  const input = restoreInput(db, second.ack, 'undo'), before = allTables(db)
  assert.throws(() => restoreSyncedHostOperation(db, input), /映射|连续|链|位置|日志|历史|mapping|chain|history|position/i,
    'Undo must reject the incomplete older prefix before committing position one with a missing tail')
  assert.deepEqual(allTables(db), before, 'Rejecting the broken history prefix preserves all persistent tables and does not repair it')
}))
