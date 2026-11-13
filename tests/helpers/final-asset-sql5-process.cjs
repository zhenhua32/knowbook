(async () => {
  const assert = require('node:assert/strict')
  const { randomUUID } = require('node:crypto')
  const { join } = require('node:path')
  const Database = require('better-sqlite3')
  const input = JSON.parse(process.argv[2]), { profileRoot } = input.original
  const start = performance.now()
  const phase = name => {
    if (process.env.KNOWBOOK_TRACE_FINAL_ASSET_SQL === '1')
      process.stderr.write(`[final-asset-sql-cold] +${Math.round(performance.now() - start)} ms ${name}\n`)
  }
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestoreSqlAssetStage5 } = await import('../../src/main/database/restore-knowledge-sql-asset-stage5.ts')
  const { reopenRootRestoreFinalAssetSql5 } = await import('../../src/main/database/restore-knowledge-derived-stage4.ts')
  const { copyRootRestoreStage3Database3, readRootRestorePhysicalStageCopySource3 }
    = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
  const { readRootRestoreStage3MarkerOwned } = await import('../../src/main/database/restore-knowledge-stage3-marker-read.ts')
  const { readRawSyncedGroupSnapshotsOwned } = await import('../../src/main/database/synced-blocks-raw-read.ts')
  const { syncedLifecycleSemanticHash } = await import('../../src/main/database/synced-lifecycle-state.ts')
  const { canonicalSearchOccurrencesSql, registerCanonicalSearchFunctions } = await import('../../src/main/database/workspace-search-occurrences.ts')
  const { inspectOrdinaryRestoreDatabase } = await import('../../src/main/database/restore-safety-read.ts')
  const { restoreSqliteFilename } = await import('../../src/main/database/restore-safety-sqlite-path.ts')
  phase('loaded readers')
  const original = await reopenPreparedMixedOriginBundle(input.original)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, input.identity)
  const reference = await reopenRootRestoreReferencePlan3(identity.plan, input.reference)
  phase('reopened reference plan')
  const combined = await reopenRootRestoreSqlAssetStage5(reference.plan, input.combined)
  phase('reopened combined SQL and assets')
  const { aliases, canonical, sql, derived } = await reopenRootRestoreFinalAssetSql5(reference.plan, combined.stage, input.locators)
  for (const [name, stage] of Object.entries({ aliases, canonical, sql, derived }))
    assert.equal(stage.manifestHash, input.locators[name].expectedManifestHash)
  assert.equal(derived.value.installPermit, false)
  const group = canonical.value.canonicalAssets.groups[0]
  assert.ok(group)
  phase('reopened final SQL')

  const fts = db => ({
    block: db.prepare(`SELECT CAST(f.rowid AS TEXT) AS rowid, f.content FROM block_search_ids AS ids
      JOIN block_search AS f ON f.rowid=ids.search_rowid WHERE ids.block_id=?`).get(input.blockId),
    document: db.prepare(`SELECT CAST(f.rowid AS TEXT) AS rowid, f.summary FROM document_search_ids AS ids
      JOIN document_search AS f ON f.rowid=ids.search_rowid WHERE ids.document_id=?`).get(input.documentId)
  })
  const canonicalCopy = readRootRestorePhysicalStageCopySource3(canonical.stage)
  const canonicalProbe = join(profileRoot, 'final-asset-canonical-probe-' + randomUUID())
  await copyRootRestoreStage3Database3(canonicalCopy.databaseDirectory, canonicalProbe, profileRoot, canonicalCopy.inventory)
  const beforeDb = new Database(restoreSqliteFilename(join(canonicalProbe, 'knowbook.db')), { readonly: true, fileMustExist: true })
  let before
  try {
    before = fts(beforeDb)
    assert.ok(before.block && before.document)
  } finally { beforeDb.close() }

  const probe = join(profileRoot, 'final-asset-sql-probe-' + randomUUID())
  await copyRootRestoreStage3Database3(join(derived.directory, 'database'), probe, profileRoot, derived.inventory)
  const file = restoreSqliteFilename(join(probe, 'knowbook.db'))
  const db = new Database(file, { readonly: true, fileMustExist: true })
  let result
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    registerCanonicalSearchFunctions(db)
    result = db.transaction(() => {
      assert.equal(db.pragma('user_version', { simple: true }), 27)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
      readRootRestoreStage3MarkerOwned(db, canonicalCopy.marker)
      const snapshot = readRawSyncedGroupSnapshotsOwned(db, [group.groupId]).get(group.groupId)
      assert.ok(snapshot)
      const { creationId, createdAt, origin, bindings, blocks } = snapshot
      const wire = { kind: 'synced-group', id: group.groupId, creationId, createdAt, origin, bindings, blocks }
      const life = db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(group.groupId)
      assert.equal(life.state_version, 1)
      assert.equal(life.create_history_id, null)
      assert.equal(life.activation_hash, group.activationHash)
      assert.equal(life.activation_hash, syncedLifecycleSemanticHash(wire))
      const canonicalRowId = db.prepare('SELECT CAST(_rowid_ AS TEXT) FROM synced_group_blocks WHERE id=?').pluck().get(blocks[0].id)
      const body = db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,content,document_id,created_at FROM blocks WHERE id=?').get(input.blockId)
      const document = db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,summary,created_at FROM documents WHERE id=?').get(input.documentId)
      const template = db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,id,created_at,summary,blocks_json FROM document_templates WHERE id=?').get(input.templateId)
      assert.ok(body && document && template && canonicalRowId)
      const after = fts(db)
      assert.deepEqual(after.block, { rowid: before.block.rowid, content: body.content })
      assert.deepEqual(after.document, { rowid: before.document.rowid, summary: document.summary })
      assert.notEqual(after.block.content, before.block.content)
      assert.notEqual(after.document.summary, before.document.summary)
      const links = db.prepare('SELECT target_document_id,label FROM links WHERE source_document_id=? ORDER BY label').all(input.documentId)
      const sources = db.prepare(`SELECT source_block_id,url,kind,target_path,fragment FROM markdown_link_sources
        WHERE source_document_id=? ORDER BY kind,source_offset`).all(input.documentId)
      const linkCount = db.prepare('SELECT link_count FROM documents WHERE id=?').pluck().get(input.documentId)
      const route = db.prepare(`SELECT r.document_path,r.block_id,b.created_at AS birth FROM document_block_routes r
        JOIN blocks b ON b.id=r.block_id WHERE r.document_path=? AND r.block_id=?`).get(input.historicalPath, input.blockId)
      const occurrences = db.prepare(`SELECT document_id,instance_id,group_id,block_id,canonical_created_at,content
        FROM (${canonicalSearchOccurrencesSql}) WHERE group_id=? ORDER BY document_id,instance_id,block_id`).all(group.groupId)
      const retained = db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(input.retainedGroupId)
      const operations = db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all()
      return { body, document, template, wire, activationHash: life.activation_hash, canonicalRowId, retained, operations,
        links, sources, linkCount, route, occurrences }
    })()
  } finally { db.close() }
  assert.throws(() => inspectOrdinaryRestoreDatabase(file), /恢复边界|stage|同步/)
  phase('verified final SQL')
  process.stdout.write(JSON.stringify({ pid: process.pid, manifestHash: derived.manifestHash, value: derived.value, ...result }))
})().catch(error => { console.error(error); process.exitCode = 1 })
