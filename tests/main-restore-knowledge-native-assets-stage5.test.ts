import assert from 'node:assert/strict'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { DocumentRecoveryRepository } from '../src/main/database/document-recovery'
import { serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { buildSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { captureQualifiedOriginalBundle } from '../src/main/database/restore-knowledge-qualified-originals'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { prepareRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreSqlAssetStage5, readRootRestoreSqlAssetClosure5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreAssetTransfer4, reopenRestoreAssetTransfer4 } from '../src/main/database/restore-asset-transfer4'
import { restoreExists } from '../src/main/database/restore-safety-files'
import { prepareRootRestoreAssetAliasStage5, readRootRestoreAssetAliasStageCopies5,
  reopenRootRestoreAssetAliasStage5 } from '../src/main/database/restore-knowledge-asset-alias-stage5'
import { template3ContentStringRanges } from '../src/main/database/restore-knowledge-template3-json'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock, randomUUID, sha256, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('genuine selected canonical body and template JSON/summary use their own base scope and exact SQL readback',
  { concurrency: false }, () => withV3Fixture(async f => {
    const bytes = Buffer.from('Native selected canonical/template alias bytes ' + randomUUID()), hash = sha256(bytes)
    const opaqueBytes = Buffer.from('Opaque template code ' + randomUUID())
    const [canonical, templateAsset, opaque] = await f.assets.import([
      { name: 'canonical selected.png', bytes }, { name: '模板选中.png', bytes }, { name: 'opaque.png', bytes: opaqueBytes }
    ])
    const targetDocumentId = f.store.createDocument(null), targetBlockId = 'linked-target'
    f.store.updateDocument(targetDocumentId, { title: 'Asset source target', summary: '', blocks: [freshBlock(targetBlockId, 'Exact link target')] })
    const hostId = f.store.createDocument(null), blockId = randomUUID()
    f.store.updateDocument(hostId, { title: 'Asset stage canonical owner', summary: '', blocks: [freshBlock(blockId,
      '[target](/Asset%20source%20target.md#^' + targetBlockId + ')\n\n![canonical](<' + canonical.url + '>)')] })
    const create = createRequest(f.db, { documentId: hostId, selectedRootIds: [blockId] })
    created(applySyncedHostCommand(f.db, create))
    const template = f.store.saveDocumentTemplate({ name: 'Independent local asset scope', title: 'Templated document',
      summary: 'Template summary ![alias](<' + templateAsset.url + '>)', blocks: [
        { ...freshBlock(randomUUID(), serializeSyncedBlockPayload({ version: 1, groupId: create.action.groupId })), type: 'synced-block' },
        // Same ID spelling as the real canonical block, but the template has
        // its own local namespace and its own logical alias.
        freshBlock(blockId, 'Template body ![alias](<' + templateAsset.url + '>)'),
        { ...freshBlock(randomUUID(), '![opaque](<' + opaque.url + '>)'), type: 'code' }
      ] })
    const templateRow = f.db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string }
    const templateToken = template3ContentStringRanges(templateRow.blocks_json)[0]
    const token = templateRow.blocks_json.slice(templateToken.from, templateToken.to)
    const escaped = token.replace('version', '\\u0076ersion')
    assert.equal(JSON.parse(escaped), JSON.parse(token), 'Only the actual persisted JSON token spelling changes')
    assert.notEqual(escaped, token)
    f.db.prepare('UPDATE document_templates SET blocks_json=? WHERE id=?').run(
      templateRow.blocks_json.slice(0, templateToken.from) + escaped + templateRow.blocks_json.slice(templateToken.to), template.id)

    const ordinaryId = f.store.createDocument(null), lateName = 'current history only.png'
    const laterAlias = buildSyncedPortableAssetUri({ hash, name: lateName })
    f.store.updateDocument(ordinaryId, { title: 'Ordinary asset scope',
      summary: '![existing](<' + templateAsset.url + '>) ![unbound](<' + laterAlias + '>)',
      blocks: [freshBlock(randomUUID(), 'Ordinary body ![asset](<' + canonical.url + '>)')] })

    const sourceBefore = allTables(f.db)
    const currentProfile = join(f.root, 'independent-current')
    await mkdir(currentProfile)
    const current = KnowbookStore.createEmptySyncedReceiver(join(currentProfile, 'storage', 'knowbook.db'))
    try {
      const currentDb = current.getUnsafeDatabaseHandle(), sourceOriginal = await captureAssetOriginal(f)
      const certify = async (original: typeof sourceOriginal) => {
        const sealed = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
        assert.equal(sealed.value.assetArchive.version, 2, 'The base typed proof is required even without any Working5 job')
        const cert = await certifyCapsule2Source(sealed.source)
        if (cert.status !== 'certified-without-prior-coverage') throw new Error('Expected the genuine base source certificate')
        return { sealed, cert }
      }
      const source = await certify(sourceOriginal)
      await f.assets.import([{ name: lateName, bytes }])
      const historyDoc = current.createDocument(null), history = new DocumentRecoveryRepository(currentDb)
      current.updateDocument(historyDoc, { title: 'Retained history asset scope', summary: '![history](<' + laterAlias + '>)', blocks: [] })
      history.checkpoint(historyDoc, 'edit', true)
      const historyId = history.listHistory(historyDoc)[0].id
      current.updateDocument(historyDoc, { title: 'Retained history asset scope', summary: 'No live asset', blocks: [] })
      const currentBefore = allTables(currentDb), currentOriginal = await captureAssetOriginal({ userDataRoot: f.userDataRoot, db: currentDb })
      const receiver = await certify(currentOriginal)
      const qualified = await captureQualifiedOriginalBundle({ profileRoot: sourceOriginal.info.profileRoot,
        operationId: source.sealed.value.operationId, dagId: randomUUID(), source: source.cert.source, current: receiver.cert.source })
      const knowledge = await prepareRootKnowledgeConservationPlan3(qualified.bundle)
      const identity = await prepareRootRestoreIdentityPlan3(knowledge.plan)
      const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
      assert.deepEqual(reference.value.candidate.conflicts.map(conflict => conflict.code), [])
      const stage = await prepareRootRestoreSqlAssetStage5(reference.plan)
      const assets = stage.assets.value
      assert.equal(assets.version, 3)
      const { selected, aliases, files } = assets
      assert.equal(selected.filter(row => row.hash === hash).length, 3)
      assert.equal(files.some(file => file.sha256 === sha256(opaqueBytes)), false)
      const body = selected.find(row => row.context?.kind === 'canonical' && row.hash === hash)
      if (body?.context?.kind !== 'canonical') throw new Error('Missing the genuine canonical occurrence')
      assert.equal(body.sourceRef.table, 'synced_group_blocks')
      assert.equal(body.column, 'content')
      assert.equal(body.context.owner.sourceRef.table, 'synced_groups')
      const canonicalEdit = reference.value.candidate.canonicalEdits.find(edit => edit.key.blockId === blockId)
      assert.ok(canonicalEdit, 'The incoming canonical link is retargeted to an independently qualified missing block')
      const shift = canonicalEdit.after.length - canonicalEdit.key.raw.length
      assert.notEqual(shift, 0)
      assert.equal(body.finalFrom, body.from + shift)
      const templateBody = selected.find(row => row.context?.kind === 'template-content' && row.hash === hash)
      if (templateBody?.context?.kind !== 'template-content') throw new Error('Missing the genuine template JSON token occurrence')
      assert.equal(templateBody.context.localId, blockId)
      assert.equal(templateBody.sourceRef.table, 'document_templates')
      assert.equal(templateBody.column, 'blocks_json')
      assert.equal(templateBody.context.asset.raw, templateAsset.url)
      assert.notEqual(templateBody.finalFrom, templateBody.from, 'Remapping the earlier synced token projects the later JSON token')
      assert.ok(selected.some(row => row.context?.kind === 'template-summary' && row.column === 'summary' && row.hash === hash))
      assert.deepEqual(aliases.filter(row => row.hash === hash).map(row => row.logicalName).sort(), [canonical.name, templateAsset.name].sort())
      const shared = files.filter(file => file.sha256 === hash)
      assert.equal(shared.length, 1)
      assert.deepEqual(await readFile(join(stage.assets.directory, referenceContextObjectPath(shared[0].frame, shared[0].path))), bytes)
      assert.equal(stage.value.selectedAssetsMatchPhysicalSql, true)
      assert.equal(stage.value.installPermit, false)
      const audit = await readRootRestoreSqlAssetClosure5(stage.stage)
      assert.equal(audit.installPermit, false)
      assert.equal(audit.finalAssetClosureComplete, false)
      assert.equal(audit.knownOccurrencesComplete, false)
      assert.equal(audit.blocked, 1)
      const unbound = audit.entries.find(row => row.status === 'blocked')
      assert.equal(unbound?.domain, 'final-sql')
      assert.equal(unbound?.cell?.sourceRef.side, 'source')
      assert.equal(unbound?.cell?.column, 'summary')
      assert.equal(unbound?.destination.uri, laterAlias)
      const retained = audit.entries.find(row => row.status === 'matched' && row.scope[0] === 'document_history' && row.scope[1] === historyId)
      assert.ok(retained?.status === 'matched')
      assert.equal(retained.domain, 'retained-sql')
      assert.equal(retained.destination.uri, laterAlias)
      assert.equal(retained.proof.logicalName, lateName)
      assert.ok(retained.proof.file.path.endsWith('/' + receiver.sealed.value.capsuleId + '/files/' + hash))
      const ordinary = audit.entries.filter(row => row.domain === 'final-sql' && row.cell?.sourceRef.side === 'source'
        && row.status === 'matched' && row.proof.kind === 'sealed-original')
      assert.deepEqual(ordinary.map(row => row.cell?.column).sort(), ['content', 'summary'])
      assert.equal(audit.entries.filter(row => row.status === 'matched' && row.proof.kind === 'staged').length, 3)
      assert.equal(audit.entries.some(row => row.destination.uri === opaque.url), false)
      assert.ok(audit.remainder.some(row => row.scope[0] === 'app_settings' && row.reason === 'remaining-policy-held-payload-asset-scopes'))
      const aliasStage = await prepareRootRestoreAssetAliasStage5(stage.stage)
      assert.equal(aliasStage.value.assetClosureObservationHash, audit.observationHash)
      assert.equal(aliasStage.value.remaining.blockedOccurrences, 1)
      assert.deepEqual(aliasStage.value.remaining.scopes, audit.remainder)
      assert.equal(aliasStage.value.installPermit, false)
      assert.deepEqual(aliasStage.value.aliases.map(alias => alias.logicalName).sort(), [canonical.name, templateAsset.name, lateName].sort())
      assert.equal(aliasStage.value.aliases.find(alias => alias.logicalName === lateName)?.occurrences, 1,
        'The identical source URI remains blocked even when the retained alias has actual bytes')
      const reopenedAliases = await reopenRootRestoreAssetAliasStage5(stage.stage,
        { stageId: aliasStage.stageId, expectedManifestHash: aliasStage.manifestHash })
      assert.deepEqual(reopenedAliases.value, aliasStage.value)
      await assert.rejects(readRootRestoreAssetAliasStageCopies5({ kind: aliasStage.owner.kind }), /实际附件别名 owner/)
      const copies = await readRootRestoreAssetAliasStageCopies5(reopenedAliases.owner)
      assert.equal(copies.installPermit, false)
      assert.equal(new Set(copies.files.map(file => file.sourcePath)).size, 3)
      for (const copy of copies.files) {
        assert.equal(copy.path, 'attachments/' + hash.slice(0, 2) + '/' + hash + '/' + copy.logicalName)
        assert.equal(copy.hash, hash)
        assert.equal(copy.bytes, bytes.length)
        assert.deepEqual(await readFile(copy.sourcePath), bytes)
      }
      const latePath = join(copies.location.profileRoot, 'storage', 'assets', 'attachments', hash.slice(0, 2), hash, lateName)
      assert.deepEqual(await readFile(latePath), bytes)
      await unlink(latePath)
      assert.equal(await restoreExists(latePath), false)
      const transfer = await prepareRootRestoreAssetTransfer4(reopenedAliases.owner)
      assert.equal(transfer.installPermit, false)
      assert.equal(transfer.aliasManifestHash, aliasStage.manifestHash)
      assert.deepEqual(transfer.remaining, copies.remaining)
      const coldTransfer = await reopenRestoreAssetTransfer4(copies.location.profileRoot, copies.location.operationId,
        transfer.transferId, transfer.manifestHash)
      assert.equal(coldTransfer.manifestHash, transfer.manifestHash)
      assert.equal(await restoreExists(latePath), false, 'Preparing and reopening the transfer cannot publish the live alias')
      assert.deepEqual(allTables(f.db), sourceBefore)
      assert.deepEqual(allTables(currentDb), currentBefore)
    } finally { current.destroy() }
  }))
