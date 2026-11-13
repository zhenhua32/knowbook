(async () => {
  const assert = require('node:assert/strict'), { join } = require('node:path'), { randomUUID } = require('node:crypto')
  const input = JSON.parse(process.argv[2]), { profileRoot } = input.original
  const Database = require('better-sqlite3')
  const { reopenPreparedMixedOriginBundle } = await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const { prepareRootKnowledgeConservationPlan3 } = await import('../../src/main/database/restore-knowledge-root3-read.ts')
  const { reopenRootRestoreIdentityPlan3 } = await import('../../src/main/database/restore-knowledge-identity3-read.ts')
  const { reopenRootRestoreReferencePlan3 } = await import('../../src/main/database/restore-knowledge-reference3-read.ts')
  const { reopenRootRestoreSqlAssetStage5 } = await import('../../src/main/database/restore-knowledge-sql-asset-stage5.ts')
  const { reopenRootRestoreSqlAssetAliasDerivationFromCombined5, reopenRootRestoreSqlAssetAliasStage5 }
    = await import('../../src/main/database/restore-knowledge-sql-asset-alias-stage5.ts')
  const { copyRootRestoreStage3Database3, readRootRestorePhysicalStageCopySource3 }
    = await import('../../src/main/database/restore-knowledge-stage3-physical.ts')
  const { inspectOrdinaryRestoreDatabase } = await import('../../src/main/database/restore-safety-read.ts')
  const { restoreSqliteFilename } = await import('../../src/main/database/restore-safety-sqlite-path.ts')
  const original = await reopenPreparedMixedOriginBundle(input.original)
  const knowledge = await prepareRootKnowledgeConservationPlan3(original)
  const identity = await reopenRootRestoreIdentityPlan3(knowledge.plan, input.identity)
  const reference = await reopenRootRestoreReferencePlan3(identity.plan, input.reference)
  const combined = await reopenRootRestoreSqlAssetStage5(reference.plan, input.combined)
  const { aliases, source: { alias: stage } } = await reopenRootRestoreSqlAssetAliasDerivationFromCombined5(combined.stage, input.aliases, input.stage)
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
  try { before = fts(beforeDb) } finally { beforeDb.close() }
  const probe = join(profileRoot, 'sql-alias-cold-' + randomUUID())
  await copyRootRestoreStage3Database3(join(stage.directory, 'database'), probe, profileRoot, stage.value.inventory)
  const file = restoreSqliteFilename(join(probe, 'knowbook.db'))
  const db = new Database(file, { readonly: true, fileMustExist: true })
  let body, summary, template
  try {
    db.pragma('query_only=ON')
    body = db.prepare('SELECT content, document_id, created_at FROM blocks WHERE id=?').get(input.blockId)
    summary = db.prepare('SELECT summary FROM documents WHERE id=?').pluck().get(input.documentId)
    template = db.prepare('SELECT id, created_at, name, title, summary, blocks_json FROM document_templates WHERE id=?').get(input.templateId)
    const after = fts(db)
    assert.equal(after.block.content, body.content)
    assert.equal(after.document.summary, summary)
    assert.notEqual(after.block.content, before.block.content)
    assert.notEqual(after.document.summary, before.document.summary)
    assert.equal(after.block.rowid, before.block.rowid)
    assert.equal(after.document.rowid, before.document.rowid)
  } finally { db.close() }
  assert.throws(() => inspectOrdinaryRestoreDatabase(file), /恢复边界|stage|同步/)
  process.stdout.write(JSON.stringify({ pid: process.pid, manifestHash: stage.manifestHash, body, summary, template }))
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
