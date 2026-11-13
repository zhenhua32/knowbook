import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { prepareRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreCanonicalAssetPhysicalFromCombined5, prepareRootRestoreCanonicalAssetPhysicalStage5 }
  from '../src/main/database/restore-knowledge-stage3-physical'
import { canonicalRestoreRoot, restoreExists, restoreInventory } from '../src/main/database/restore-safety-files'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock, randomUUID, sha256, withV3Fixture } from './helpers/synced-backup-v3-fixture'

const tracePath = process.env.KNOWBOOK_CANONICAL_ASSET_TEST_TRACE
function phase(name: string) {
  if (tracePath) appendFileSync(tracePath, JSON.stringify({ actor: 'parent', pid: process.pid, time: new Date().toISOString(),
    elapsedMs: Math.round(performance.now()), phase: name }) + '\n')
}

test('fresh canonical group writes its localized body, shifted bindings and immutable activation together and reopens cold',
  () => withV3Fixture(async f => {
    phase('fixture-ready')
    const seal = async () => {
      const original = await captureAssetOriginal(f), sealed = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
      const certificate = await certifyCapsule2Source(sealed.source)
      if (certificate.status !== 'certified-without-prior-coverage') throw new Error('Expected a real typed base certificate')
      return { original, sealed, certificate }
    }
    const retained = f.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(f.groupId)
    assert.ok(retained)
    const operations = f.db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all()
    assert.ok(operations.length)
    const current = await seal()
    phase('current-certified')
    const bytes = Buffer.from('canonical fresh alias ' + randomUUID()), digest = sha256(bytes)
    const names = ['first (canonical).png', '第二别名.png']
    const files = await f.assets.import(names.map(name => ({ name, bytes })))
    const documentId = f.store.createDocument(null), blockId = randomUUID()
    const content = '😀 prefix\r\n\r\n![first](<' + files[0].url + '>) ![second](<' + files[1].url
      + '>) [heading](/V3%20Target.md#target-heading)\r\n\r\n`' + files[0].url + '`'
    f.store.updateDocument(documentId, { title: 'Incoming canonical alias', summary: '', blocks: [freshBlock(blockId, content)] })
    const birth = (f.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(blockId) as { created_at: string }).created_at
    created(applySyncedHostCommand(f.db, createRequest(f.db, { documentId, selectedRootIds: [blockId] })))
    const liveBefore = allTables(f.db), source = await seal()
    phase('source-certified')
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.original.info.profileRoot, operationId: source.sealed.value.operationId,
      dagId: randomUUID(), source: source.certificate.source, current: current.certificate.source })
    phase('dag-prepared')
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
    phase('bundle-exported')
    const receiver = join(f.root, 'canonical alias receiver')
    await mkdir(receiver)
    const profileRoot = await canonicalRestoreRoot(receiver), operationId = randomUUID()
    const mounted = await captureMixedRootKnowledgeConservationPlan3({ profileRoot, operationId, sourceDirectory: exported.directory })
    phase('mounted-knowledge')
    const namespace = mounted.value.root.namespace
    if (namespace.kind !== 'imported-bundle') throw new Error('Expected actual copied mixed originals')
    const identity = await prepareRootRestoreIdentityPlan3(mounted.knowledgePlan)
    phase('identity-prepared')
    const reference = await prepareRootRestoreReferencePlan3(identity.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
    phase('reference-prepared')
    const combined = await prepareRootRestoreSqlAssetStage5(reference.plan)
    phase('combined-prepared')
    const base = join(combined.sql.directory, 'database'), baseBefore = await restoreInventory(base)
    phase('canonical-compose-started')
    const { aliases, stage } = await prepareRootRestoreCanonicalAssetPhysicalFromCombined5(reference.plan, combined.stage)
    phase('canonical-physical-prepared')
    await assert.rejects(prepareRootRestoreCanonicalAssetPhysicalStage5(reference.plan, { kind: aliases.owner.kind }), /实际附件别名 owner/)
    const proof = stage.value.canonicalAssets
    assert.ok(proof)
    assert.equal(proof.groups.length, 1)
    assert.equal(proof.rewrittenOccurrences, 2)
    assert.equal(proof.remainingCanonicalOccurrences, 0)
    assert.equal(stage.value.version, 2)
    assert.equal(stage.value.installPermit, false)
    const group = proof.groups[0], baseline = reference.value.candidate.activeGroupWires.find(wire => wire.id === group.groupId)
    assert.ok(baseline)
    assert.equal(baseline.blocks.length, 1)
    assert.ok(baseline.bindings.length)
    const physical = combined.sql.value.tables.find(table => table.name === 'synced_group_blocks')!
    const original = physical.rows.find(row => row.cells[physical.columns.indexOf('id')][1]
      === Buffer.from(baseline.blocks[0].id).toString('base64'))
    assert.ok(original)
    const backups = join(source.original.info.profileRoot, 'backups')
    await rename(backups, backups + '-retired')
    const locate = (item: { stageId: string; manifestHash: string }) => ({ stageId: item.stageId, expectedManifestHash: item.manifestHash })
    phase('launch-cold-process')
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/canonical-asset-physical5-process.cjs'),
      JSON.stringify({ original: { profileRoot, operationId, mountId: namespace.mountId, expectedDescriptorHash: mounted.originalPackage.descriptorHash },
        identity: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
        reference: { planId: reference.planId, expectedManifestHash: reference.manifestHash }, combined: locate(combined),
        aliases: locate(aliases), stage: locate(stage), retainedGroupId: f.groupId })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })
    phase('cold-process-completed')
    const cold = JSON.parse(stdout)
    assert.notEqual(cold.pid, process.pid)
    assert.equal(cold.manifestHash, stage.manifestHash)
    assert.equal(cold.activationHash, group.activationHash)
    assert.equal(cold.rowid, original.targetRowId)
    assert.equal(cold.wire.blocks[0].id, baseline.blocks[0].id)
    assert.equal(cold.wire.blocks[0].createdAt, birth)
    assert.deepEqual(cold.wire.origin, baseline.origin)
    const text = cold.wire.blocks[0].content as string
    const localized = [...text.matchAll(/!\[(?:first|second)\]\(<([^>]+)>\)/g)].map(match => match[1])
    assert.equal(localized.length, 2)
    assert.deepEqual(localized.map(uri => fileURLToPath(uri)), names.map(name => join(profileRoot, 'storage', 'assets', 'attachments', digest.slice(0, 2), digest, name)))
    assert.equal(text, baseline.blocks[0].content.replace(files[0].url, localized[0]).replace(files[1].url, localized[1]))
    const shift = localized[0].length - files[0].url.length + localized[1].length - files[1].url.length
    assert.notEqual(shift, 0)
    assert.deepEqual(cold.wire.bindings, baseline.bindings.map(binding => ({ ...binding, from: binding.from + shift, to: binding.to + shift })))
    assert.deepEqual(cold.retained, retained)
    assert.deepEqual(cold.operations, operations)
    assert.deepEqual(await restoreInventory(base), baseBefore)
    assert.deepEqual(allTables(f.db), liveBefore)
    assert.equal(await restoreExists(join(profileRoot, 'storage', 'knowbook.db')), false)
    phase('assertions-completed')
  }))
