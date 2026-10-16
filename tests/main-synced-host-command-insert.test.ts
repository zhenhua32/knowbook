import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { syncedCanonicalEdits, SYNCED_PROJECTED_MAX_BYTES } from '../src/shared/syncedBlockValidation'
import { validateSyncedStructureInput } from '../src/shared/syncedBlockInputs'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, getSyncedOperationWithLinkSource,
  releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import { createdGroup27, retireFixture27 } from './helpers/synced-lifecycle-fixture'
import { ordinary } from './helpers/synced-content-fixture'
import { withHostDatabase, a, b, c, bodyId, secondGroup, groupId, instanceId, born, now,
  command, insertAck, reference, groupGuard, parentChain, type InsertCommand,
  request, logical, copy, freshBlock, edit, restoreInput, restoreAck, snapshot, groupEdit,
  applySyncedHostFinal, applySyncedHostCommand, restoreSyncedHostOperation, getSyncedHostHistory,
  allTables, totalChanges, identity, bodyBirth, changeBody } from './helpers/synced-host-command-insert-fixture'

const encode = canonicalSyncedPortableJson
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ids = (db: Database.Database, id = a) => logical(db, id).blocks.map(block => block.id)
function rejected(db: Database.Database, run: () => ReturnType<typeof applySyncedHostCommand>, status?: string) {
  const before = allTables(db), result = run()
  assert.ok(result.status !== 'applied' && result.status !== 'noop', 'A rejected command cannot claim a committed ACK')
  if (status) assert.equal(result.status, status)
  assert.deepEqual(allTables(db), before, 'Every persistent table remains byte-for-value unchanged')
  return result
}
function operation(db: Database.Database, id: string) {
  const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(id) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  assert.ok(row, 'The actual writer committed the original operation row'); return row
}
function journal(db: Database.Database, token: string | null) {
  assert.ok(token, 'The actual logical delta has a nonnull persistent history token')
  const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
    .get(token) as { id: string; action_json: string; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string } | undefined
  assert.ok(row, 'The original immutable journal row exists'); return row
}
function expectWorking(db: Database.Database, input: InsertCommand) {
  assert.equal(encode(logical(db, input.action.target.documentId)), encode({ documentId: input.action.target.documentId,
    ...input.hostsWorkingBefore[0].workingBefore }))
}
function assertOnlyInsert(db: Database.Database, input: InsertCommand) {
  const actual = logical(db, input.action.target.documentId), before = input.hostsWorkingBefore[0].workingBefore
  assert.equal(actual.title, before.title); assert.equal(actual.summary, before.summary)
  assert.deepEqual(actual.blocks.filter(block => block.id !== input.action.instanceId), before.blocks,
    'The real writer preserves every W block, its fields and its relative order')
  const inserted = actual.blocks.find(block => block.id === input.action.instanceId)
  assert.ok(inserted, 'The actual target host contains the authorized new reference')
  assert.deepEqual(inserted, reference(input.action.instanceId, input.action.groupId, input.action.target.depth, input.action.target.parentBlockId))
}
function mixedRedo(db: Database.Database) {
  const prefix = edit(db, [c], 'executed prefix')
  const ab = edit(db, [a, b], 'shared AB'), inserted = command(db, { documentId: b, groupId: secondGroup })
  const insert = { input: inserted, ack: insertAck(applySyncedHostCommand(db, inserted)) }
  const bc = edit(db, [b, c], 'shared BC'), tail = edit(db, [c], 'peer tail')
  for (const item of [tail, bc, insert, ab]) restoreAck(db, item.ack, 'undo')
  return { prefix, ab, insert, bc, tail }
}
function deepen(db: Database.Database) {
  const root = syncedCanonicalEdits(snapshot(db).blocks)[0]
  return groupEdit(db, [{ ...root, type: 'toggle' }, { ...freshBlock(' inserted-group:depth1 ', 'nested'), depth: 1, parentBlockId: root.id }])
}

