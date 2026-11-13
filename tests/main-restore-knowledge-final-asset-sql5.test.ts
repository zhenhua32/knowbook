import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { prepareRootRestoreFinalAssetSql5 } from '../src/main/database/restore-knowledge-derived-stage4'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { template3ContentStringRanges } from '../src/main/database/restore-knowledge-template3-json'
import { canonicalRestoreRoot, restoreExists, restoreInventory } from '../src/main/database/restore-safety-files'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock, randomUUID, sha256, withV3Fixture }
  from './helpers/synced-backup-v3-fixture'

test('one cold staged SQL descendant retains exact canonical, document and template assets with derived links, routes and search',
  () => withV3Fixture(async f => {
    const tracing = process.env.KNOWBOOK_TRACE_FINAL_ASSET_SQL === '1', started = performance.now()
    const phase = (name: string) => {
      if (tracing) process.stderr.write(`[final-asset-sql] +${Math.round(performance.now() - started)} ms ${name}\n`)
    }
    const seal = async () => {
      const original = await captureAssetOriginal(f), sealed = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
      const certificate = await certifyCapsule2Source(sealed.source)
      if (certificate.status !== 'certified-without-prior-coverage') throw new Error('Expected a real typed base certificate')
      return { original, sealed, certificate }
    }
    const retained = f.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(f.groupId)
    const operations = f.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all()
    assert.ok(retained && operations.length)
    const current = await seal()
    phase('current-certified')

    const bytes = Buffer.from('exact aliases ' + randomUUID()), digest = sha256(bytes)
    const [first, second] = await f.assets.import(['first (final).png', '第二别名.png'].map(name => ({ name, bytes })))
    const link = '/V3%20Target.md#target-heading', historicalPath = 'Before final SQL route'
    const documentId = f.store.createDocument(null), blockId = randomUUID()
    f.store.updateDocument(documentId, { title: historicalPath, summary: '', blocks: [freshBlock(blockId, 'Routed block')] })
    const body = '😀 ordinary\r\n\r\n![body](<' + first.url + '>) [target](' + link + ')\r\n\r\n`' + first.url + '`'
    const summary = '![summary](<' + second.url + '>)'
    f.store.updateDocument(documentId, { title: 'Final ordinary alias', summary, blocks: [freshBlock(blockId, body)] })
    const blockBirth = f.db.prepare('SELECT created_at FROM blocks WHERE id=?').pluck().get(blockId)
    const documentBirth = f.db.prepare('SELECT created_at FROM documents WHERE id=?').pluck().get(documentId)

    const canonicalHost = f.store.createDocument(null), canonicalBlock = randomUUID()
    const canonicalBody = '😀 canonical\r\n\r\n![first](<' + first.url + '>) ![second](<' + second.url
      + '>) [heading](' + link + ')\r\n\r\n`' + first.url + '`'
    f.store.updateDocument(canonicalHost, { title: 'Fresh canonical alias', summary: '', blocks: [freshBlock(canonicalBlock, canonicalBody)] })
    const canonicalBirth = f.db.prepare('SELECT created_at FROM blocks WHERE id=?').pluck().get(canonicalBlock)
    created(applySyncedHostCommand(f.db, createRequest(f.db, { documentId: canonicalHost, selectedRootIds: [canonicalBlock] })))

    const portable = buildSyncedPortableAssetUri({ hash: digest, name: second.name })
    const templateBody = '前 😀\r\n\r\n![template](<' + first.url + '>) 末'
    const template = f.store.saveDocumentTemplate({ name: 'Final exact alias', title: 'Template', summary: '![anchor](<' + portable + '>)',
      blocks: [freshBlock(randomUUID(), templateBody), { ...freshBlock(randomUUID(), '![opaque](<' + first.url + '>)'), type: 'code' }] })
    const templateRow = f.db.prepare('SELECT blocks_json, created_at FROM document_templates WHERE id=?').get(template.id) as {
      blocks_json: string; created_at: string
    }
    const token = template3ContentStringRanges(templateRow.blocks_json)[0], raw = templateRow.blocks_json.slice(token.from, token.to)
    const spelledUri = first.url.replace(':', '\\u003a').replaceAll('/', '\\/')
    const spelledToken = raw.replace('前', '\\u524d').replace(first.url, spelledUri).replace('末', '\\u672b')
    assert.equal(JSON.parse(spelledToken), templateBody)
    const templateJson = templateRow.blocks_json.slice(0, token.from) + spelledToken + templateRow.blocks_json.slice(token.to)
    f.db.prepare('UPDATE document_templates SET blocks_json=? WHERE id=?').run(templateJson, template.id)
    const liveBefore = allTables(f.db), source = await seal()
    phase('source-certified')

    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.original.info.profileRoot, operationId: source.sealed.value.operationId,
      dagId: randomUUID(), source: source.certificate.source, current: current.certificate.source })
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
    phase('originals-exported')
    const receiver = join(f.root, 'final asset SQL receiver')
    await mkdir(receiver)
    const profileRoot = await canonicalRestoreRoot(receiver), operationId = randomUUID()
    const mounted = await captureMixedRootKnowledgeConservationPlan3({ profileRoot, operationId, sourceDirectory: exported.directory })
    const namespace = mounted.value.root.namespace
    if (namespace.kind !== 'imported-bundle') throw new Error('Expected actual copied mixed originals')
    const identity = await prepareRootRestoreIdentityPlan3(mounted.knowledgePlan)
    const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
    phase('reference-prepared')
    const combined = await prepareRootRestoreSqlAssetStage5(reference.plan)
    const base = join(combined.sql.directory, 'database'), baseBefore = await restoreInventory(base)
    phase('final-compose-started')
    const { aliases, canonical, sql, derived } = await prepareRootRestoreFinalAssetSql5(reference.plan, combined.stage)
    phase('final-compose-completed')
    const canonicalBefore = await restoreInventory(join(canonical.directory, 'database'))
    const proof = canonical.value.canonicalAssets
    assert.ok(proof)
    assert.equal(proof.groups.length, 1)
    assert.equal(proof.rewrittenOccurrences, 2)
    assert.equal(sql.value.version, 3)
    assert.equal(sql.value.rewrittenCells, 4)
    assert.equal(sql.value.rewrittenOccurrences, 4)
    assert.equal(sql.value.canonicalRewrittenOccurrences, 2)
    assert.equal(derived.value.version, 4)
    assert.equal(derived.value.aliasManifestHash, sql.manifestHash)
    for (const descendant of [sql.value, derived.value]) {
      assert.equal(descendant.canonicalStageId, canonical.stageId)
      assert.equal(descendant.canonicalStageManifestHash, canonical.manifestHash)
      assert.equal(descendant.canonicalAssetPlanHash, proof.planHash)
      assert.equal(descendant.installPermit, false)
      assert.equal(descendant.finalAssetClosureComplete, false)
      assert.equal(descendant.acceptedCoverage, false)
    }
    const group = proof.groups[0], baseline = reference.value.candidate.activeGroupWires.find(wire => wire.id === group.groupId)
    assert.ok(baseline && baseline.bindings.length)
    assert.equal(baseline.blocks.length, 1)
    const rowid = (name: string, id: string) => {
      const table = combined.sql.value.tables.find(item => item.name === name)
      assert.ok(table)
      const row = table.rows.find(item => item.cells[table.columns.indexOf('id')][1] === Buffer.from(id).toString('base64'))
      assert.ok(row)
      return row.targetRowId
    }

    const backups = join(source.original.info.profileRoot, 'backups')
    await rename(backups, backups + '-retired')
    const locate = (item: { stageId: string; manifestHash: string }) => ({ stageId: item.stageId, expectedManifestHash: item.manifestHash })
    phase('launch-cold-process')
    const coldReader = promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/final-asset-sql5-process.cjs'),
      JSON.stringify({ original: { profileRoot, operationId, mountId: namespace.mountId, expectedDescriptorHash: mounted.originalPackage.descriptorHash },
        identity: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
        reference: { planId: reference.planId, expectedManifestHash: reference.manifestHash }, combined: locate(combined),
        locators: { aliases: locate(aliases), canonical: locate(canonical), sql: locate(sql), derived: locate(derived) },
        documentId, blockId, templateId: template.id, historicalPath, retainedGroupId: f.groupId })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    if (tracing) coldReader.child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    const { stdout } = await coldReader
    phase('cold-process-completed')
    const cold = JSON.parse(stdout)
    assert.notEqual(cold.pid, process.pid)
    assert.equal(cold.manifestHash, derived.manifestHash)
    assert.deepEqual(cold.value, derived.value)
    const bodyUri = /^😀 ordinary\r\n\r\n!\[body\]\(<([^>]+)>\)/u.exec(cold.body.content)?.[1]
    const summaryUri = /^!\[summary\]\(<([^>]+)>\)$/.exec(cold.document.summary)?.[1]
    assert.ok(bodyUri && summaryUri)
    const target = (name: string) => join(profileRoot, 'storage', 'assets', 'attachments', digest.slice(0, 2), digest, name)
    assert.deepEqual([bodyUri, summaryUri].map(uri => fileURLToPath(uri)), [first.name, second.name].map(target))
    assert.equal(cold.body.content, body.replace(first.url, bodyUri))
    assert.equal(cold.body.document_id, documentId)
    assert.equal(cold.body.created_at, blockBirth)
    assert.equal(cold.body.rowid, rowid('blocks', blockId))
    assert.equal(cold.document.created_at, documentBirth)
    assert.equal(cold.document.rowid, rowid('documents', documentId))
    assert.equal(cold.template.id, template.id)
    assert.equal(cold.template.created_at, templateRow.created_at)
    assert.equal(cold.template.rowid, rowid('document_templates', template.id))
    assert.equal(cold.template.summary, '![anchor](<' + summaryUri + '>)')
    assert.equal(cold.template.blocks_json, templateJson.replace(spelledUri, JSON.stringify(bodyUri).slice(1, -1)))

    assert.equal(cold.wire.id, group.groupId)
    assert.equal(cold.wire.blocks[0].id, baseline.blocks[0].id)
    assert.equal(cold.wire.blocks[0].createdAt, canonicalBirth)
    assert.deepEqual(cold.wire.origin, baseline.origin)
    const finalCanonical = baseline.blocks[0].content.replace(first.url, bodyUri).replace(second.url, summaryUri)
    assert.equal(cold.wire.blocks[0].content, finalCanonical)
    const shift = bodyUri.length - first.url.length + summaryUri.length - second.url.length
    assert.notEqual(shift, 0)
    assert.deepEqual(cold.wire.bindings, baseline.bindings.map(binding => ({ ...binding, from: binding.from + shift, to: binding.to + shift })))
    assert.equal(cold.canonicalRowId, rowid('synced_group_blocks', baseline.blocks[0].id))
    assert.equal(cold.activationHash, group.activationHash)
    assert.deepEqual(cold.retained, retained)
    assert.deepEqual(cold.operations, operations)
    assert.deepEqual(cold.links, [{ target_document_id: f.targetId, label: link }])
    assert.deepEqual(cold.sources, [
      { source_block_id: blockId, url: bodyUri, kind: 'image', target_path: null, fragment: null },
      { source_block_id: blockId, url: link, kind: 'link', target_path: 'V3 Target', fragment: 'target-heading' }
    ])
    assert.equal(cold.linkCount, 1)
    assert.deepEqual(cold.route, { document_path: historicalPath, block_id: blockId, birth: blockBirth })
    assert.equal(cold.occurrences.length, 1)
    assert.equal(cold.occurrences[0].document_id, canonicalHost)
    assert.equal(cold.occurrences[0].block_id, baseline.blocks[0].id)
    assert.equal(cold.occurrences[0].canonical_created_at, canonicalBirth)
    assert.equal(cold.occurrences[0].content, finalCanonical)
    assert.deepEqual(await restoreInventory(base), baseBefore)
    assert.deepEqual(await restoreInventory(join(canonical.directory, 'database')), canonicalBefore)
    assert.deepEqual(await restoreInventory(join(sql.directory, 'database')), sql.value.inventory)
    assert.deepEqual(allTables(f.db), liveBefore)
    assert.equal(await restoreExists(join(profileRoot, 'storage', 'knowbook.db')), false)
    for (const name of [first.name, second.name]) assert.equal(await restoreExists(target(name)), false)
    phase('assertions-completed')
  }))
