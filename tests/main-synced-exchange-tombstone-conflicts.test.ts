import assert from 'node:assert/strict'
import test from 'node:test'
import { withTombstones, completed, randomUUID, encode, count, deleteGroup, deleteDocument, document, group,
  removeGroupReferences, snapshot, insertCommand, insertAck, applySyncedHostCommand, hostEdit, changeGroup,
  readStrictHostDocument, assertAbsentKnowledge, liveKnowledge, state, rejected } from './helpers/synced-exchange-tombstone-fixture'

test('actual local insertion and persistent shared host pin block remote orphan deletion as one component while unrelated remote knowledge is accepted', () => withTombstones(async f => {
  const input = insertCommand(f.B.db, { documentId: f.islands[0], groupId: f.orphanId }), ack = insertAck(applySyncedHostCommand(f.B.db, input))
  assert.ok(ack.historyToken, 'The real insert made an immutable executable journal rather than a hand-seeded pin')
  const pins = f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(f.orphanId)
  assert.ok(pins.length > 0, 'The real insert genuinely persists a group pin before the remote deletion is considered')
  const before = snapshot(f.B.db, f.orphanId)
  f.remoteFinal(records => { deleteGroup(records, f.orphanId); document(records, f.islands[1]).content.blocks[0].content = 'Unrelated U remains eligible beside pinned deletion' })
  const result = completed(await f.exchange(), 'applied')
  assert.ok(result.deferred.some(c => c.keys.includes('group:' + f.orphanId)), 'The full pinned component is deferred instead of deleting a currently referenced or historically pinned group')
  assert.equal(result.appliedKeys.includes('group:' + f.orphanId), false); assert.equal(result.acceptedKeys.includes('group:' + f.orphanId), false)
  assert.deepEqual(snapshot(f.B.db, f.orphanId), before)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(f.orphanId), pins)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'Unrelated U remains eligible beside pinned deletion')
}))

test('actual historical trash template journal and unknown persistent pin kinds all conservatively block deletion without removing the pin or suppressing independent U', async () => {
  for (const kind of ['trash', 'template', 'journal', 'unrecognized:external-pin-kind'] as const) await withTombstones(async f => {
    // Approved historical/external input fixture: this is a real DDL-permitted conservative
    // pin fact, not a fake successful trash/template producer, proof or write authority.
    const pinId = randomUUID()
    f.B.db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(f.orphanId, kind, pinId, new Date().toISOString())
    const before = snapshot(f.B.db, f.orphanId)
    f.remoteFinal(records => { deleteGroup(records, f.orphanId); document(records, f.islands[1]).content.blocks[0].content = 'U beside persistent ' + kind })
    const result = completed(await f.exchange(), 'applied')
    assert.ok(result.deferred.some(component => component.keys.includes('group:' + f.orphanId) && component.reason === 'history-pin'), 'Every actual persistent pin kind participates in the deletion guard without a recognized-kind whitelist')
    assert.deepEqual(snapshot(f.B.db, f.orphanId), before)
    assert.ok(f.B.db.prepare('SELECT 1 FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?').get(f.orphanId, kind, pinId), 'The conservative input pin is retained rather than cleared to make deletion eligible')
    assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'U beside persistent ' + kind)
  })
})

test('actual local new reference committed during remote read withdraws the deletion component and still receives an unrelated U', () => withTombstones(async f => {
  f.remoteFinal(records => { deleteGroup(records, f.orphanId); document(records, f.islands[1]).content.blocks[0].content = 'U accepted despite late reference' })
  const gate = f.gate(r => r.method === 'GET' && r.path.endsWith('/manifest.json')), job = f.exchange()
  let inserted: ReturnType<typeof insertAck> | undefined
  try {
    await gate.wait(job); const other = f.connect(f.B)
    inserted = insertAck(applySyncedHostCommand(other, insertCommand(other, { documentId: f.islands[0], groupId: f.orphanId })))
  } finally { gate.release() }
  const result = completed(await job, 'applied')
  assert.ok(inserted && result.deferred.some(c => c.keys.includes('group:' + f.orphanId)), 'The actual post-capture Main reference revokes the complete deletion candidate')
  assert.equal(snapshot(f.B.db, f.orphanId).instances.length, 1)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'U accepted despite late reference')
}))

test('actual group content changed back during the job cannot regain deletion authority by returning to identical portable text', () => withTombstones(async f => {
  const original = snapshot(f.B.db, f.groupId), originalText = original.blocks[0].content
  f.remoteFinal(records => { removeGroupReferences(records, f.groupId); deleteGroup(records, f.groupId); document(records, f.islands[1]).content.blocks[0].content = 'U across changed-back group guard' })
  const gate = f.gate(r => r.method === 'GET' && r.path.endsWith('/manifest.json')), job = f.exchange()
  try {
    await gate.wait(job); const other = f.connect(f.B)
    changeGroup(other, f.groupId, blocks => { blocks[0].content = 'A genuine intervening edit' })
    changeGroup(other, f.groupId, blocks => { blocks[0].content = originalText })
    assert.deepEqual(snapshot(other, f.groupId).blocks, original.blocks)
    assert.notEqual(snapshot(other, f.groupId).revision, original.revision)
  } finally { gate.release() }
  const result = completed(await job, 'applied')
  assert.ok(result.deferred.some(c => c.keys.includes('group:' + f.groupId)), 'Matching text cannot replace the original revision and history proof after a real edit and edit-back')
  assert.equal(snapshot(f.B.db, f.groupId).instances.length, original.instances.length)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'U across changed-back group guard')
}))