test('insert commits the original command request hash finite journal and real reference registry before exact inverse', () => withHostDatabase(db => {
  const input = command(db), frozen = copy(input), old = snapshot(db), oldBinding = old.instances.find(item => item.instanceId === instanceId)!.bindingVersion
  const ack = insertAck(applySyncedHostCommand(db, input)), row = journal(db, ack.historyToken), action = JSON.parse(row.action_json)
  assert.deepEqual(input, frozen)
  assert.deepEqual(validateSyncedStructureInput(input), input)
  assert.equal(operation(db, ack.operationId).request_hash, sha(encode({ method: 'applySyncedHostCommand', input })))
  assert.equal(action.kind, 'host-command'); assert.equal(action.version, 1); assert.deepEqual(action.input, input)
  assert.deepEqual(JSON.parse(row.before_json), [{ documentId: a, content: input.hostsWorkingBefore[0].workingBefore }])
  assert.equal(row.before_hash, sha(encode(JSON.parse(row.before_json)))); assert.equal(row.after_hash, sha(encode(JSON.parse(row.after_json))))
  assertOnlyInsert(db, input)
  const recordedAfter = JSON.parse(row.after_json) as Array<{ documentId: string; content: { title: string; summary: string; blocks: Array<Record<string, unknown>> } }>
  assert.equal(recordedAfter.length, 1); assert.equal(recordedAfter[0].documentId, a)
  const { documentId: _documentId, ...actualAfter } = logical(db, a)
  assert.equal(encode({ ...recordedAfter[0].content, blocks: recordedAfter[0].content.blocks.map(block => ({ ...block, tags: block.tags ?? [] })) }), encode(actualAfter))
  const acceptedBirths = action.births as Array<{ documentId: string; blockId: string; createdAt: string }>
  assert.deepEqual(acceptedBirths.map(item => item.blockId).sort(), [...input.hostsWorkingBefore[0].workingBefore.blocks.map(block => block.id), input.action.instanceId].sort())
  for (const item of acceptedBirths) { assert.equal(item.documentId, a); assert.equal(item.createdAt, bodyBirth(db, item.blockId)) }
  assert.equal(snapshot(db).instances.find(item => item.instanceId === instanceId)!.bindingVersion, oldBinding)
  assert.notEqual(snapshot(db).topologyRevision, old.topologyRevision)
  const inserted = snapshot(db).instances.find(item => item.instanceId === input.action.instanceId)!
  assert.ok(inserted); assert.equal(inserted.hostDocumentId, a); assert.equal(inserted.depth, 0); assert.equal(inserted.parentBlockId, null)
  const birth = bodyBirth(db, input.action.instanceId)
  assert.ok(birth); assert.equal(identity(db, input.action.instanceId)?.created_at, birth)
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, ack.historyToken)
  assert.ok((allTables(db).synced_group_pins as Array<{ group_id: string; kind: string; pin_id: string }>).some(pin => pin.group_id === groupId && pin.kind === 'host-history' && pin.pin_id === ack.historyToken))
  const lookup = getSyncedOperation(db, { clientOperationId: ack.operationId })
  assert.equal(lookup.status, 'committed')
  if (lookup.status !== 'committed') throw new Error('Original command ACK is committed')
  assert.equal(encode(lookup.result), encode({ ...ack, replayed: true }))
  restoreAck(db, ack, 'undo'); expectWorking(db, input)
  assert.equal(identity(db, input.action.instanceId)?.state, 'retained')
  restoreAck(db, ack, 'redo'); assertOnlyInsert(db, input)
  assert.equal(bodyBirth(db, input.action.instanceId), birth)
  assert.notEqual(snapshot(db).instances.find(item => item.instanceId === input.action.instanceId)!.bindingVersion, inserted.bindingVersion)
}))

test('dirty ordinary W and a W-only child anchor keep exact metadata summary and accepted births through undo redo', () => withHostDatabase((db, second) => {
  const owner = ' new W:parent ', anchor = ' new W:anchor\0 ', input = command(db, { dirty: working => {
    changeBody(working, 'unacknowledged W body 中文'); working.summary = ' raw dirty summary \r\n\t'
    const body = working.blocks.find(block => block.id === bodyId(a))!
    body.type = 'todo'; body.checked = true; body.tags = ['exact']; body.highlight = 'yellow'; body.markdownFormat = { listMarker: '+', listLoose: true }
    working.blocks.push({ ...freshBlock(owner, 'Dirty parent'), type: 'toggle' }, { ...freshBlock(anchor, 'Dirty child'), depth: 1, parentBlockId: owner })
  }, target: { parentBlockId: owner, beforeBlockId: anchor, depth: 1 } })
  const ack = insertAck(applySyncedHostCommand(db, input)), births = [owner, anchor, input.action.instanceId].map(id => bodyBirth(db, id))
  assertOnlyInsert(db, input); assert.ok(births.every(Boolean))
  assert.deepEqual(ids(db).slice(-3), [owner, input.action.instanceId, anchor])
  const reopened = second()
  restoreAck(reopened, ack, 'undo'); expectWorking(reopened, input)
  assert.deepEqual([owner, anchor].map(id => bodyBirth(reopened, id)), births.slice(0, 2))
  restoreAck(reopened, ack, 'redo'); assertOnlyInsert(reopened, input)
  assert.deepEqual([owner, anchor, input.action.instanceId].map(id => bodyBirth(reopened, id)), births)
}))

test('root beforeBlockId inserts before the exact stable root without changing existing bindings or W', () => withHostDatabase(db => {
  const input = command(db, { target: { beforeBlockId: bodyId(a) } }), old = snapshot(db)
  insertAck(applySyncedHostCommand(db, input)); assertOnlyInsert(db, input)
  assert.deepEqual(ids(db), [instanceId, input.action.instanceId, bodyId(a)])
  assert.equal(snapshot(db).instances.find(item => item.instanceId === instanceId)!.bindingVersion, old.instances[0].bindingVersion)
}))

