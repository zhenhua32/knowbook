(async () => {
  const started = performance.now()
  const phase = name => {
    if (process.env.KNOWBOOK_TRACE_ALIAS_DERIVED === '1') process.stderr.write(`[alias-derived-cold] +${Math.round(performance.now() - started)} ms ${name}\n`)
  }
  const assert = require('node:assert/strict'), { join } = require('node:path'), { randomUUID } = require('node:crypto')
  const input = JSON.parse(process.argv[2]), { profileRoot } = input.original
  const Database = require('better-sqlite3')
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestoreSqlAssetStage5 } = await import('../../src/main/database/restore-knowledge-sql-asset-stage5.ts')
  const { reopenRootRestoreSqlAssetAliasStage5 } = await import('../../src/main/database/restore-knowledge-sql-asset-alias-stage5.ts')
  const { reopenRootRestoreDerivedFromCombinedStage4 } = await import('../../src/main/database/restore-knowledge-derived-stage4.ts')
  const { canonicalSearchOccurrencesSql, registerCanonicalSearchFunctions }
    = await import('../../src/main/database/workspace-search-occurrences.ts')
  const { copyRootRestoreStage3Database3, readRootRestorePhysicalStageCopySource3 }
    = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
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
  const { aliases, alias, derived: stage } = await reopenRootRestoreDerivedFromCombinedStage4(
    combined.stage, input.aliases, input.stage, input.derived)
  phase('reopened derived SQL')
  assert.equal(aliases.manifestHash, input.aliases.expectedManifestHash)
  assert.equal(alias.manifestHash, input.stage.expectedManifestHash)
  assert.equal(stage.value.installPermit, false)
  await assert.rejects(reopenRootRestoreSqlAssetAliasStage5(aliases.owner, { ...input.stage, expectedManifestHash: '0'.repeat(64) }),
    /持久清单哈希不同/)
  const physical = readRootRestorePhysicalStageCopySource3(combined.sql.stage)
  const originalProbe = join(profileRoot, 'sql-alias-original-' + randomUUID())
  await copyRootRestoreStage3Database3(physical.databaseDirectory, originalProbe, profileRoot, physical.inventory)
  const fts = db => ({
    block: db.prepare('SELECT f.rowid AS rowid, f.content FROM block_search_ids AS ids JOIN block_search AS f ON f.rowid=ids.search_rowid WHERE ids.block_id=?')
      .safeIntegers(true).get(input.blockId),
    document: db.prepare('SELECT f.rowid AS rowid, f.summary FROM document_search_ids AS ids JOIN document_search AS f ON f.rowid=ids.search_rowid WHERE ids.document_id=?')
      .safeIntegers(true).get(input.documentId)
  })
  const beforeDb = new Database(restoreSqliteFilename(join(originalProbe, 'knowbook.db')), { readonly: true, fileMustExist: true })
  let before
  try {
    before = fts(beforeDb)
    assert.equal(beforeDb.prepare('SELECT 1 FROM links WHERE source_document_id=?').get(input.documentId), undefined)
    assert.equal(beforeDb.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?')
      .get(input.historicalPath, input.blockId), undefined)
  } finally { beforeDb.close() }
  const probe = join(profileRoot, 'sql-alias-cold-' + randomUUID())
  await copyRootRestoreStage3Database3(join(stage.directory, 'database'), probe, profileRoot, stage.inventory)
  const file = restoreSqliteFilename(join(probe, 'knowbook.db'))
  const db = new Database(file, { readonly: true, fileMustExist: true })
  let body, summary, template, links, sources, linkCount, route, occurrences
  try {
    db.pragma('query_only=ON')
    body = db.prepare('SELECT content, document_id, created_at FROM blocks WHERE id=?').get(input.blockId)
    summary = db.prepare('SELECT summary FROM documents WHERE id=?').pluck().get(input.documentId)
    template = db.prepare('SELECT id, created_at, name, title, summary, blocks_json FROM document_templates WHERE id=?').get(input.templateId)
    links = db.prepare('SELECT target_document_id,label FROM links WHERE source_document_id=? ORDER BY label').all(input.documentId)
    sources = db.prepare(`SELECT target_path,fragment FROM markdown_link_sources
      WHERE source_document_id=? AND target_path='V3 Target' ORDER BY fragment`).all(input.documentId)
    linkCount = db.prepare('SELECT link_count FROM documents WHERE id=?').pluck().get(input.documentId)
    route = db.prepare(`SELECT r.document_path,r.block_id,b.created_at AS birth FROM document_block_routes r
      JOIN blocks b ON b.id=r.block_id WHERE r.document_path=? AND r.block_id=?`).get(input.historicalPath, input.blockId)
    registerCanonicalSearchFunctions(db)
    occurrences = db.prepare(`SELECT document_id,instance_id,group_id,block_id,canonical_created_at FROM (${canonicalSearchOccurrencesSql})
      WHERE knowbook_canonical_terms_v1(content,?,0)=1 ORDER BY instance_id`).all(JSON.stringify(['target']))
    const after = fts(db)
    assert.equal(after.block.content, body.content)
    assert.equal(after.document.summary, summary)
    assert.notEqual(after.block.content, before.block.content)
    assert.notEqual(after.document.summary, before.document.summary)
    assert.equal(after.block.rowid, before.block.rowid)
    assert.equal(after.document.rowid, before.document.rowid)
  } finally { db.close() }
  assert.throws(() => inspectOrdinaryRestoreDatabase(file), /恢复边界|stage|同步/)
  process.stdout.write(JSON.stringify({ pid: process.pid, manifestHash: stage.manifestHash, value: stage.value,
    body, summary, template, links, sources, linkCount, route, occurrences }))
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
