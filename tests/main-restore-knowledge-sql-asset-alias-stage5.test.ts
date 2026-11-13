import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { KnowbookStore } from '../src/main/database/store'
import { DocumentRecoveryRepository } from '../src/main/database/document-recovery'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3, readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreSqlAssetAliasDerivationFromCombined5, prepareRootRestoreSqlAssetAliasStage5 }
  from '../src/main/database/restore-knowledge-sql-asset-alias-stage5'
import { template3ContentStringRanges } from '../src/main/database/restore-knowledge-template3-json'
import { canonicalRestoreRoot, restoreExists, restoreInventory } from '../src/main/database/restore-safety-files'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { allTables, freshBlock, randomUUID, sha256, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('ordinary and template SQL aliases relocate exact cells while missing roles and colliding names survive independent cold reopen',
  { concurrency: false }, () => withV3Fixture(async f => {
    const receiverDirectory = join(f.root, 'alias receiver')
    await mkdir(receiverDirectory)
    const receiverRoot = await canonicalRestoreRoot(receiverDirectory)
    const current = KnowbookStore.createEmptySyncedReceiver(join(receiverRoot, 'storage', 'knowbook.db'))
    try {
      const bytes = Buffer.from('stage5 SQL alias source bytes ' + randomUUID())
      const digest = sha256(bytes), names = ['first + alias.png', '第二别名.png', 'Collision.png', 'missing in source.png']
      const [first, second, collision] = await f.assets.import(names.slice(0, 3).map(name => ({ name, bytes })))
      const sourcePath = (name: string) => join(dirname(fileURLToPath(first.url)), name)
      const targetPath = (name: string) => join(receiverRoot, 'storage', 'assets', 'attachments', digest.slice(0, 2), digest, name)
      const uri = (name: string) => pathToFileURL(sourcePath(name)).href
      const unresolved = uri(names[3])
      const documentId = f.store.createDocument(null), blockId = randomUUID()
      const body = '😀 before\r\n\r\n![body](<' + first.url + '>) ![missing](<' + unresolved
        + '>) ![collision](<' + collision.url + '>)\r\n\r\n`' + first.url + '`'
      const summary = '![summary](<' + second.url + '>)'
      f.store.updateDocument(documentId, { title: 'Exact ordinary alias', summary, blocks: [freshBlock(blockId, body)] })
      const sourceBlock = f.db.prepare('SELECT content, created_at FROM blocks WHERE id=?').get(blockId) as { content: string; created_at: string }
      assert.equal(sourceBlock.content, body)
      const portable = buildSyncedPortableAssetUri({ hash: digest, name: second.name })
      const templateBody = '前 😀\r\n\r\n![template](<' + first.url + '>) ![missing](<' + unresolved
        + '>) ![collision](<' + collision.url + '>) 末'
      const template = f.store.saveDocumentTemplate({ name: 'Native Stage5 selection anchor', title: 'Template',
        summary: '![anchor](<' + portable + '>)', blocks: [freshBlock(randomUUID(), templateBody),
          { ...freshBlock(randomUUID(), '![opaque](<' + first.url + '>)'), type: 'code' }] })
      const templateRow = f.db.prepare('SELECT blocks_json, created_at FROM document_templates WHERE id=?').get(template.id) as {
        blocks_json: string; created_at: string
      }
      const token = template3ContentStringRanges(templateRow.blocks_json)[0], raw = templateRow.blocks_json.slice(token.from, token.to)
      const spelledUri = first.url.replace(':', '\\u003a').replaceAll('/', '\\/')
      const spelledToken = raw.replace('前', '\\u524d').replace(first.url, spelledUri).replace('末', '\\u672b')
      assert.equal(JSON.parse(spelledToken), templateBody)
      const templateJson = templateRow.blocks_json.slice(0, token.from) + spelledToken + templateRow.blocks_json.slice(token.to)
      f.db.prepare('UPDATE document_templates SET blocks_json=? WHERE id=?').run(templateJson, template.id)
      const beforeSource = allTables(f.db)
      const certify = async (database: typeof f.db) => {
        const original = await captureAssetOriginal({ userDataRoot: f.userDataRoot, db: database })
        const sealed = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
        const certificate = await certifyCapsule2Source(sealed.source)
        if (certificate.status !== 'certified-without-prior-coverage') throw new Error('Expected an actual base certificate')
        return { original, sealed, certificate }
      }
      const source = await certify(f.db)

      // Both logical spellings come from actual files. Each role seals its own
      // spelling so Windows does not have to hold both names in one directory.
      await unlink(sourcePath(collision.name))
      const [otherRole, collidingAlias] = await f.assets.import([names[3], 'collision.png'].map(name => ({ name, bytes })))
      assert.equal(otherRole.url, unresolved)
      const currentDb = current.getUnsafeDatabaseHandle(), retainedId = current.createDocument(null)
      const history = new DocumentRecoveryRepository(currentDb)
      current.updateDocument(retainedId, { title: 'Retained origin', summary: '![other](<' + otherRole.url
        + '>) ![case](<' + collidingAlias.url + '>)', blocks: [] })
      history.checkpoint(retainedId, 'edit', true)
      current.updateDocument(retainedId, { title: 'Retained origin', summary: '', blocks: [] })
      const beforeCurrent = allTables(currentDb), currentInput = await certify(currentDb)
      const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.original.info.profileRoot,
        operationId: source.sealed.value.operationId, dagId: randomUUID(),
        source: source.certificate.source, current: currentInput.certificate.source })
      const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
      const operationId = randomUUID()
      const mounted = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiverRoot, operationId, sourceDirectory: exported.directory })
      const identity = await prepareRootRestoreIdentityPlan3(mounted.knowledgePlan)
      const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
      const combined = await prepareRootRestoreSqlAssetStage5(reference.plan)
      const physicalPath = join(combined.sql.directory, 'database'), physicalBefore = await restoreInventory(physicalPath)
      const { aliases, source: { alias: stage } } = await prepareRootRestoreSqlAssetAliasDerivationFromCombined5(combined.stage)
      assert.equal(stage.value.version, 2)
      assert.equal(stage.value.rewrittenCells, 4)
      assert.equal(stage.value.rewrittenOccurrences, 4)
      assert.equal(stage.value.remaining.blockedOccurrences, 2)
      assert.equal(stage.value.remaining.finalSqlOccurrences, 4)
      assert.deepEqual(stage.value.remaining.aliasPathConflicts.map(paths => paths.map(path => path.split('/').at(-1))),
        [['Collision.png', 'collision.png']])
      assert.equal(stage.value.finalAssetClosureComplete, false)
      assert.equal(stage.value.acceptedCoverage, false)
      assert.equal(stage.value.installPermit, false)
      assert.deepEqual(await readdir(join(stage.directory, 'checks')), [])
      await assert.rejects(prepareRootRestoreSqlAssetAliasStage5({ kind: aliases.owner.kind }), /实际附件别名 owner/)

      // The cold process must use the copied mixed mount and the original
      // stage locators, with no fallback to the source/current live database.
      const backups = join(source.original.info.profileRoot, 'backups')
      await rename(backups, backups + '-retired')
      const location = await readRootKnowledgePlanLocation3(mounted.knowledgePlan), namespace = mounted.value.root.namespace
      if (namespace.kind !== 'imported-bundle') throw new Error('Expected the actual copied mount')
      assert.equal(location.profileRoot, receiverRoot)
      const locate = (item: { stageId: string; manifestHash: string }) => ({ stageId: item.stageId, expectedManifestHash: item.manifestHash })
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/sql-asset-alias-stage5-process.cjs'),
        JSON.stringify({ original: { profileRoot: location.profileRoot, operationId: location.operationId, mountId: namespace.mountId,
          expectedDescriptorHash: mounted.originalPackage.descriptorHash },
        identity: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
        reference: { planId: reference.planId, expectedManifestHash: reference.manifestHash },
        combined: locate(combined), aliases: locate(aliases), stage: locate(stage), documentId, blockId, templateId: template.id })],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
      const cold = JSON.parse(stdout)
      assert.notEqual(cold.pid, process.pid)
      assert.equal(cold.manifestHash, stage.manifestHash)
      const bodyUri = /^😀 before\r\n\r\n!\[body\]\(<([^>]+)>\)/u.exec(cold.body.content)?.[1]
      const summaryUri = /^!\[summary\]\(<([^>]+)>\)$/.exec(cold.summary)?.[1]
      assert.ok(bodyUri && summaryUri)
      assert.equal(fileURLToPath(bodyUri), targetPath(first.name))
      assert.equal(fileURLToPath(summaryUri), targetPath(second.name))
      assert.equal(cold.body.content, body.replace(first.url, bodyUri))
      assert.equal(cold.body.document_id, documentId)
      assert.equal(cold.body.created_at, sourceBlock.created_at)
      assert.equal(cold.template.id, template.id)
      assert.equal(cold.template.created_at, templateRow.created_at)
      assert.equal(cold.template.name, 'Native Stage5 selection anchor')
      assert.equal(cold.template.title, 'Template')
      assert.equal(cold.template.summary, '![anchor](<' + summaryUri + '>)')
      const restoredBlocks = JSON.parse(cold.template.blocks_json) as Array<{ content: string }>
      assert.equal(restoredBlocks[0].content, templateBody.replace(first.url, bodyUri))
      assert.equal(restoredBlocks[1].content, '![opaque](<' + first.url + '>)')
      assert.equal(cold.template.blocks_json, templateJson.replace(spelledUri, JSON.stringify(bodyUri).slice(1, -1)))
      assert.deepEqual(await readdir(join(stage.directory, 'checks')), [])
      assert.deepEqual(await restoreInventory(physicalPath), physicalBefore)
      assert.deepEqual(allTables(f.db), beforeSource)
      assert.deepEqual(allTables(currentDb), beforeCurrent)
      for (const name of [...names, 'collision.png']) assert.equal(await restoreExists(targetPath(name)), false)
    } finally { current.destroy() }
  }))