test('null beforeBlockId appends after the entire selected parent subtree rather than before its descendants', () => withHostDatabase(db => {
  const owner = ' dirty:toggle ', nested = ' dirty:inner ', child = ' dirty:leaf ', outside = ' dirty:outside '
  const input = command(db, { dirty: working => working.blocks.push({ ...freshBlock(owner), type: 'toggle' },
    { ...freshBlock(nested), type: 'callout', depth: 1, parentBlockId: owner },
    { ...freshBlock(child), depth: 2, parentBlockId: nested }, freshBlock(outside)),
    target: { parentBlockId: owner, beforeBlockId: null, depth: 1 } })
  insertAck(applySyncedHostCommand(db, input)); assertOnlyInsert(db, input)
  assert.deepEqual(ids(db).slice(-5), [owner, nested, child, input.action.instanceId, outside])
}))

test('a legal column target preserves the complete weighted columns and inserts only its leaf child', () => withHostDatabase(db => {
  const columns = ' W:columns ', left = ' W:left ', right = ' W:right ', anchor = ' W:leftbody '
  const input = command(db, { dirty: working => working.blocks.push({ ...freshBlock(columns, ''), type: 'columns' },
    { ...freshBlock(left, ''), type: 'column', depth: 1, parentBlockId: columns, markdownFormat: { columnWeight: 5000 } },
    { ...freshBlock(anchor), depth: 2, parentBlockId: left },
    { ...freshBlock(right, ''), type: 'column', depth: 1, parentBlockId: columns, markdownFormat: { columnWeight: 5000 } },
    { ...freshBlock(' W:rightbody '), depth: 2, parentBlockId: right }),
    target: { parentBlockId: left, beforeBlockId: anchor, depth: 2 } })
  const ack = insertAck(applySyncedHostCommand(db, input)); assertOnlyInsert(db, input)
  assert.deepEqual(ids(db).slice(-6), [columns, left, input.action.instanceId, anchor, right, ' W:rightbody '])
  restoreAck(db, ack, 'undo'); expectWorking(db, input)
}))

test('missing anchors wrong direct parents depths and closed-subtree anchors fail without guessed placement or writes', () => {
  for (const kind of ['missing-anchor', 'missing-parent', 'wrong-depth', 'not-direct-child', 'closed-subtree', 'root-depth'] as const) withHostDatabase(db => {
    const owner = ' W:parent ', child = ' W:child ', outside = ' W:outside '
    const input = command(db, { dirty: working => working.blocks.push({ ...freshBlock(owner), type: 'toggle' },
      { ...freshBlock(child), depth: 1, parentBlockId: owner }, freshBlock(outside)),
      target: { parentBlockId: owner, beforeBlockId: child, depth: 1 } })
    if (kind === 'missing-anchor') input.action.target.beforeBlockId = 'absent stable anchor'
    if (kind === 'missing-parent') input.action.target.parentBlockId = 'absent stable parent'
    if (kind === 'wrong-depth') input.action.target.depth = 2
    if (kind === 'not-direct-child') input.action.target.beforeBlockId = owner
    if (kind === 'closed-subtree') input.action.target.beforeBlockId = outside
    if (kind === 'root-depth') { input.action.target.parentBlockId = null; input.action.target.beforeBlockId = null; input.action.target.depth = 1 }
    const changes = totalChanges(db)
    rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
    assert.equal(totalChanges(db), changes, kind + ': invalid planning never begins provisional DML')
  })
})

test('transparent references obey the current canonical root parent role rather than a placeholder type exemption', () => {
  for (const listRoot of [false, true]) withHostDatabase(db => {
    if (listRoot) groupEdit(db, syncedCanonicalEdits(snapshot(db).blocks).map(block => ({ ...block, type: 'bulleted-list' })))
    const owner = ' dirty:list-owner ', input = command(db, { dirty: working => working.blocks.push({ ...freshBlock(owner), type: 'bulleted-list' }),
      target: { parentBlockId: owner, depth: 1 } })
    if (listRoot) { insertAck(applySyncedHostCommand(db, input)); assertOnlyInsert(db, input) }
    else rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
  })
})

test('expanded canonical depth is checked at the exact target without clamping six-level W parents', () => withHostDatabase(db => {
  deepen(db)
  const input = command(db, { dirty: working => { parentChain(working, 6, ' depth:'); },
    target: { parentBlockId: ' depth:5', depth: 6 } })
  const result = rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
  assert.ok(result.status === 'invalid' && result.code === 'depth')
}))

