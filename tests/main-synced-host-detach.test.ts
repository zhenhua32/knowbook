import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import type { SyncedStructureInput } from '../src/shared/synced-blocks'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { KnowbookStore } from '../src/main/database/store'
import { readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { captureSyncedCreateSourceFacts } from '../src/main/database/synced-host-create-plan'
import { detachConsumerTrace } from '../src/main/database/synced-host-detach-namespace'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { command } from './helpers/synced-host-command-insert-fixture'
import { bodyBirth, changeBody, identity, request, restoreInput, totalChanges } from './helpers/synced-host-final-fixture'
import { allTables, createRequest, freshBlock, randomUUID, snapshot, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('detaching one real instance creates independent block identities, retains navigation, and restores the exact host sides only at the original group content', () => withV3Fixture(f => {
  const source = f.store.createDocument(null)
  const folder = f.store.createDocument(null)
  const destination = f.store.createDocument(folder)
  const sender = Object.freeze({ purpose: 'real detached instance' })
  const openHost = (id: string) => {
    const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: id })
    if (opened.status !== 'ready') throw new Error('Expected a genuine host session')
    return opened.session.sessionId
  }
  const apply = (sessionId: string, input: SyncedStructureInput) => f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input })
  const parentId = randomUUID(), childId = randomUUID(), destinationBodyId = randomUUID()
  f.store.updateDocument(source, { title: 'Detach original', summary: '', blocks: [freshBlock(randomUUID(), 'Original host text')] })
  f.store.updateDocument(folder, { title: 'Detach folder', summary: '', blocks: [freshBlock(randomUUID(), 'Folder')] })
  f.store.updateDocument(destination, { title: 'Detach destination', summary: '', blocks: [freshBlock(destinationBodyId, 'Destination body')] })
  const create = createRequest(f.db, { documentId: source, selectedRootIds: [parentId], dirty(working) {
    working.blocks.push({ ...freshBlock(parentId, 'Canonical parent'), type: 'toggle' }, {
      ...freshBlock(childId, `[internal](#^${parentId}) [origin]() [external](V3%20Target.md#^${f.targetBodyId})`),
      parentBlockId: parentId, depth: 1, tags: ['kept'], highlight: 'green'
    })
  } })
  assert.equal(apply(openHost(source), create).status, 'applied')
  const { groupId, instanceId: originalInstanceId } = create.action
  const insert = command(f.db, { documentId: destination, groupId })
  assert.equal(apply(openHost(destination), insert).status, 'applied')
  const destinationInstanceId = insert.action.instanceId
  const groupBefore = snapshot(f.db, groupId)
  assert.equal(groupBefore.instances.length, 2)
  assert.equal(groupBefore.bindings.length, 3)
  assert.ok(groupBefore.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === parentId))
  assert.ok(groupBefore.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === f.targetBodyId))
  assert.ok(groupBefore.bindings.some(binding => binding.from === binding.to && binding.raw === ''
    && binding.target.kind === 'document' && binding.target.id === source))
  const sourceHost = readStrictHostDocument(f.db, source)!.content
  const working = request(f.db, [destination]).hostsWorkingBefore
  changeBody(working[0].workingBefore, 'Retained dirty W')
  working[0].workingBefore.summary = 'Retained summary W'
  const guarded = request(f.db, [destination])
  const input: SyncedStructureInput = { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: working,
    groups: guarded.groups, expectedInstances: guarded.expectedInstances, action: { kind: 'detach', groupId, instanceId: destinationInstanceId } }
  const sessionId = openHost(destination)
  const beforeFault = allTables(f.db)
  f.db.exec(`CREATE TEMP TRIGGER refuse_detach_receipt BEFORE INSERT ON synced_operations
    BEGIN SELECT RAISE(ABORT, 'deliberate detach receipt failure'); END`)
  try {
    assert.throws(() => apply(sessionId, input), /deliberate detach receipt failure/)
    assert.deepEqual(allTables(f.db), beforeFault, 'A late acknowledgement failure rolls back the complete host and group topology')
  } finally {
    f.db.exec('DROP TRIGGER refuse_detach_receipt')
  }
  const ack = apply(sessionId, input)
  if (ack.status !== 'applied') throw new Error('Actual Main must detach this instance: ' + JSON.stringify(ack))
  assert.ok(ack.historyToken)
  assert.deepEqual(ack.hosts[0].logicalBefore, working[0].workingBefore)
  assert.deepEqual(ack.affectedInstanceIds, [destinationInstanceId])
  const copies = new Map(ack.blockIdMap.map(entry => [entry.from, entry.to]))
  assert.deepEqual([...copies.keys()].sort(), [parentId, childId].sort())
  const parent = copies.get(parentId)!, child = copies.get(childId)!
  assert.equal(new Set([parent, child, parentId, childId, originalInstanceId, destinationInstanceId]).size, 6)
  const after = readStrictHostDocument(f.db, destination)!.content
  assert.deepEqual(after.blocks.map(block => block.id), [destinationBodyId, parent, child])
  assert.equal(after.blocks[0].content, 'Retained dirty W')
  assert.equal(after.summary, 'Retained summary W')
  assert.deepEqual(after.blocks.slice(1).map(({ parentBlockId, depth }) => [parentBlockId, depth]), [[null, 0], [parent, 1]])
  assert.deepEqual(after.blocks[2].tags, ['kept'])
  assert.equal(after.blocks[2].highlight, 'green')
  const detachedPath = f.store.getDocumentDetail(destination)!.path
  const linkRows = f.db.prepare('SELECT target_path,fragment FROM markdown_link_sources WHERE source_document_id=? AND source_block_id=? ORDER BY source_offset')
    .all(destination, child)
  assert.deepEqual(linkRows, [{ target_path: detachedPath, fragment: '^' + parent }, { target_path: 'Detach original', fragment: '' },
    { target_path: 'V3 Target', fragment: '^' + f.targetBodyId }])
  assert.deepEqual(readStrictHostDocument(f.db, source)!.content, sourceHost)
  const detachedGroup = snapshot(f.db, groupId)
  assert.deepEqual(detachedGroup.blocks, groupBefore.blocks)
  assert.deepEqual(detachedGroup.bindings, groupBefore.bindings)
  assert.equal(detachedGroup.revision, groupBefore.revision)
  assert.notEqual(detachedGroup.topologyRevision, groupBefore.topologyRevision)
  assert.deepEqual(detachedGroup.instances, groupBefore.instances.filter(instance => instance.instanceId === originalInstanceId))
  const births = [bodyBirth(f.db, parent), bodyBirth(f.db, child)]
  assert.ok(births.every(Boolean))
  for (const id of [parent, child]) assert.equal(identity(f.db, id)?.last_owner_id, destination)
  const stored = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId)
  const beforeReplay = allTables(f.db), changesBeforeReplay = totalChanges(f.db)
  assert.deepEqual(f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'getSyncedOperation', input: {
    clientOperationId: input.clientOperationId
  } }), { status: 'committed', result: { ...ack, replayed: true } })
  assert.deepEqual(allTables(f.db), beforeReplay)
  assert.equal(totalChanges(f.db), changesBeforeReplay)
  const journalBirth = f.db.prepare('SELECT created_at FROM synced_host_history WHERE id=?').pluck().get(ack.historyToken)
  const setJournalBirth = f.db.prepare('UPDATE synced_host_history SET created_at=? WHERE id=?')
  setJournalBirth.run('2001-01-01T00:00:00.000Z', ack.historyToken)
  try {
    assert.throws(() => f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'getSyncedOperation', input: {
      clientOperationId: input.clientOperationId
    } }), /回执与同一次实际请求|收据损坏/)
  } finally {
    setJournalBirth.run(journalBirth, ack.historyToken)
  }
  const restore = (direction: 'undo' | 'redo') => f.store.invokeSyncedEditingSession(sender, {
    sessionId: openHost(destination), method: 'restoreSyncedHostOperation', input: restoreInput(f.db, ack, direction)
  })
  const external = f.store.createDocument(null), externalBlock = randomUUID()
  const externalContent = (content: string) => ({ title: 'New inbound reference', summary: '', blocks: [freshBlock(externalBlock, content)] })
  const copiedUrl = '/' + detachedPath.split('/').map(encodeURIComponent).join('/') + '.md#^' + child
  f.store.updateDocument(external, externalContent(`[new reference](${copiedUrl})`))
  assert.deepEqual(f.db.prepare('SELECT target_path,fragment FROM markdown_link_sources WHERE source_block_id=?').get(externalBlock),
    { target_path: detachedPath, fragment: '^' + child })
  const beforeBlockedUndo = allTables(f.db), changesBeforeBlockedUndo = totalChanges(f.db)
  assert.deepEqual(restore('undo'), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(allTables(f.db), beforeBlockedUndo)
  assert.equal(totalChanges(f.db), changesBeforeBlockedUndo)
  f.store.updateDocument(external, externalContent('The inbound reference was removed'))
  assert.equal(restore('undo').status, 'applied')
  assert.deepEqual(readStrictHostDocument(f.db, destination)!.content, working[0].workingBefore)
  assert.equal(identity(f.db, parent)?.state, 'retained')
  assert.equal(restore('redo').status, 'applied')
  assert.deepEqual(readStrictHostDocument(f.db, destination)!.content, after)
  assert.deepEqual([bodyBirth(f.db, parent), bodyBirth(f.db, child)], births)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId), stored)
  const active = snapshot(f.db, groupId), original = active.instances[0]
  const groupSession = f.store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: source, groupId, instanceId: originalInstanceId })
  if (groupSession.status !== 'ready') throw new Error('Expected the remaining genuine instance')
  const edits = syncedCanonicalEdits(active.blocks)
  edits[0].content += ' edited elsewhere'
  assert.equal(f.store.invokeSyncedEditingSession(sender, { sessionId: groupSession.session.sessionId, method: 'updateSyncedBlockGroup', input: {
    clientOperationId: randomUUID(), groupId, expectedRevision: active.revision, expectedTopologyRevision: active.topologyRevision,
    expectedInstanceBinding: { instanceId: original.instanceId, hostDocumentId: source, bindingVersion: original.bindingVersion }, blocks: edits
  } }).status, 'saved')
  const beforeConflict = allTables(f.db), changesBeforeConflict = totalChanges(f.db)
  assert.equal(restore('undo').status, 'conflict')
  assert.deepEqual(allTables(f.db), beforeConflict)
  assert.equal(totalChanges(f.db), changesBeforeConflict)

  f.close()
  const cold = KnowbookStore.openCanonicalRuntime(f.file)
  try {
    const nextSender = Object.freeze({ purpose: 'cold detached original lookup' })
    const opened = cold.openSyncedEditingSession(nextSender, { kind: 'host', hostDocumentId: destination })
    if (opened.status !== 'ready') throw Error('The actual detached host must reopen without its previous frame')
    assert.deepEqual(cold.invokeSyncedEditingSession(nextSender, { sessionId: opened.session.sessionId, method: 'getSyncedOperation',
      input: { clientOperationId: input.clientOperationId } }), { status: 'committed', result: { ...ack, replayed: true } })
  } finally { cold.destroy() }
  const readonly = new Database(f.file, { readonly: true, fileMustExist: true })
  try {
    readonly.pragma('foreign_keys=ON'); readonly.pragma('query_only=ON')
    const history = readonly.transaction(() => assertRawSyncedHistoricalEvidenceOwned(readonly))()
    const capsule = readonly.transaction(() => readRawCapsule2HistoricalEvidenceOwned(readonly))()
    const find = (facts: typeof history.facts) => facts.find(item => item.family === 'host-detach-ack' && item.locator.key[0] === input.clientOperationId)
    const original = find(history.facts)
    assert.ok(original)
    assert.deepEqual(original.supports.map(item => [item.table, ...item.key]), [['synced_host_history', ack.historyToken]])
    assert.deepEqual(find(capsule.legacyFacts), original)
    assert.equal(totalChanges(readonly), 0)
  } finally { readonly.close() }
}))

