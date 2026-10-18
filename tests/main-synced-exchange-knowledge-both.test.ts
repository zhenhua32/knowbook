import assert from 'node:assert/strict'
import test from 'node:test'
import { withKnowledge, divergeGroup, divergeDocument, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary,
  snapshot, unchangedDenial, storedReceipt, randomUUID, readStrictHostDocument, count, getSyncedGroupSnapshots,
  listSyncedGroups, insertCommand, insertAck, applySyncedHostCommand, changeGroup, request, applySyncedHostFinal,
  hostEdit, completed, localPortable, state, readonlyRequests } from './helpers/synced-exchange-knowledge-fixture'

test('both copies one live G across its real surviving occurrences while its deleted Origin remains a fixed noncopied component member', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key)
  assert.ok(c.keys.includes(f.denialKey) && c.choices.includes('both'), 'The complete component keeps its fixed absent Origin and still grants the real live both candidate')
  assert.equal(c.copyDocuments.some(doc => 'doc:' + doc.sourceDocumentId === f.denialKey), false, 'Historical proof.before cannot become a current copy source for an absent owner')
  const decision = selectBoth(c, { copies: [], hosts: 'existing' }), operationId = randomUUID()
  assert.equal(decision.groups.find(group => group.groupId === conflict.id)?.hosts.length, 2)
  const result = acceptedBoth(await f.resolveBoth(p, [decision], operationId)), summary = forkSummary(result, c.componentId)
  assert.equal(summary.groups.length, 1); assert.deepEqual(summary.documents, [])
  const fork = snapshot(f.B.db, summary.groups[0].groupId)
  assert.deepEqual(snapshot(f.B.db, conflict.id).blocks, conflict.remote.blocks)
  assert.equal(fork.blocks[0].content, conflict.local.blocks[0].content)
  assert.equal(fork.instances.length, 2); assert.equal(summary.instances.length, 2)
  const oldIds = new Set(conflict.local.blocks.map(block => block.id).concat(conflict.local.instances.map(instance => instance.instanceId)))
  assert.ok(fork.blocks.every(block => !oldIds.has(block.id)) && fork.instances.every(instance => !oldIds.has(instance.instanceId)), 'The single actual fork uses fresh canonical and instance identities rather than mutating the original remote graph')
  for (const instance of fork.instances) assert.equal(instance.hostDocumentId, f.islands[0])
  const receipt = storedReceipt(f.B.db, operationId, 6)
  assert.equal(receipt.value.provenance.accepted.some(row => row.key === f.denialKey), false)
  unchangedDenial(f)
}))

test('an orphan live fork beside fixed Origin absence survives reopen discovery actual attach edit and explicit dereference', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key)
  const result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c, { copies: [], hosts: 'none' })])), summary = forkSummary(result, c.componentId), id = summary.groups[0].groupId
  assert.deepEqual(summary.instances, []); assert.deepEqual(snapshot(f.B.db, id).instances, [])
  f.reopenPeer(); const actual = getSyncedGroupSnapshots(f.B.db, { groupIds: [id] }).items[0]
  assert.ok(actual.status === 'ready', 'A new real SQLite connection can read the installed orphan fork')
  assert.ok(listSyncedGroups(f.B.db, { query: 'LOCAL overlap', offset: 0, limit: 100 }).items.some(row => row.groupId === id), 'The genuine public list discovers the zero-instance local branch')
  insertAck(applySyncedHostCommand(f.B.db, insertCommand(f.B.db, { documentId: f.islands[2], groupId: id })))
  changeGroup(f.B.db, id, blocks => { blocks[0].content = 'Actual edited orphan fork through a real attached instance' })
  const birth = snapshot(f.B.db, id).blocks.map(block => [block.id, block.createdAt])
  const removal = request(f.B.db, [f.islands[2]], sides => { sides[0].blocks = [{ id: randomUUID(), type: 'paragraph', content: 'Explicit paragraph after real fork dereference', checked: false, depth: 0, parentBlockId: null }] })
  assert.equal(applySyncedHostFinal(f.B.db, removal).status, 'applied')
  assert.deepEqual(snapshot(f.B.db, id).instances, []); assert.deepEqual(snapshot(f.B.db, id).blocks.map(block => [block.id, block.createdAt]), birth)
  assert.equal(snapshot(f.B.db, id).blocks[0].content, 'Actual edited orphan fork through a real attached instance')
  unchangedDenial(f)
}))