test('actual projected bytes count inserted canonical payload against the unchanged sixteen MiB host budget', () => withHostDatabase(db => {
  assert.equal(SYNCED_PROJECTED_MAX_BYTES, 16 * 1024 * 1024)
  groupEdit(db, syncedCanonicalEdits(snapshot(db).blocks).map(block => ({ ...block, content: 'G'.repeat(4 * 1024 * 1024) })))
  const input = command(db, { documentId: b, dirty: working => { working.blocks[0].content = 'W'.repeat(13 * 1024 * 1024) } })
  const result = rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
  assert.ok(result.status === 'invalid' && result.code === 'budget')
}))

test('insert UUID cannot reuse live ordinary canonical retained reserved or foreign identities', () => {
  for (const kind of ['ordinary', 'canonical', 'retained', 'reserved', 'foreign', 'existing-instance'] as const) withHostDatabase(db => {
    let id: string = randomUUID()
    if (kind === 'canonical') {
      const root = syncedCanonicalEdits(snapshot(db).blocks)[0]
      groupEdit(db, [{ ...root, type: 'toggle' }, { ...freshBlock(id), depth: 1, parentBlockId: root.id }])
    } else if (kind === 'retained' || kind === 'reserved') {
      db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,?,?,'retained',?)")
        .run(id, kind === 'reserved' ? 'reserved' : 'document', a, born)
    } else if (kind === 'existing-instance') id = instanceId
    else ordinary(db, id, { owner: kind === 'foreign' ? b : a, type: 'paragraph', sort: 2 })
    const input = command(db, { instanceId: id })
    rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
  })
})

test('a command grants only its typed fresh ref and cannot smuggle a W-only fresh ref or internal source DTO', () => {
  for (const internal of [false, true]) withHostDatabase(db => {
    const extra = randomUUID(), input = command(db, { dirty: working => working.blocks.push(reference(extra, groupId)) })
    const value = internal ? { ...input, newRefSources: [{ kind: 'internal', instanceId: extra,
      identity: { workspaceScope: '00000000-0000-0000-0000-000000000900', groupId, creationId: snapshot(db).creationId } }] } : input
    const result = rejected(db, () => applySyncedHostCommand(db, value), internal ? 'invalid' : 'unsupported')
    if (!internal) assert.ok(result.status === 'unsupported' && result.reason === 'working-structure')
  })
})

test('W cannot implicitly delete move or reorder persisted ordinary IDs before the explicit insert', () => {
  for (const kind of ['delete', 'move', 'reorder'] as const) withHostDatabase(db => {
    const extra = ' second persisted:body '
    ordinary(db, extra, { owner: a, type: 'paragraph', sort: 2 })
    const input = command(db, { dirty: working => {
      if (kind === 'delete') working.blocks = working.blocks.filter(block => block.id !== bodyId(a))
      else if (kind === 'reorder') { const first = working.blocks.findIndex(block => block.id === bodyId(a)); const second = working.blocks.findIndex(block => block.id === extra); [working.blocks[first], working.blocks[second]] = [working.blocks[second], working.blocks[first]] }
      else { const parent = ' W-only:move-parent '; const index = working.blocks.findIndex(block => block.id === bodyId(a)); working.blocks.splice(index, 0, { ...freshBlock(parent), type: 'toggle' }); const body = working.blocks.find(block => block.id === bodyId(a))!; body.parentBlockId = parent; body.depth = 1 }
    } })
    const count = totalChanges(db), result = rejected(db, () => applySyncedHostCommand(db, input), 'unsupported')
    assert.ok(result.status === 'unsupported' && result.reason === 'working-structure'); assert.equal(totalChanges(db), count)
  })
})

test('W cannot retarget remove mutate or reparent an existing reference under the insert authority', () => {
  for (const kind of ['retarget', 'remove', 'metadata', 'parent'] as const) withHostDatabase(db => {
    const input = command(db), working = input.hostsWorkingBefore[0].workingBefore, ref = working.blocks.find(block => block.id === instanceId)!
    if (kind === 'retarget') { ref.content = reference(instanceId, secondGroup).content; input.groups.push(groupGuard(db, secondGroup)) }
    else if (kind === 'remove') working.blocks = working.blocks.filter(block => block.id !== instanceId)
    else if (kind === 'metadata') ref.tags = ['unauthorized ref metadata']
    else { working.blocks.unshift({ ...freshBlock(' dirty ref parent '), type: 'toggle' }); ref.parentBlockId = ' dirty ref parent '; ref.depth = 1 }
    const result = rejected(db, () => applySyncedHostCommand(db, input), 'unsupported')
    assert.ok(result.status === 'unsupported' && result.reason === 'working-structure')
  })
})

