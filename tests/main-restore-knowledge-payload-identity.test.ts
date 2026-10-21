import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { installSyncedBlockSchema } from '../src/main/database/synced-schema'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { captureKnowledgeOriginal, extractKnowledge, withPayloadStore } from './helpers/restore-knowledge-payload-fixture'

test('K keeps actual ordinary owner evolution and migration-produced NULL birth while duplicate historical originals add no mapping ambiguity', () => withPayloadStore(async f => {
  const from = f.store.createDocument(null), to = f.store.createDocument(null), moving = randomUUID(), keep = randomUUID(), legacy = 'legacy:unknown-birth:' + randomUUID()
  f.store.updateDocument(from, { title: 'Owner A', summary: '', blocks: [moving, keep].map(id => ({ id, type: 'paragraph', content: id, checked: false, depth: 0, parentBlockId: null })) })
  f.store.updateDocument(to, { title: 'Owner B', summary: '', blocks: [{ id: randomUUID(), type: 'paragraph', content: 'target', checked: false, depth: 0, parentBlockId: null }] })
  // A supported legacy ordinary checkpoint has no block-birth field. The real
  // migration backfill, rather than a forged ledger row, derives retained NULL.
  f.db.prepare('INSERT INTO document_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(), from, 'Owner A', f.store.getDocumentDetail(from)!.path,
    '2020-01-01T00:00:00.000Z', 'legacy-checkpoint', JSON.stringify({ title: 'Owner A', summary: '', blocks: [
      { id: legacy, type: 'paragraph', content: 'real legacy checkpoint input', checked: false, depth: 0, parentBlockId: null }
    ] }))
  f.db.transaction(() => installSyncedBlockSchema(f.db))()
  assert.deepEqual(f.db.prepare('SELECT state,created_at FROM block_identities WHERE id=?').get(legacy), { state: 'retained', created_at: null })
  const source = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const a = f.store.getDocumentDetail(from), b = f.store.getDocumentDetail(to)
  assert.ok(a && b)
  const moved = f.store.moveDocumentBlocks({ fromDocumentId: from, toDocumentId: to, blockIds: [moving],
    expectedFromUpdatedAt: a.updatedAt, expectedToUpdatedAt: b.updatedAt })
  assert.equal(moved.state, 'applied')
  const captured = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)), current = await extractKnowledge(captured)
  const duplicate = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, captured.info.originalDirectory, captured.operationId))
  assert.equal(current.payload.capsule.manifestHash, duplicate.payload.capsule.manifestHash)
  assert.notEqual(current.payload.capsule.capsuleId, duplicate.payload.capsule.capsuleId)
  const versions = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([source.handle, current.handle]))
  assert.ok(versions.occupancy.some(item => item.value.id === moving && item.value.ownerId === from))
  assert.ok(versions.occupancy.some(item => item.value.id === moving && item.value.ownerId === to))
  for (const payload of [source.payload, current.payload, duplicate.payload]) {
    assert.ok(payload.identities.some(identity => identity.id === legacy && identity.createdAt === null && identity.state === 'retained'))
    assert.ok(payload.occupancy.some(item => item.id === legacy && item.knownBirth === null))
  }
  const copies = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([current.handle, duplicate.handle]))
  assert.deepEqual(copies.mappingAmbiguities, [], 'Duplicated legitimate A/B move history is the same known-value set, not a contradiction')
  assert.equal(versions.status, 'evidence-only')
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM document_block_moves WHERE id=?').get(moved.operationId) as { count: number }).count, 1)
}))

test('different real scopes retain the same raw block name with both owners instead of treating it as one logical object or rejecting the union', () => withPayloadStore(async a => withPayloadStore(async b => {
  const blockId = 'independent:shared-raw-id', da = a.store.createDocument(null), db = b.store.createDocument(null)
  for (const [f, documentId] of [[a, da], [b, db]] as const) f.store.updateDocument(documentId, { title: 'Actual independent owner', summary: '', blocks: [
    { id: blockId, type: 'paragraph', content: 'Actual separate workspace body', checked: false, depth: 0, parentBlockId: null }
  ] })
  const source = await extractKnowledge(await captureKnowledgeOriginal(a.userDataRoot, dirname(a.file)))
  const current = await extractKnowledge(await captureKnowledgeOriginal(a.userDataRoot, dirname(b.file)))
  assert.notEqual(source.payload.workspaceScope, current.payload.workspaceScope)
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([source.handle, current.handle]))
  assert.equal(union.payloads.length, 2)
  assert.ok(union.occupancy.some(item => item.value.id === blockId && item.value.ownerId === da))
  assert.ok(union.occupancy.some(item => item.value.id === blockId && item.value.ownerId === db))
  assert.ok(union.mappingAmbiguities.some(item => item.namespace === 'block' && item.id === blockId && item.reasons.includes('scope')))
  assert.equal(union.status, 'evidence-only', 'A plan must resolve actual lineage; scope or raw ID alone never grants/rejects a mapping')
})))