test('a mixed surviving host and live G are genuinely forked together while the same complete component retains fixed deleted Origin knowledge', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f)
  hostEdit(f.A.db, f.islands[0], 'REMOTE surviving host ordinary forest'); completed(await f.exchange(f.A), 'applied')
  hostEdit(f.B.db, f.islands[0], 'LOCAL surviving host ordinary forest')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key), copiedSource = c.copyDocuments.find(doc => doc.sourceDocumentId === f.islands[0])
  assert.ok(copiedSource?.required && c.keys.includes(f.denialKey), 'The real ordinary conflict is in the required copy closure without dropping its fixed Origin dependency')
  const value = acceptedBoth(await f.resolveBoth(p, [selectBoth(c)])), summary = forkSummary(value, c.componentId)
  const copy = summary.documents.find(doc => doc.sourceDocumentId === f.islands[0]), group = summary.groups.find(group => group.sourceGroupId === conflict.id)
  assert.ok(copy && group, 'The original real preview map installs both complete fresh destinations')
  const actual = readStrictHostDocument(f.B.db, copy.documentId)
  assert.ok(actual.detail.blocks.some(block => block.type === 'paragraph' && block.content === 'LOCAL surviving host ordinary forest'), 'The complete fork visibly retains the local ordinary branch')
  assert.ok(actual.detail.blocks.some(block => block.type === 'synced-block' && JSON.parse(block.content).groupId === group.groupId), 'The copied host really uses the fresh canonical branch')
  assert.equal(readStrictHostDocument(f.B.db, f.islands[0]).detail.blocks.find(block => block.type === 'paragraph')?.content, 'REMOTE surviving host ordinary forest')
  assert.equal(snapshot(f.B.db, group.groupId).blocks[0].content, conflict.local.blocks[0].content)
  assert.equal(summary.documents.some(doc => 'doc:' + doc.sourceDocumentId === f.denialKey), false)
  unchangedDenial(f)
}))

test('zero-active both forks only the actual live document and keeps all deleted group identity denial facts without fake groups', () => withKnowledge(async f => {
  const conflict = await divergeDocument(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key), operationId = randomUUID()
  assert.deepEqual(c.groups, [])
  const value = acceptedBoth(await f.resolveBoth(p, [selectBoth(c)], operationId)), summary = forkSummary(value, c.componentId)
  const copy = summary.documents.find(doc => doc.sourceDocumentId === conflict.id)
  assert.ok(copy, 'The actual ordinary local branch has one displayed and accepted fresh document destination')
  assert.deepEqual(summary.groups, []); assert.deepEqual(summary.instances, [])
  assert.equal(readStrictHostDocument(f.B.db, copy.documentId).detail.blocks[0].content, 'LOCAL ordinary overlapping body')
  assert.equal(readStrictHostDocument(f.B.db, conflict.id).detail.blocks[0].content, 'REMOTE ordinary overlapping body')
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_blocks').all(), []); assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_instances').all(), [])
  assert.equal(f.remote().manifest.version, 5); assert.ok(f.remote().manifest.entries['doc:' + copy.documentId], 'The complete live copy is genuinely published even with no active G')
  storedReceipt(f.B.db, operationId, 6); unchangedDenial(f)
}, { denial: 'zero' }))

test('catalog direct values and definitions survive a real host and G both operation alongside unchanged authenticated group absence', () => withKnowledge(async f => {
  const extra = request(f.A.db, [f.host], sides => { sides[0].blocks.push({ id: randomUUID(), type: 'paragraph', content: 'Common real catalog host ordinary paragraph', checked: false, depth: 0, parentBlockId: null }) })
  assert.equal(applySyncedHostFinal(f.A.db, extra).status, 'applied'); completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  const conflict = await divergeGroup(f)
  hostEdit(f.A.db, f.host, 'REMOTE catalog host ordinary paragraph'); completed(await f.exchange(f.A), 'applied')
  hostEdit(f.B.db, f.host, 'LOCAL catalog host ordinary paragraph')
  const values = f.B.db.prepare('SELECT column_id,value_text,entity_id FROM document_database_values WHERE document_id=? ORDER BY column_id').all(f.host)
  const definitions = f.B.db.prepare('SELECT id,database_id,name,type,options_json,sort_order,created_at FROM document_database_columns ORDER BY id').all()
  assert.ok(values.length > 0, 'The actual received catalog owns real direct values before the selected host is copied')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key), result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c)])), summary = forkSummary(result, c.componentId)
  const copied = summary.documents.find(doc => doc.sourceDocumentId === f.host)
  assert.ok(copied, 'The conflicting actual catalog host has a real complete copied destination')
  assert.deepEqual(f.B.db.prepare('SELECT column_id,value_text,entity_id FROM document_database_values WHERE document_id=? ORDER BY column_id').all(copied.documentId), values)
  assert.deepEqual(f.B.db.prepare('SELECT id,database_id,name,type,options_json,sort_order,created_at FROM document_database_columns ORDER BY id').all(), definitions)
  assert.equal(count(f.B.db, 'documents', 'id', copied.documentId), 1)
  assert.equal(localPortable(f.B).entries['doc:' + copied.documentId], f.remote().manifest.entries['doc:' + copied.documentId])
  unchangedDenial(f)
}, { denial: 'orphan', catalog: true }))