test('title changes and other typed commands stay unsupported with zero normalization or provisional writes', () => {
  for (const kind of ['title', 'delete', 'detach'] as const) withHostDatabase(db => {
    const input = command(db)
    const value = kind === 'delete' ? { ...input, action: { kind: 'delete', selection: { documentId: a, selectedRootIds: [bodyId(a)] } } }
      : kind === 'detach' ? { ...input, action: { kind: 'detach', instanceId, groupId } } : input
    if (kind === 'title') input.hostsWorkingBefore[0].workingBefore.title += ' unsaved title'
    const count = totalChanges(db), result = rejected(db, () => applySyncedHostCommand(db, value), 'unsupported')
    assert.ok(result.status === 'unsupported' && result.reason === (kind === 'title' ? 'title-change' : 'command'))
    assert.equal(totalChanges(db), count)
  })
})

test('insert cannot silently rename an existing ordinary heading or rewrite its real incoming links from dirty W', () => withHostDatabase(db => {
  db.prepare("UPDATE blocks SET type='heading-2',content='Original heading' WHERE id=?").run(bodyId(a))
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[Original heading](Host%20A.md#original-heading)', bodyId(b))
  db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)')
    .run(randomUUID(), b, a, 'Original heading', born)
  const input = command(db, { dirty: working => { working.blocks.find(block => block.id === bodyId(a))!.content = 'Renamed heading' } })
  const count = totalChanges(db), result = rejected(db, () => applySyncedHostCommand(db, input), 'unsupported')
  assert.ok(result.status === 'unsupported' && result.reason === 'heading-rewrite')
  assert.equal(totalChanges(db), count)
}))

test('changing a persisted reference parent role inside W is a separate unsupported structural action', () => withHostDatabase(db => {
  const parent = ' actual persisted ref owner '
  db.transaction(() => {
    db.prepare('DELETE FROM synced_instances WHERE instance_id=?').run(instanceId)
    ordinary(db, parent, { owner: a, type: 'toggle', sort: 0 })
    db.prepare('UPDATE blocks SET parent_block_id=?,depth=1,sort_order=1 WHERE id=?').run(parent, instanceId)
    db.prepare('UPDATE blocks SET sort_order=2 WHERE id=?').run(bodyId(a))
    db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,1)')
      .run(instanceId, groupId, a, randomUUID(), parent)
    db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=?').run(randomUUID(), groupId)
  })()
  assert.equal(snapshot(db).instances[0].parentType, 'toggle', 'The original actual parent role is valid before the unsupported W edit')
  const input = command(db, { dirty: working => { working.blocks.find(block => block.id === parent)!.type = 'callout' } })
  const result = rejected(db, () => applySyncedHostCommand(db, input), 'unsupported')
  assert.ok(result.status === 'unsupported' && result.reason === 'working-structure')
}))

test('missing or genuinely retired groups are unavailable and are never reactivated by insert', () => {
  for (const retired of [false, true]) withHostDatabase(db => {
    const input = command(db), target = retired ? createdGroup27(db) : undefined
    if (target) retireFixture27(db, target)
    input.action.groupId = target?.groupId ?? randomUUID()
    input.groups.push(target ? groupGuard(db, target.groupId) : { groupId: input.action.groupId, expectedRevision: randomUUID(), expectedTopologyRevision: randomUUID() })
    rejected(db, () => applySyncedHostCommand(db, input), 'missing')
  })
})

test('real host group topology and existing-instance CAS guards reject stale commands atomically', () => {
  for (const kind of ['host', 'group', 'topology', 'binding'] as const) withHostDatabase(db => {
    const input = command(db)
    if (kind === 'host') input.hostsWorkingBefore[0].expectedPersistedUpdatedAt = born
    else if (kind === 'group') input.groups[0].expectedRevision = randomUUID()
    else if (kind === 'topology') input.groups[0].expectedTopologyRevision = randomUUID()
    else input.expectedInstances[0].bindingVersion = randomUUID()
    rejected(db, () => applySyncedHostCommand(db, input), 'conflict')
  })
})

test('group and actual P instance guard closures reject omissions extra claims and a fresh destination guard', () => {
  for (const kind of ['missing-group', 'extra-group', 'missing-instance', 'extra-instance'] as const) withHostDatabase(db => {
    const input = command(db)
    if (kind === 'missing-group') input.groups = []
    else if (kind === 'extra-group') input.groups.push(groupGuard(db, secondGroup))
    else if (kind === 'missing-instance') input.expectedInstances = []
    else input.expectedInstances.push({ instanceId: input.action.instanceId, hostDocumentId: a, bindingVersion: randomUUID() })
    rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
  })
})

test('the submitted W host set must be exactly the single typed target host with no peer DTO authority', () => {
  for (const kind of ['wrong-target', 'extra-W'] as const) withHostDatabase(db => {
    const input = command(db)
    if (kind === 'wrong-target') input.action.target.documentId = b
    else input.hostsWorkingBefore.push(request(db, [b]).hostsWorkingBefore[0])
    const result = rejected(db, () => applySyncedHostCommand(db, input), 'unsupported')
    assert.ok(result.status === 'unsupported' && result.reason === 'command')
  })
})

