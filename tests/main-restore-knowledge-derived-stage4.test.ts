import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3, readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { canonicalRestoreRoot, copyRestoreInventory, restoreInventory } from '../src/main/database/restore-safety-files'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { canonicalSearchOccurrencesSql, occurrenceFromCanonicalSearchRow, registerCanonicalSearchFunctions,
  type CanonicalSearchOccurrenceRow } from '../src/main/database/workspace-search-occurrences'
import { WorkspaceSearchRepository } from '../src/main/database/workspace-search'
import { addV3SameGroupReference, allTables, applySyncedHostCommand, createRequest, created, freshBlock,
  randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { command, insertAck } from './helpers/synced-host-command-insert-fixture'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { prepareRootRestoreDerivedStage4, readRootRestoreDerivedStage4 } from '../src/main/database/restore-knowledge-derived-stage4'
import { observeStage4CanonicalSearch } from '../src/main/database/restore-knowledge-derived-stage4-observation'

function readOnly<T>(file: string, read: (db: Database.Database) => T) {
  const db = new Database(restoreSqliteFilename(file), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    return db.transaction(() => read(db))()
  } finally { db.close() }
}

test('Stage4 checks multiple pages of strict groups on a query-only original and retains the canonical search digest', () =>
  withV3Fixture(source => {
    for (let index = 0; index < 18; index++) {
      const documentId = source.store.createDocument(null)
      const blocks = [freshBlock(randomUUID(), `搜索原文 \u{10000} ${index}`),
        { ...freshBlock(randomUUID(), `另一段 ${index}`), tags: ['验收'] }]
      source.store.updateDocument(documentId, { title: `Original search host ${index}`, summary: '', blocks })
      created(applySyncedHostCommand(source.db, createRequest(source.db, { documentId, selectedRootIds: blocks.map(block => block.id) })))
    }
    addV3SameGroupReference(source, source.targetId)
    source.close()
    readOnly(source.file, db => {
      const rows = db.prepare(`SELECT * FROM (${canonicalSearchOccurrencesSql})
        ORDER BY document_id COLLATE BINARY,instance_id COLLATE BINARY,group_id COLLATE BINARY,block_id COLLATE BINARY`)
        .all() as CanonicalSearchOccurrenceRow[]
      assert.equal(new Set(rows.map(row => row.group_id)).size, 19)
      assert.equal(rows.length, 38)
      const hash = createHash('sha256').update('knowbook.restore.derived-stage4.canonical-search.v1\0')
      for (const row of rows) hash.update(capsuleJson([occurrenceFromCanonicalSearchRow(row), row.document_title,
        row.document_path, row.content, row.tags_json, row.block_type, row.instance_order, row.block_order]) + '\n')
      assert.deepEqual(observeStage4CanonicalSearch(db), { canonicalOccurrenceCount: rows.length, canonicalSearchHash: hash.digest('hex') })
      assert.equal(db.pragma('query_only', { simple: true }), 1)
      assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), { count: 0 })
    })
  }, 'UTF-16be'))

test('actual private stage derives ordinary links and counts and independently rebuilds them after a stopped-profile restart', () =>
  withV3Fixture(source => withV3Fixture(async receiver => {
    const documentId = source.store.createDocument(null), blockId = randomUUID()
    const url = '/V3%20Target.md#target-heading'
    // Two authored renames for these same blocks yield more than one page of new routes.
    const neighbors = Array.from({ length: 128 }, (_, index) => freshBlock(randomUUID(), `Stable route neighbor ${index}`))
    const save = (title: string, content: string) => source.store.updateDocument(documentId,
      { title, summary: '', blocks: [freshBlock(blockId, content), ...neighbors] })
    const second = command(source.db, { documentId: source.hostId, groupId: source.groupId })
    insertAck(applySyncedHostCommand(source.db, second))
    const bmpRoute = '\ue005 previous derived observer', astralRoute = '\u{10000} intermediate derived observer'
    save('Oldest derived observer', 'Original routed block')
    save(bmpRoute, 'The current link table deliberately has no source relation')
    const right = await captureMixedSource(source, 2)
    save(astralRoute, 'One more valid historic route to the same block')
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
    // Stage directories use the canonical profile even when the fixture's TEMP contains an NTFS short name.
    const probeRoot = await canonicalRestoreRoot(receiver.userDataRoot)
    const beforeProbe = join(probeRoot, 'derived-link-before-probe')
    await copyRestoreInventory(directory, beforeProbe, originalInventory, probeRoot)
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
    assert.ok(!original.routes.some(route => route.block_id === blockId && route.document_path === bmpRoute))
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
    const outputProbe = join(probeRoot, 'derived-link-after-probe')
    await copyRestoreInventory(join(prepared.directory, 'database'), outputProbe,
      await restoreInventory(join(prepared.directory, 'database')), probeRoot)
    readOnly(join(outputProbe, 'knowbook.db'), db => {
      const projected = db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_document_id,source.url AS label
        FROM markdown_link_sources AS source JOIN documents AS target ON target.path=source.target_path
        WHERE source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id
        ORDER BY source_document_id,target_document_id,label`).all() as Array<{ source_document_id: string; target_document_id: string; label: string }>
      const expected = projected.map(link => {
        const digest = createHash('sha256').update('knowbook.restore.derived-stage4.link.v1\0' + capsuleJson([prepared.stageId, link])).digest()
        digest[6] = (digest[6] & 15) | 128; digest[8] = (digest[8] & 63) | 128
        const hex = digest.subarray(0, 16).toString('hex')
        return { ...link, id: hex.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5') }
      })
      assert.deepEqual(db.prepare('SELECT source_document_id,target_document_id,label,id FROM links ORDER BY _rowid_').all(), expected)
      const lookups = [['document_search', 'document_search_ids', 'document_id'], ['block_search', 'block_search_ids', 'block_id']]
        .map(([table, relation, key]) => {
          const rows = db.prepare(`SELECT _rowid_,search_rowid,CAST(${key} AS BLOB) FROM ${relation} ORDER BY _rowid_`)
            .safeIntegers(true).raw(true).all() as Array<[bigint, bigint, Buffer]>
          return { table, rows: String(rows.length), lookupHash: capsuleBytesHash('knowbook.restore.stage3.native-fts-lookup.v1\0'
            + capsuleJson(rows.map(([rowid, searchRowId, id]) => [String(rowid), String(searchRowId), id.toString('base64')]))) }
        })
      assert.deepEqual(physical.value.nativeFtsProjection, lookups)
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
      const oldIds = new Set(original.routes.map(route => route.rowid))
      const additions = routes.filter(route => !oldIds.has(route.rowid))
      assert.ok(additions.length > 256, 'The writer must resume after the first SQL page')
      const bmp = additions.find(route => route.block_id === blockId && route.document_path === bmpRoute)
      const astral = additions.find(route => route.block_id === blockId && route.document_path === astralRoute)
      assert.ok(bmp && astral && astral.rowid < bmp.rowid, 'Allocation uses the original UTF-16 order, not SQLite UTF-8 text order')
      const key = (route: (typeof additions)[number]) => capsuleJson([route.document_path, route.block_id])
      let next = 1
      for (const entry of additions.sort((a, b) => key(a) < key(b) ? -1 : 1)) {
        while (oldIds.has(next)) next++
        assert.equal(entry.rowid, next++)
      }
      assert.deepEqual(db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(), original.history)
      assert.deepEqual(db.prepare(`SELECT d.link_count,d.block_count,d.child_count FROM documents d WHERE id=?`).get(documentId),
        { link_count: 1, block_count: 1 + neighbors.length, child_count: 0 })
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