test('detaching the last actual instance leaves an attachable orphan and later use closes the old detach inverse', () => withV3Fixture(f => {
  const documentId = f.store.createDocument(null), attachedHost = f.store.createDocument(null)
  const childId = randomUUID(), sender = Object.freeze({ purpose: 'detach original last instance' })
  const openHost = (hostDocumentId: string) => {
    const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId })
    if (opened.status !== 'ready') throw Error('Actual host session unavailable')
    return opened.session.sessionId
  }
  const apply = (hostDocumentId: string, input: SyncedStructureInput) => f.store.invokeSyncedEditingSession(sender, {
    sessionId: openHost(hostDocumentId), method: 'applySyncedHostStructure', input
  })
  f.store.updateDocument(documentId, { title: 'Last original reference', summary: '', blocks: [freshBlock(childId, 'Still available as an orphan')] })
  const created = createRequest(f.db, { documentId, selectedRootIds: [childId] })
  assert.equal(apply(documentId, created).status, 'applied')
  const { groupId, instanceId } = created.action, source = snapshot(f.db, groupId)
  const { hostsWorkingBefore, groups, expectedInstances } = request(f.db, [documentId])
  const detached = apply(documentId, { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore, groups, expectedInstances,
    action: { kind: 'detach', groupId, instanceId } })
  if (detached.status !== 'applied') throw Error('Actual last instance must be detachable: ' + JSON.stringify(detached))
  const orphan = snapshot(f.db, groupId)
  assert.deepEqual(orphan.instances, [])
  assert.deepEqual(orphan.blocks, source.blocks)
  assert.equal(orphan.revision, source.revision)
  assert.equal(f.store.getDocumentDetail(documentId)!.blocks[0].id, detached.blockIdMap[0].to)
  const listed = f.store.invokeSyncedEditingSession(sender, { sessionId: openHost(documentId), method: 'listSyncedGroups',
    input: { offset: 0, limit: 20, query: 'Still available as an orphan' } })
  assert.equal(listed.items.find(group => group.groupId === groupId)?.liveInstances, 0)
  const insertion = command(f.db, { documentId: attachedHost, groupId })
  assert.equal(apply(attachedHost, insertion).status, 'applied')
  assert.deepEqual(snapshot(f.db, groupId).instances.map(row => row.instanceId), [insertion.action.instanceId])
  const beforeRefusal = allTables(f.db), beforeChanges = totalChanges(f.db)
  const undo = f.store.invokeSyncedEditingSession(sender, { sessionId: openHost(documentId), method: 'restoreSyncedHostOperation',
    input: restoreInput(f.db, detached, 'undo') })
  assert.equal(undo.status, 'conflict')
  assert.deepEqual(allTables(f.db), beforeRefusal)
  assert.equal(totalChanges(f.db), beforeChanges)
}))