test('actual wrong predecessor wrong incarnation and unknown-first tombstones remain deferred without creating an absent baseline while U proceeds', async () => {
  for (const fault of ['wrong-predecessor', 'wrong-incarnation', 'unknown-first'] as const) await withTombstones(async f => {
    const key = fault === 'unknown-first' ? 'group:' + randomUUID() : 'group:' + f.orphanId
    const original = snapshot(f.B.db, f.orphanId)
    f.remoteFinal(records => {
      if (fault === 'unknown-first') records.set(key, { kind: 'synced-group-deleted', id: key.slice(6), creationId: randomUUID(), previousHash: '0'.repeat(64), deletedAt: new Date().toISOString() })
      else { deleteGroup(records, f.orphanId, fault === 'wrong-predecessor' ? '0'.repeat(64) : undefined); const value = records.get(key); assert.ok(value?.kind === 'synced-group-deleted', 'The negative starts from the strict finite tombstone union'); if (fault === 'wrong-incarnation') value.creationId = randomUUID() }
      document(records, f.islands[1]).content.blocks[0].content = 'U beside ' + fault
    })
    const result = completed(await f.exchange(), 'applied')
    assert.ok(result.deferred.some(c => c.keys.includes(key)), 'The actual finite deletion-authority failure is visible as a complete deferred component')
    assert.equal(result.acceptedKeys.includes(key), false); assert.equal(result.appliedKeys.includes(key), false)
    assert.deepEqual(snapshot(f.B.db, f.orphanId), original)
    assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'U beside ' + fault)
  })
})

test('actual parent deletion cannot rely on foreign-key child detachment and explicit surviving-child transition is required', () => withTombstones(async f => {
  const before = liveKnowledge(f.B.db)
  f.remoteFinal(records => { deleteDocument(records, f.host) }, false)
  await rejected(() => f.exchange(), 'invalid')
  assert.deepEqual(liveKnowledge(f.B.db), before, 'A malformed remote final graph cannot use ON DELETE SET NULL to silently move a real child')
  assert.equal(readStrictHostDocument(f.B.db, f.child).parentId, f.host)
}))

test('actual doc catalog membership must be explicitly retained as standalone before document deletion instead of being lost to SQL cascade', () => withTombstones(async f => {
  const id = f.host, catalog = f.remote().records.get('databases')
  assert.ok(catalog?.kind === 'databases', 'The actual sender produced the complete six-table catalog wire')
  const direct = structuredClone(catalog.tables.document_database_values.filter(row => row.document_id === id))
  assert.ok(direct.length > 0, 'The remote document really owns direct catalog values before deletion')
  const before = liveKnowledge(f.B.db)
  f.remoteFinal(records => { document(records, f.child).parentId = null; deleteDocument(records, id) }, false)
  await rejected(() => f.exchange(), 'invalid'); assert.deepEqual(liveKnowledge(f.B.db), before)
  // An explicit final catalog preserves the exact direct field values as a real standalone entity.
  const standaloneId = randomUUID(), createdAt = new Date().toISOString()
  f.remoteFinal(records => {
    const value = records.get('databases'); assert.ok(value?.kind === 'databases', 'The explicit catalog closure is derived from the actual original wire')
    const column = value.tables.document_database_columns.find(row => row.id === direct[0].column_id)
    assert.ok(column && typeof column.database_id === 'string' && value.tables.databases.some(row => row.id === column.database_id), 'The explicit standalone entity uses its actual portable column source, including the catalog sentinel')
    assert.ok(direct.every(row => value.tables.document_database_columns.some(candidate => candidate.id === row.column_id && candidate.database_id === column.database_id)), 'Every retained direct value belongs to this complete actual portable database definition')
    value.tables.database_entities.push({ id: standaloneId, database_id: column.database_id, title: 'Explicit retained deleted-document values', document_id: null, created_at: createdAt })
    for (const row of direct) value.tables.database_entity_values.push({ entity_id: standaloneId, column_id: row.column_id, value_text: row.value_text })
    value.tables.document_database_values = value.tables.document_database_values.filter(row => row.document_id !== id)
    for (const row of value.tables.database_entities) if (row.document_id === id) row.document_id = null
    // The actual original sender and SQL portable reader sort each catalog table
    // by complete canonical row JSON. Object-key canonicalization alone does
    // not reorder newly appended entity/value arrays in this remote fixture.
    for (const rows of Object.values(value.tables)) rows.sort((left, right) => encode(left) < encode(right) ? -1 : encode(left) > encode(right) ? 1 : 0)
  })
  const result = completed(await f.exchange(), 'applied')
  assert.ok(result.acceptedKeys.includes('databases') && result.appliedKeys.includes('doc:' + id), 'The real consumer accepts the explicit catalog and deletion in one closed dependency component')
  const actual = f.B.db.prepare('SELECT column_id,value_text FROM database_entity_values WHERE entity_id=? ORDER BY column_id').all(standaloneId)
  assert.deepEqual(actual, direct.map(row => ({ column_id: row.column_id, value_text: row.value_text })).sort((a, b) => String(a.column_id).localeCompare(String(b.column_id))))
  assertAbsentKnowledge(f.B.db, 'doc:' + id)
}, { catalog: true }))
