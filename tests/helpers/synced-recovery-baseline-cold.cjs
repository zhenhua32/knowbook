const assert = require('node:assert/strict')
;(async () => {
  const input = JSON.parse(process.argv[2])
  const { KnowbookStore } = await import('../../src/main/database/store.ts')
  const { readSyncedBaselineMetadataCaptureOwned2, resolveSyncedBindingSource } = await import('../../src/main/database/synced-binding-sources.ts')
  const { SYNCED_METADATA_BASELINE2_PREFIX } = await import('../../src/main/database/synced-metadata-capture-record2.ts')
  const { allTables } = await import('./synced-host-command-create-fixture.ts')
  const store = KnowbookStore.openCanonicalRuntime(input.file), sender = Object.freeze({ frame: 'independent real cold recovery source' })
  try {
    const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: input.hostId, instanceId: input.instanceId, groupId: input.groupId })
    assert.equal(opened.status, 'ready')
    assert.equal(store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'validateOwner', input: { readOwnerId: input.oldReadOwnerId } }).status, 'owner-unavailable')
    const db = store.getUnsafeDatabaseHandle(), before = allTables(db), changes = db.prepare('SELECT total_changes() AS n').get().n
    const recovered = store.reopenSyncedRecoveryBaseline(sender, { sessionId: opened.session.sessionId, ...input.original })
    assert.equal(recovered.status, 'ready')
    assert.notEqual(recovered.readOwnerId, input.oldReadOwnerId)
    assert.notEqual(recovered.bindingSource.ticketId, input.oldTicketId)
    assert.deepEqual(recovered.bindingSource.entries.map(item => item.key), input.keys)
    if (input.oldEntryId) assert.throws(() => resolveSyncedBindingSource(db, input.oldTicketId, input.oldEntryId), /来源已失效/)
    for (const entry of recovered.bindingSource.entries) assert.deepEqual(resolveSyncedBindingSource(db, recovered.bindingSource.ticketId, entry.entryId).key, entry.key)
    const point = db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(db, recovered.readOwnerId))()
    assert.equal(point.status, 'captured')
    assert.equal(SYNCED_METADATA_BASELINE2_PREFIX + point.record.pointHash, input.original.originalKey)
    assert.deepEqual(allTables(db), before)
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes)
    console.log(JSON.stringify({ readOwnerId: recovered.readOwnerId, zeroSql: true, originalKey: input.original.originalKey,
      headingBirth: point.record.capture.originalCaptureBirthProved, historyLineage: point.historicalKeyLineageComplete }))
  } finally { store.destroy() }
})().catch(error => { console.error(error); process.exitCode = 1 })