test('detach keeps both same-name reference and note scopes and refuses a copied missing literal gaining a host definition', () => withV3Fixture(f => {
  const targetId = f.store.createDocument(null), sender = Object.freeze({ purpose: 'isolated detach definitions' })
  const session = (hostDocumentId: string) => {
    const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId })
    if (opened.status !== 'ready') throw Error('Actual host session unavailable')
    return opened.session.sessionId
  }
  const apply = (hostDocumentId: string, input: SyncedStructureInput) => f.store.invokeSyncedEditingSession(sender, {
    sessionId: session(hostDocumentId), method: 'applySyncedHostStructure', input
  })
  function group(title: string, content: string[]) {
    const docId = f.store.createDocument(null), blocks = content.map(value => freshBlock(randomUUID(), value))
    f.store.updateDocument(docId, { title, summary: '', blocks })
    const create = createRequest(f.db, { documentId: docId, selectedRootIds: blocks.map(item => item.id) })
    assert.equal(apply(docId, create).status, 'applied')
    const insert = command(f.db, { documentId: targetId, groupId: create.action.groupId })
    assert.equal(apply(targetId, insert).status, 'applied')
    const { instanceId, groupId } = insert.action, { hostsWorkingBefore, groups, expectedInstances } = request(f.db, [targetId])
    return { blocks, input: { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore, groups, expectedInstances,
      action: { kind: 'detach', instanceId, groupId } } as SyncedStructureInput }
  }
  const kept = ['Retained [same] [^n]', '[same]: /V3%20Host.md', '[^n]: Host note [same]', '[host-only]: /V3%20Host.md']
    .map(value => freshBlock(randomUUID(), value))
  f.store.updateDocument(targetId, { title: 'Joined definitions', summary: '', blocks: kept })
  const first = group('Independent copied definitions', ['Copied [repeat][same] [same][] [same] [^n] [^n]',
    '[same]: /V3%20Target.md', '[^n]: Group note [same]'])
  const detached = apply(targetId, first.input)
  if (detached.status !== 'applied') throw Error('Both original scopes must detach: ' + JSON.stringify(detached))
  const copy = new Map(detached.blockIdMap.map(entry => [entry.from, entry.to]))
  const after = readStrictHostDocument(f.db, targetId)!.content
  const facts = captureSyncedCreateSourceFacts(after.blocks), trace = detachConsumerTrace(facts)
  assert.deepEqual(after.blocks.filter(item => kept.some(block => block.id === item.id)).map(block => block.content), kept.map(block => block.content))
  assert.deepEqual(trace.get(kept[0].id), ['link_open:SAME', 'footnote_ref:n'])
  const copiedConsumers = trace.get(copy.get(first.blocks[0].id)!)!
  assert.equal(copiedConsumers.length, 5)
  assert.ok(copiedConsumers.every(consumer => /knowbook-detach/i.test(consumer)))
  const index = f.db.prepare('SELECT source_block_id,target_path FROM markdown_link_sources WHERE source_document_id=? ORDER BY target_path')
    .all(targetId) as { source_block_id: string; target_path: string }[]
  assert.ok(index.some(row => row.source_block_id === kept[1].id && row.target_path === 'V3 Host'))
  assert.ok(index.some(row => row.source_block_id === copy.get(first.blocks[1].id) && row.target_path === 'V3 Target'))
  const missing = group('Unresolved source literal', ['Preserve copied [host-only] as a literal'])
  const before = allTables(f.db), beforeChanges = totalChanges(f.db)
  assert.deepEqual(apply(targetId, missing.input), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), beforeChanges)
}))