test('original complete command ACK replays before current CAS and preserves children links groups and operation bytes', () => withHostDatabase(db => {
  const child = ' command:child-document ', childPath = 'Home/Host A/Child'
  db.prepare('INSERT INTO documents(id,title,slug,path,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(child, 'Child', child, childPath, a, born, now)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[Host B](Host%20B.md)', bodyId(a))
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[Host A](Host%20A.md)', bodyId(b))
  for (const [from, to, label] of [[a, b, 'Host B'], [b, a, 'Host A']]) db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), from, to, label, born)
  const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), original = copy(operation(db, ack.operationId))
  assert.deepEqual(ack.hosts[0].after.children, [{ id: child, title: 'Child', path: childPath }])
  assert.ok(ack.hosts[0].after.outgoingLinks.length); assert.ok(ack.hosts[0].after.backlinks.length)
  db.prepare("UPDATE documents SET title='Later child',path='Home/Host A/Later child' WHERE id=?").run(child)
  db.prepare("UPDATE links SET label='later incoming label' WHERE target_document_id=?").run(a)
  edit(db, [a], 'later actual body'); groupEdit(db)
  const before = allTables(db)
  assert.equal(encode(insertAck(applySyncedHostCommand(db, input))), encode({ ...ack, replayed: true }))
  const lookup = getSyncedOperation(db, { clientOperationId: ack.operationId })
  assert.ok(lookup.status === 'committed'); if (lookup.status !== 'committed') throw new Error('Original command ACK remains committed')
  assert.equal(encode(lookup.result), encode({ ...ack, replayed: true }))
  assert.deepEqual(operation(db, ack.operationId), original); assert.deepEqual(allTables(db), before)
}))

test('same operation ID binds the original method action target instance and complete W before replay', () => {
  for (const kind of ['method', 'group', 'instance', 'target', 'W'] as const) withHostDatabase(db => {
    const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), changed = copy(input)
    if (kind === 'group') changed.action.groupId = secondGroup
    else if (kind === 'instance') changed.action.instanceId = randomUUID()
    else if (kind === 'target') changed.action.target.beforeBlockId = bodyId(a)
    else if (kind === 'W') changeBody(changed.hostsWorkingBefore[0].workingBefore, 'different original W')
    const result = rejected(db, () => kind === 'method' ? applySyncedHostFinal(db, input) : applySyncedHostCommand(db, changed), 'idempotency-mismatch')
    assert.equal(result.status, 'idempotency-mismatch'); assert.equal(operation(db, ack.operationId).client_operation_id, ack.operationId)
  })
})

test('corrupt stored full command ACKs reject generic lookup and exact replay without rebuilding today state', () => {
  for (const kind of ['envelope-extra', 'operation', 'missing-children', 'null-token', 'stored-replayed', 'empty-after', 'logical-before'] as const) withHostDatabase(db => {
    const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), row = operation(db, ack.operationId), envelope = JSON.parse(row.result_json)
    if (kind === 'envelope-extra') envelope.extra = true
    else if (kind === 'operation') envelope.result.operationId = randomUUID()
    else if (kind === 'missing-children') delete envelope.result.hosts[0].after.children
    else if (kind === 'null-token') envelope.result.historyToken = null
    else if (kind === 'stored-replayed') envelope.result.replayed = true
    else if (kind === 'empty-after') envelope.result.hosts[0].after.blocks = []
    else { envelope.result.hosts[0].logicalBefore.summary += ' forged'; envelope.result.hosts[0].logicalBeforeHash = sha(encode(envelope.result.hosts[0].logicalBefore)) }
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(envelope), ack.operationId)
    const before = allTables(db)
    if (kind !== 'logical-before') assert.throws(() => getSyncedOperation(db, { clientOperationId: ack.operationId }), /宿主|结构|回执|收据|ack/i)
    assert.throws(() => applySyncedHostCommand(db, input), /宿主|结构|回执|收据|W\/A|ack/i)
    assert.deepEqual(allTables(db), before)
  })
})

test('structure command receipts never become legacy or owned canonical source-signing ACKs', () => withHostDatabase(db => {
  const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), owner = captureSyncedBaselineOwner(db, { groupId })
  assert.equal(owner.status, 'ready'); if (owner.status !== 'ready') throw new Error('Actual active owner is required')
  try {
    assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId }), /回执|收据|结构|kind|ack/i)
    assert.throws(() => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId }), /回执|收据|结构|kind|ack/i)
  } finally { releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId }) }
}))

