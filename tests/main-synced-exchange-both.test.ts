import assert from 'node:assert/strict'
import test from 'node:test'
import { getSyncedGroupSnapshots, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { withBoth, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary, overlappingGroup, insert,
  snapshot, completed, request, applySyncedHostFinal, randomUUID, physicalKnowledge, stateRow, remoteActual,
  localPortable, converged, identity, readStrictHostDocument, changeGroup } from './helpers/synced-exchange-both-fixture'

test('actual both preview displays fixed fresh candidates without creating owner rows or changing either original graph', () => withBoth(async f => {
  const id = await overlappingGroup(f), before = physicalKnowledge(f.B.db), baseline = stateRow(f.B.db).value, remote = remoteActual(f).bytes
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), g = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(g && c.choices.includes('both'), 'The genuine same-incarnation conflict offers its one explicit local group fork')
  assert.notEqual(g.groupId, id); assert.notEqual(g.creationId, snapshot(f.B.db, id).creationId)
  assert.deepEqual(physicalKnowledge(f.B.db), before, 'Candidate IDs confer no live or reserved ledger ownership')
  assert.equal(stateRow(f.B.db).value, baseline); assert.deepEqual(remoteActual(f).bytes, remote)
  assert.deepEqual(readyBoth(await f.previewBoth(f.B, p.previewId)), p, 'The original preview never silently reallocates a candidate on reread')
  const source = c.records.find(record => record.key === 'group:' + id)
  assert.equal(source?.localHash, localPortable(f.B).entries['group:' + id])
  assert.equal(source?.remoteHash, remoteActual(f).manifest.entries['group:' + id])
}))

test('actual both forks one local group for several selected occurrences with all fresh instance identities and original remote G retained', () => withBoth(async f => {
  const id = f.ack.createdLifecycle.groupId, parent = randomUUID()
  const addParent = request(f.A.db, [f.islands[0]], sides => sides[0].blocks.push({ id: parent, type: 'toggle', content: 'real nested fork parent', checked: false, depth: 0, parentBlockId: null }))
  assert.equal(applySyncedHostFinal(f.A.db, addParent).status, 'applied')
  insert(f.A, id, f.islands[0]); insert(f.A, id, f.islands[0], { parentBlockId: parent, depth: 1 })
  completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  await overlappingGroup(f)
  const local = snapshot(f.B.db, id), remote = snapshot(f.A.db, id), ordinary = readStrictHostDocument(f.B.db, f.islands[0]).detail.blocks.filter(b => b.type !== 'synced-block')
  assert.ok(local.instances.length >= 3, 'Real insert commands created multiple same-G occurrences including a nested one')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), decision = selectBoth(c, { copies: [], hosts: 'existing' })
  assert.equal(c.copyDocuments.some(doc => doc.required), false)
  const result = acceptedBoth(await f.resolveBoth(p, [decision])), summary = forkSummary(result, c.componentId)
  assert.equal(summary.groups.length, 1); assert.equal(summary.documents.length, 0)
  const fresh = snapshot(f.B.db, summary.groups[0].groupId), destination = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(destination, 'The accepted fresh group came from the exact displayed destination')
  assert.equal(fresh.creationId, destination.creationId); assert.equal(fresh.createdAt, destination.createdAt)
  assert.deepEqual(snapshot(f.B.db, id).blocks, remote.blocks); assert.deepEqual(snapshot(f.B.db, id).bindings, remote.bindings)
  assert.equal(fresh.instances.length, decision.groups[0].hosts.length)
  const originals = new Set(local.instances.map(item => item.instanceId))
  assert.ok(fresh.instances.every(item => !originals.has(item.instanceId)), 'No old physical occurrence ID is mutated into a new group payload')
  for (const source of local.instances) {
    const mapped = summary.instances.find(item => item.sourceInstanceId === source.instanceId && item.destination === 'existing')
    assert.ok(mapped, 'Every explicitly selected original occurrence has one stable fresh mapping')
    const actual = fresh.instances.find(item => item.instanceId === mapped.instanceId)
    assert.ok(actual, 'The actual SQL registry contains the selected fresh instance')
    assert.equal(actual.hostDocumentId, source.hostDocumentId); assert.equal(actual.depth, source.depth); assert.equal(actual.parentBlockId, source.parentBlockId)
    assert.equal(identity(f.B.db, actual.instanceId)?.last_owner_id, source.hostDocumentId)
  }
  assert.deepEqual(readStrictHostDocument(f.B.db, f.islands[0]).detail.blocks.filter(b => b.type !== 'synced-block'), ordinary, 'Selecting references preserves the complete local ordinary forest')
  assert.ok(fresh.blocks.every(block => !local.blocks.some(old => old.id === block.id)), 'All canonical children of the new group have fresh physical identities')
  assert.ok(fresh.blocks[0].content.startsWith('LOCAL conflicting prefix '), 'The local canonical branch is visible through the single real fork')
  completed(await f.exchange(f.A), 'applied'); converged(f)
}))