test('real foreign ownership of a knowledge fork instance is refused before publication or remains the same structured blocker after remote success and reopen', async () => {
  for (const order of ['before-publish', 'after-publish'] as const) await withKnowledge(async f => {
    const conflict = await divergeGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key), decision = selectBoth(c, { copies: [], hosts: 'existing' })
    const destination = c.groups.find(group => group.sourceGroupId === conflict.id), operationId = randomUUID()
    assert.ok(destination, 'The genuine knowledge preview exposes its fixed live fork destination')
    const candidate = destination.hosts.find(host => host.destination === 'existing')
    assert.ok(candidate, 'There is an actual selected existing-host fresh instance candidate')
    const own = () => {
      const other = f.connect(f.B)
      insertAck(applySyncedHostCommand(other, insertCommand(other, { documentId: f.islands[2], groupId: f.orphanId, instanceId: candidate.instanceId })))
      return other.prepare('SELECT * FROM block_identities WHERE id=?').get(candidate.instanceId)
    }
    const baseline = state(f.B.db).value, source = snapshot(f.B.db, conflict.id)
    if (order === 'before-publish') {
      const owner = own(), start = f.server.requests.length
      const result = acceptedBoth(await f.resolveBoth(p, [decision], operationId))
      assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'A known collision withdraws the real full knowledge component instead of stealing foreign ownership')
      assert.equal(result.forks.some(row => row.componentId === c.componentId), false)
      assert.equal(f.remote().manifest.entries['group:' + destination.groupId], undefined)
      const objects = f.server.requests.slice(start).filter(request => request.method === 'PUT' && request.path.includes('/objects/')).filter(request => {
        try { return (JSON.parse(request.bytes.toString()) as { id?: string }).id === destination.groupId } catch { return false }
      })
      assert.deepEqual(objects, [], 'The rejected actual fork object is not uploaded before discovering the collision')
      assert.deepEqual(f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(candidate.instanceId), owner)
    } else {
      const gate = f.gate(request => request.method === 'GET' && request.path.endsWith('/manifest.json') && Boolean(f.remote().manifest.entries['group:' + destination.groupId]))
      const job = f.resolveBoth(p, [decision], operationId)
      let owner: unknown
      try { await gate.wait(job); owner = own() } finally { gate.release() }
      const blocked = await job
      assert.ok(blocked.status === 'blocked', 'Remote-confirmed allocation cannot be installed over a genuinely foreign current owner')
      assert.equal(blocked.reason, 'identity-collision'); assert.equal(blocked.stage, 'published-local')
      assert.ok(blocked.collisions.some(row => row.id === candidate.instanceId), 'The structured blocker names the actual occupied fresh instance')
      assert.equal(state(f.B.db).value, baseline); assert.deepEqual(snapshot(f.B.db, conflict.id), source)
      assert.equal(count(f.B.db, 'synced_operations', 'client_operation_id', operationId), 0)
      const published = f.remote().bytes
      f.reopenPeer(); const start = f.server.requests.length, again = await f.resolveBoth(p, [decision], operationId)
      assert.ok(again.status === 'blocked', 'A new connection retains the original blocked result rather than allocating another fork')
      assert.equal(again.allocationHash, blocked.allocationHash); assert.equal(again.publishedManifestHash, blocked.publishedManifestHash)
      readonlyRequests(f.server.requests.slice(start)); assert.deepEqual(f.remote().bytes, published)
      assert.deepEqual(f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(candidate.instanceId), owner)
    }
    unchangedDenial(f)
  })
})