test('mixed host-final and command journals undo and redo in real tail order without changing either action namespace', () => withHostDatabase(db => {
  const first = edit(db, [a], 'host-final prefix'), input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), after = logical(db, a)
  assert.equal(JSON.parse(journal(db, first.ack.historyToken).action_json).kind, 'host-final')
  assert.equal(JSON.parse(journal(db, ack.historyToken).action_json).kind, 'host-command')
  restoreAck(db, ack, 'undo'); restoreAck(db, first.ack, 'undo')
  restoreAck(db, first.ack, 'redo'); restoreAck(db, ack, 'redo')
  assert.deepEqual(logical(db, a), after)
}))

test('a new command prunes mixed AB BC redo fixed points while preserving executed prefixes immutable journals pins and ACKs', () => withHostDatabase(db => {
  const chain = mixedRedo(db), before = allTables(db), oldOperations = [chain.prefix, chain.ab, chain.insert, chain.bc, chain.tail].map(item => copy(operation(db, item.input.clientOperationId)))
  const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), rows = allTables(db)
  const mappings = rows.synced_host_history_documents as Array<{ history_id: string; document_id: string }>
  const discarded = [chain.ab, chain.insert, chain.bc, chain.tail].map(item => item.ack.historyToken)
  assert.ok(!mappings.some(row => discarded.includes(row.history_id)))
  assert.ok(mappings.some(row => row.history_id === chain.prefix.ack.historyToken && row.document_id === c))
  for (const table of ['synced_host_history', 'synced_group_pins']) {
    const prior = before[table] as unknown[], current = rows[table] as unknown[]
    assert.deepEqual(current.filter(row => prior.some(value => encode(value) === encode(row))), prior)
  }
  for (const row of oldOperations) assert.deepEqual(operation(db, row.client_operation_id), row)
  assert.equal(getSyncedHostHistory(db, { documentId: c }).undoToken, chain.prefix.ack.historyToken)
  assert.equal(getSyncedHostHistory(db, { documentId: b }).redoToken, null)
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, ack.historyToken)
}))

test('host-final can prune a command redo branch through the same closed journal dispatcher', () => withHostDatabase(db => {
  const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)), row = copy(journal(db, ack.historyToken))
  restoreAck(db, ack, 'undo'); const next = edit(db, [a], 'host-final after undone command')
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, next.ack.historyToken)
  assert.equal(getSyncedHostHistory(db, { documentId: a }).redoToken, null)
  assert.deepEqual(journal(db, ack.historyToken), row)
  assert.equal((db.prepare('SELECT count(*) AS n FROM synced_host_history_documents WHERE history_id=?').get(ack.historyToken) as { n: number }).n, 0)
}))

test('late command receipt SQL failure rolls back insertion births topology mixed pruning indexes cursors and pins', () => withHostDatabase(db => {
  mixedRedo(db)
  const input = command(db, { dirty: working => working.blocks.push(freshBlock(' command:late-W-birth ')) })
  db.exec("CREATE TRIGGER fail_insert_command_ack BEFORE INSERT ON synced_operations BEGIN SELECT RAISE(ABORT,'injected command late receipt'); END")
  const before = allTables(db)
  assert.throws(() => applySyncedHostCommand(db, input), /injected command late receipt/)
  assert.deepEqual(allTables(db), before)
  db.exec('DROP TRIGGER fail_insert_command_ack')
  insertAck(applySyncedHostCommand(db, input)); assertOnlyInsert(db, input)
}))

test('two actual SQLite connections accept one command CAS and keep the stale client complete dirty W untouched', () => withHostDatabase((db, second) => {
  const peer = second(), first = command(db), stale = command(peer, { dirty: working => { changeBody(working, 'peer unsaved body'); working.summary = 'peer unsaved summary' } }), frozen = copy(stale)
  insertAck(applySyncedHostCommand(db, first))
  rejected(peer, () => applySyncedHostCommand(peer, stale), 'conflict')
  assert.deepEqual(stale, frozen); assertOnlyInsert(peer, first)
}))

test('new command journal action planned A hashes births and mappings fail closed before inverse or pruning', () => {
  for (const kind of ['extra-action', 'changed-target', 'forged-after', 'missing-birth', 'missing-mapping'] as const) withHostDatabase(db => {
    const input = command(db), ack = insertAck(applySyncedHostCommand(db, input))
    restoreAck(db, ack, 'undo')
    const row = journal(db, ack.historyToken), action = JSON.parse(row.action_json)
    if (kind === 'extra-action') { action.extra = true; db.prepare('UPDATE synced_host_history SET action_json=? WHERE id=?').run(JSON.stringify(action), row.id) }
    else if (kind === 'changed-target') { action.input.action.target.beforeBlockId = bodyId(a); db.prepare('UPDATE synced_host_history SET action_json=? WHERE id=?').run(JSON.stringify(action), row.id) }
    else if (kind === 'forged-after') { const after = JSON.parse(row.after_json); after[0].content.summary += ' self-hashed forged A'; db.prepare('UPDATE synced_host_history SET after_json=?,after_hash=? WHERE id=?').run(encode(after), sha(encode(after)), row.id) }
    else if (kind === 'missing-birth') { action.births.pop(); db.prepare('UPDATE synced_host_history SET action_json=? WHERE id=?').run(JSON.stringify(action), row.id) }
    else db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=?').run(row.id)
    const restore = restoreInput(db, ack, 'redo'), fresh = command(db), before = allTables(db)
    assert.throws(() => restoreSyncedHostOperation(db, restore), /日志|journal|历史|格式|birth|mappings|参与者/i)
    assert.deepEqual(allTables(db), before)
    if (kind !== 'missing-mapping') { assert.throws(() => applySyncedHostCommand(db, fresh), /日志|journal|历史|格式|birth|分支/i); assert.deepEqual(allTables(db), before) }
  })
})

