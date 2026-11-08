import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3, readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { copyRestoreInventory, restoreInventory } from '../src/main/database/restore-safety-files'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { canonicalSearchOccurrencesSql, registerCanonicalSearchFunctions } from '../src/main/database/workspace-search-occurrences'
import { WorkspaceSearchRepository } from '../src/main/database/workspace-search'
import { allTables, applySyncedHostCommand, freshBlock, randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { command, insertAck } from './helpers/synced-host-command-insert-fixture'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { prepareRootRestoreDerivedStage4, readRootRestoreDerivedStage4 } from '../src/main/database/restore-knowledge-derived-stage4'

function readOnly<T>(file: string, read: (db: Database.Database) => T) {
  const db = new Database(restoreSqliteFilename(file), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    return db.transaction(() => read(db))()
  } finally { db.close() }
}

test('actual private stage derives ordinary links and counts and independently rebuilds them after a stopped-profile restart', () =>
  withV3Fixture(source => withV3Fixture(async receiver => {
    const documentId = source.store.createDocument(null), blockId = randomUUID()
    const url = '/V3%20Target.md#target-heading'
    const save = (title: string, content: string) => source.store.updateDocument(documentId, { title, summary: '', blocks: [freshBlock(blockId, content)] })
    const second = command(source.db, { documentId: source.hostId, groupId: source.groupId })
    insertAck(applySyncedHostCommand(source.db, second))
    save('Oldest derived observer', 'Original routed block')
    save('Previous derived observer', 'The current link table deliberately has no source relation')
    const right = await captureMixedSource(source, 2)
    save('Derived observer', `[first](${url}) [same](${url}) [missing](/Absent.md#absent)`)
    const left = await captureMixedSource(source, 2)
    const sourceBefore = allTables(source.db), receiverBefore = allTables(receiver.db)
    const root = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
      operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
    const bundle = await exportPreparedMixedOriginBundle(root, { operationId: randomUUID(), bundleId: randomUUID() })
    const originals = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
      operationId: randomUUID(), sourceDirectory: bundle.directory })
    const identity = await prepareRootRestoreIdentityPlan3(originals.knowledgePlan)
    const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
    const physical = await prepareRootRestorePhysicalStage3(reference.plan)
    const directory = join(physical.directory, 'database'), originalInventory = await restoreInventory(directory)
    const beforeProbe = join(receiver.userDataRoot, 'derived-link-before-probe')
    await copyRestoreInventory(directory, beforeProbe, originalInventory, receiver.userDataRoot)
    const original = readOnly(join(beforeProbe, 'knowbook.db'), db => ({
      body: db.prepare('SELECT content FROM blocks WHERE id=?').get(blockId),
      links: db.prepare('SELECT * FROM links WHERE source_document_id=?').all(documentId),
      routes: db.prepare('SELECT _rowid_ AS rowid,* FROM document_block_routes ORDER BY document_path,block_id').all() as Array<{ rowid: number; document_path: string; block_id: string }>,
      dormant: (db.prepare(`SELECT count(*) AS n FROM document_block_routes r WHERE NOT EXISTS(SELECT 1 FROM blocks b WHERE b.id=r.block_id)`).get() as { n: number }).n,
      occurrences: db.prepare(`SELECT instance_id,group_id,block_id,canonical_created_at FROM (${canonicalSearchOccurrencesSql}) ORDER BY instance_id`).all(),
      history: db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all()
    }))
    assert.match((original.body as { content: string }).content, /\[first\]/)
    assert.equal(original.links.length, 0, 'Physical Stage3 retained the genuine current link relation')
    assert.ok(original.routes.some(route => route.block_id === blockId && route.document_path === 'Oldest derived observer'))
    assert.ok(!original.routes.some(route => route.block_id === blockId && route.document_path === 'Previous derived observer'))
    assert.ok(original.history.length)
    assert.ok(original.dormant > 0, 'Actual schema27 retains inactive historical aliases in its identity ledger')
    assert.equal(original.occurrences.length, 2)
    const prepared = await prepareRootRestoreDerivedStage4(reference.plan, { stageId: physical.stageId, expectedManifestHash: physical.manifestHash })
    assert.equal(prepared.value.ordinaryLinkProjectionComplete, true)
    assert.equal(prepared.value.routesRebuilt, true)
    assert.equal(prepared.value.dormantRouteCount, original.dormant)
    assert.equal(prepared.value.canonicalOccurrenceCount, 2)
    assert.equal(prepared.value.canonicalExpandedSearchComplete, true)
    assert.equal(prepared.value.documentStatisticsComplete, true)
    assert.equal(prepared.value.installPermit, false)
    assert.deepEqual(await readRootRestoreDerivedStage4(prepared.stage), prepared.value)
    await assert.rejects(readRootRestoreDerivedStage4({ kind: prepared.stage.kind }), /实际 Main 派生阶段句柄/)

    const derivedFile = join(prepared.directory, 'database', 'knowbook.db')
    const outputProbe = join(receiver.userDataRoot, 'derived-link-after-probe')
    await copyRestoreInventory(join(prepared.directory, 'database'), outputProbe,
      await restoreInventory(join(prepared.directory, 'database')), receiver.userDataRoot)
    readOnly(join(outputProbe, 'knowbook.db'), db => {
      const links = db.prepare('SELECT target_document_id,label FROM links WHERE source_document_id=?').all(documentId) as Array<{ target_document_id: string; label: string }>
      assert.equal(links.length, 1, 'Two authored occurrences share one actual outgoing relation')
      assert.equal(links[0].target_document_id, source.targetId)
      assert.match(links[0].label, /V3%20Target\.md#target-heading$/)
      assert.deepEqual(db.prepare('SELECT link_count FROM documents WHERE id=?').get(documentId), { link_count: 1 })
      assert.deepEqual(db.prepare(`SELECT target_path,fragment,count(*) AS n FROM markdown_link_sources
        WHERE source_document_id=? AND target_path=? GROUP BY target_path,fragment`).get(documentId, 'V3 Target'),
        { target_path: 'V3 Target', fragment: 'target-heading', n: 2 })
      assert.deepEqual(db.prepare('SELECT content FROM blocks WHERE id=?').get(blockId), original.body)
      const routes = db.prepare('SELECT _rowid_ AS rowid,* FROM document_block_routes ORDER BY document_path,block_id').all() as typeof original.routes
      assert.deepEqual(routes.filter(route => original.routes.some(prior => prior.rowid === route.rowid)), original.routes)
      assert.ok(routes.some(route => route.block_id === blockId && route.document_path === 'Previous derived observer'))
      assert.deepEqual(db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(), original.history)
      assert.deepEqual(db.prepare(`SELECT d.link_count,d.block_count,d.child_count FROM documents d WHERE id=?`).get(documentId),
        { link_count: 1, block_count: 1, child_count: 0 })
      assert.throws(() => new WorkspaceSearchRepository(db).search({ query: 'target', scope: 'blocks' }), /未知恢复边界metadata版本/)
      registerCanonicalSearchFunctions(db)
      const occurrences = db.prepare(`SELECT instance_id,group_id,block_id,canonical_created_at FROM (${canonicalSearchOccurrencesSql})
        WHERE knowbook_canonical_terms_v1(content,?,0)=1 ORDER BY instance_id`).all(JSON.stringify(['target'])) as Array<{
          instance_id: string; group_id: string; block_id: string; canonical_created_at: string
        }>
      assert.deepEqual(occurrences, original.occurrences)
      assert.equal(new Set(occurrences.map(row => row.instance_id)).size, 2)
      assert.equal(new Set(occurrences.map(row => row.block_id)).size, 1)
      assert.equal(db.prepare('SELECT 1 FROM blocks WHERE content=?').get(source.raw), undefined)
    })
    assert.deepEqual(allTables(source.db), sourceBefore)
    assert.deepEqual(allTables(receiver.db), receiverBefore)
    const location = await readRootKnowledgePlanLocation3(originals.knowledgePlan), namespace = originals.value.root.namespace
    assert.equal(namespace.kind, 'imported-bundle')
    if (namespace.kind !== 'imported-bundle') throw new Error('Actual mounted original is required')
    source.close(); receiver.close()
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/derived-stage4-process.cjs'), JSON.stringify({
        originalLocator: { profileRoot: location.profileRoot, operationId: location.operationId, mountId: namespace.mountId,
          expectedDescriptorHash: originals.originalPackage.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
        referenceLocator: { planId: reference.planId, expectedManifestHash: reference.manifestHash },
        derivedLocator: { stageId: prepared.stageId, expectedManifestHash: prepared.manifestHash }
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 })
    const cold = JSON.parse(stdout)
    assert.notEqual(cold.pid, process.pid)
    assert.equal(cold.manifestHash, prepared.manifestHash)
    assert.deepEqual(cold.value, prepared.value)
    await appendFile(derivedFile, 'changed stage bytes')
    await assert.rejects(readRootRestoreDerivedStage4(prepared.stage), /保持|独立/)
    assert.deepEqual(await restoreInventory(directory), originalInventory)
  })))