test('actual orphan both fork survives reopen list get attach binding-authorized edit and explicit dereference without fake hosts', () => withBoth(async f => {
  const id = await overlappingGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id)
  const result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c, { copies: [], hosts: 'none' })])), summary = forkSummary(result, c.componentId), freshId = summary.groups[0].groupId
  assert.deepEqual(summary.instances, []); assert.deepEqual(snapshot(f.B.db, freshId).instances, [])
  const other = f.connect(f.B), read = getSyncedGroupSnapshots(other, { groupIds: [freshId] }).items[0]
  assert.ok(read.status === 'ready', 'A fresh independent SQLite connection sees the actual orphan group')
  assert.equal(read.snapshot.instances.length, 0)
  assert.ok(listSyncedGroups(other, { query: 'LOCAL conflicting prefix', offset: 0, limit: 100 }).items.some(item => item.groupId === freshId), 'The public Main group list can discover the actual zero-instance fork')
  const lifecycle = other.prepare('SELECT state,create_history_id FROM synced_group_lifecycle WHERE group_id=?').get(freshId) as { state: string; create_history_id: string | null }
  assert.deepEqual(lifecycle, { state: 'active', create_history_id: null })
  const attached = insert(f.B, freshId, f.islands[2]); assert.ok(attached.ack.historyToken, 'Attaching the orphan uses the real executable insert writer')
  changeGroup(f.B.db, freshId, blocks => { blocks[0].content = 'edited through a real attached instance' })
  const stable = snapshot(f.B.db, freshId).blocks.map(block => [block.id, block.createdAt])
  const remove = request(f.B.db, [f.islands[2]], sides => { sides[0].blocks = [{ id: randomUUID(), type: 'paragraph', content: 'explicit paragraph after removing the fork reference', checked: false, depth: 0, parentBlockId: null }] })
  assert.equal(applySyncedHostFinal(f.B.db, remove).status, 'applied')
  const orphan = snapshot(other, freshId)
  assert.deepEqual(orphan.instances, []); assert.equal(orphan.blocks[0].content, 'edited through a real attached instance')
  assert.deepEqual(orphan.blocks.map(block => [block.id, block.createdAt]), stable)
  completed(await f.exchange(f.B), 'applied'); completed(await f.exchange(f.A), 'applied'); converged(f)
  assert.equal(snapshot(f.A.db, freshId).instances.length, 0)
}))

test('actual both preserves a mixed local host and group in fresh typed identities while original document and G take remote content', () => withBoth(async f => {
  const id = f.ack.createdLifecycle.groupId, ordinaryId = randomUUID()
  const add = request(f.A.db, [f.host], sides => sides[0].blocks.push({ id: ordinaryId, type: 'paragraph', content: 'common ordinary host body', checked: false, depth: 0, parentBlockId: null }))
  assert.equal(applySyncedHostFinal(f.A.db, add).status, 'applied'); completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  await overlappingGroup(f)
  const remoteEdit = request(f.A.db, [f.host], sides => { sides[0].blocks.find(block => block.id === ordinaryId)!.content = 'REMOTE ordinary host branch' })
  assert.equal(applySyncedHostFinal(f.A.db, remoteEdit).status, 'applied'); completed(await f.exchange(f.A), 'applied')
  const localEdit = request(f.B.db, [f.host], sides => { sides[0].blocks.find(block => block.id === ordinaryId)!.content = 'LOCAL ordinary host branch' })
  assert.equal(applySyncedHostFinal(f.B.db, localEdit).status, 'applied')
  const oldHost = readStrictHostDocument(f.B.db, f.host), oldGroup = snapshot(f.B.db, id), remoteHost = readStrictHostDocument(f.A.db, f.host), remoteGroup = snapshot(f.A.db, id)
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'doc:' + f.host), wanted = c.copyDocuments.find(doc => doc.sourceDocumentId === f.host)
  assert.ok(wanted && wanted.required, 'The conflicting ordinary forest is explicitly in the required copy closure')
  assert.equal(wanted.sourceTitle, oldHost.detail.title)
  const value = acceptedBoth(await f.resolveBoth(p, [selectBoth(c)])), summary = forkSummary(value, c.componentId)
  const doc = summary.documents.find(doc => doc.sourceDocumentId === f.host), group = summary.groups.find(group => group.sourceGroupId === id)
  assert.ok(doc && group, 'The actual accepted component contains both complete fresh destinations')
  const copied = readStrictHostDocument(f.B.db, doc.documentId), freshGroup = snapshot(f.B.db, group.groupId)
  assert.equal(copied.detail.title, wanted.title); assert.equal(copied.detail.path, wanted.path); assert.equal(copied.parentId, wanted.parentId)
  assert.ok(copied.detail.blocks.every(block => !oldHost.detail.blocks.some(old => old.id === block.id)), 'Every copied ordinary or reference child is a new physical identity')
  assert.ok(copied.detail.blocks.some(block => block.type === 'paragraph' && block.content === 'LOCAL ordinary host branch'), 'The complete copied forest contains the actual local ordinary branch')
  assert.ok(copied.detail.blocks.some(block => block.type === 'synced-block' && JSON.parse(block.content).groupId === freshGroup.groupId), 'The local document visibly uses the one mapped local group')
  assert.equal(freshGroup.origin.documentId, doc.documentId); assert.equal(freshGroup.origin.pathAtCreation, doc.path)
  assert.ok(freshGroup.blocks.every(block => !oldGroup.blocks.some(old => old.id === block.id)), 'Copied canonical children never reuse original G physical IDs')
  const original = readStrictHostDocument(f.B.db, f.host)
  assert.deepEqual(original.content, remoteHost.content); assert.deepEqual(snapshot(f.B.db, id).blocks, remoteGroup.blocks)
  assert.ok(freshGroup.blocks[0].content.startsWith('LOCAL conflicting prefix '), 'The complete local canonical branch remains separately readable')
  completed(await f.exchange(f.A), 'applied'); converged(f)
}))