test('command inverse preserves current legal canonical bodies and revision rather than replaying old group snapshots', () => withHostDatabase(db => {
  const input = command(db), ack = insertAck(applySyncedHostCommand(db, input))
  groupEdit(db); const current = snapshot(db)
  restoreAck(db, ack, 'undo')
  assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
  restoreAck(db, ack, 'redo')
  assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
  assertOnlyInsert(db, input)
}))

test('redo keeps its token when current canonical growth makes the original inserted projection illegal', () => withHostDatabase(db => {
  const input = command(db, { dirty: working => { parentChain(working, 6, ' inverse:parent:') },
    target: { parentBlockId: ' inverse:parent:5', depth: 6 } })
  const ack = insertAck(applySyncedHostCommand(db, input)); restoreAck(db, ack, 'undo')
  deepen(db); const current = snapshot(db), tail = getSyncedHostHistory(db, { documentId: a })
  rejected(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'redo')), 'invalid')
  assert.deepEqual(getSyncedHostHistory(db, { documentId: a }), tail)
  assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
  assert.equal(identity(db, input.action.instanceId)?.state, 'retained')
}))

test('redo retained instance authority requires the exact original journal birth and owner even on fresh current CAS', () => {
  for (const kind of ['birth', 'owner'] as const) withHostDatabase(db => {
    const input = command(db), ack = insertAck(applySyncedHostCommand(db, input)); restoreAck(db, ack, 'undo')
    const original = identity(db, input.action.instanceId)!
    db.prepare('UPDATE block_identities SET created_at=?,last_owner_id=? WHERE id=?')
      .run(kind === 'birth' ? born : original.created_at, kind === 'owner' ? b : original.last_owner_id, input.action.instanceId)
    rejected(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'redo')), 'invalid')
    db.prepare('UPDATE block_identities SET created_at=?,last_owner_id=? WHERE id=?').run(original.created_at, original.last_owner_id, input.action.instanceId)
    restoreAck(db, ack, 'redo'); assert.equal(bodyBirth(db, input.action.instanceId), original.created_at)
  })
})

test('old command tokens cannot bypass a later real tail or a missing older prefix mapping', () => {
  for (const missing of [false, true]) withHostDatabase(db => {
    const prefix = edit(db, [a], 'prefix before insert'), input = command(db), ack = insertAck(applySyncedHostCommand(db, input))
    if (missing) {
      assert.equal(db.prepare('DELETE FROM synced_host_history_documents WHERE document_id=? AND history_id=? AND position=1').run(a, prefix.ack.historyToken).changes, 1)
      const before = allTables(db)
      assert.throws(() => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')), /历史|位置|连续|映射|chain|history/i)
      assert.deepEqual(allTables(db), before)
    } else { edit(db, [a], 'later real tail'); rejected(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')), 'conflict') }
  })
})

test('caller transactions and disabled foreign keys cannot authorize command commits and inverse late SQL fully rolls back', () => withHostDatabase(db => {
  const input = command(db), before = allTables(db)
  db.transaction(() => { assert.throws(() => applySyncedHostCommand(db, input), /外层|事务|transaction/i) })()
  assert.deepEqual(allTables(db), before)
  db.pragma('foreign_keys=OFF')
  assert.throws(() => applySyncedHostCommand(db, input), /外键|foreign/i)
  assert.deepEqual(allTables(db), before); db.pragma('foreign_keys=ON')
  const ack = insertAck(applySyncedHostCommand(db, input)), restore = restoreInput(db, ack, 'undo')
  db.exec("CREATE TRIGGER fail_command_inverse_ack BEFORE INSERT ON synced_operations BEGIN SELECT RAISE(ABORT,'injected command inverse receipt'); END")
  const inserted = allTables(db)
  assert.throws(() => restoreSyncedHostOperation(db, restore), /injected command inverse receipt/)
  assert.deepEqual(allTables(db), inserted); db.exec('DROP TRIGGER fail_command_inverse_ack')
  insertAck(restoreSyncedHostOperation(db, restore)); expectWorking(db, input)
}))
