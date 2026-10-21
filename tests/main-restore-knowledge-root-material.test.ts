import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { extractCertifiedDurableSqlCapsuleKnowledge, readCertifiedCapsuleKnowledge,
  type CertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-capsule-read'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { captureDurableSqlDag, readCertifiedDurableSqlDag, reopenCertifiedDurableSqlDag,
  extractRootKnowledgeMaterial, readRootKnowledgeMaterial, diagnoseRootKnowledgeMaterial,
  type CertifiedDurableSqlDag, type RootKnowledgeMaterial } from '../src/main/database/restore-knowledge-dag-read'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readSyncedPublicationCapture, type SyncedPublicationCapture } from '../src/main/database/synced-publication'
import { withV3Fixture, createV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureKnowledgeOriginal, extractKnowledge, knowledgeArtifactBytes, knowledgeReadScratchCount } from './helpers/restore-knowledge-payload-fixture'

test('two real roots bind the exact complete ancestor capsule set while producer0 and persisted reopen2 remain unchanged', () => withV3Fixture(async f => {
  const foreign = createV3Fixture(join(f.root, 'independent-payload-source'))
  try {
    const operationId = randomUUID(), a = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), operationId)
    const b = await captureKnowledgeOriginal(f.userDataRoot, dirname(foreign.file), operationId)
    const duplicate = await captureKnowledgeOriginal(f.userDataRoot, a.info.originalDirectory, operationId)
    assert.notEqual(a.seal.manifest.workspaceScope, b.seal.manifest.workspaceScope)
    assert.equal(a.ref.manifestHash, duplicate.ref.manifestHash); assert.notEqual(a.ref.capsuleId, duplicate.ref.capsuleId)
    const captures = [a, b, duplicate], before = await Promise.all(captures.map(knowledgeArtifactBytes))
    const readsBefore = await knowledgeReadScratchCount(a.profileRoot, operationId)
    const first = await captureDurableSqlDag({ profileRoot: a.profileRoot, operationId, dagId: randomUUID(), source: a.capsule, current: b.capsule, parents: [] })
    assert.equal(await knowledgeReadScratchCount(a.profileRoot, operationId), readsBefore, 'A producer uses actual private SQL certificates with zero recertification scratch')
    const root = (await readCertifiedDurableSqlDag(first)).root
    const reopened = await reopenCertifiedDurableSqlDag({ profileRoot: a.profileRoot, operationId, dagId: root.dagId, expectedRootHash: root.rootHash })
    assert.equal(await knowledgeReadScratchCount(a.profileRoot, operationId) - readsBefore, 2, 'Persisted reopen independently recertifies exactly two actual originals')
    assert.deepEqual(await readCertifiedDurableSqlDag(reopened), await readCertifiedDurableSqlDag(first))
    const next = await captureDurableSqlDag({ profileRoot: a.profileRoot, operationId, dagId: randomUUID(), source: b.capsule, current: duplicate.capsule, parents: [first] })
    assert.equal(await knowledgeReadScratchCount(a.profileRoot, operationId) - readsBefore, 2, 'A second producer also adds no SQL scratch')
    const firstMaterial = await extractRootKnowledgeMaterial(first), nextMaterial = await extractRootKnowledgeMaterial(next)
    const one = await readRootKnowledgeMaterial(firstMaterial), two = await readRootKnowledgeMaterial(nextMaterial)
    const keys = (refs: typeof two.capsules) => refs.map(capsuleJson).sort()
    assert.deepEqual(keys(one.capsules), [a.ref, b.ref].map(capsuleJson).sort())
    assert.deepEqual(keys(two.capsules), captures.map(item => capsuleJson(item.ref)).sort())
    assert.deepEqual(two.union.payloads.map(item => capsuleJson(item.capsule)).sort(), keys(two.capsules))
    assert.notEqual(one.root.rootHash, two.root.rootHash); assert.notEqual(one.materialHash, two.materialHash)
    assert.equal((await diagnoseRootKnowledgeMaterial(nextMaterial)).acceptedCoverage, false)
    assert.equal(readSyncedPublicationCapture(nextMaterial as unknown as SyncedPublicationCapture), null)
    assert.equal(Reflect.set(two.capsules, 'length', 0), false)
    assert.equal(Reflect.set(two.union.payloads[0].capsule, 'manifestHash', '0'.repeat(64)), false)
    const subset = await unionCertifiedCapsuleKnowledge([(await extractKnowledge(b)).handle])
    assert.equal((await readCertifiedKnowledgeUnion(subset)).payloads.length, 1)
    await assert.rejects(readRootKnowledgeMaterial(subset as unknown as RootKnowledgeMaterial), /句柄/)
    await assert.rejects(readRootKnowledgeMaterial(JSON.parse(JSON.stringify(two)) as RootKnowledgeMaterial), /句柄/)
    await assert.rejects(extractRootKnowledgeMaterial({ kind: 'certified-durable-sql-dag' } as CertifiedDurableSqlDag), /句柄/)
    await assert.rejects(extractCertifiedDurableSqlCapsuleKnowledge(JSON.parse(JSON.stringify(a.capsule))), /句柄/)
    await assert.rejects(readCertifiedCapsuleKnowledge(two.union.payloads[0] as unknown as CertifiedCapsuleKnowledge), /句柄/)
    assert.deepEqual(await Promise.all(captures.map(knowledgeArtifactBytes)), before)
  } finally { foreign.close() }
}))

for (const target of ['index', 'original'] as const) test('root material rechecks late ' + target + ' tampering without repairing an original', () => withV3Fixture(async f => {
  const source = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file))
  const current = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), source.operationId)
  assert.notEqual(source.ref.capsuleId, current.ref.capsuleId, 'Each side has its own independently certified original')
  const extracted = await extractKnowledge(source)
  const dag = await captureDurableSqlDag({ profileRoot: source.profileRoot, operationId: source.operationId, dagId: randomUUID(),
    source: source.capsule, current: current.capsule, parents: [] })
  const material = await extractRootKnowledgeMaterial(dag)
  const path = target === 'original' ? join(source.info.originalDirectory, 'knowbook.db')
    : join(source.seal.shardsDirectory, source.seal.manifest.evidenceIndex.shards[0].name)
  const bytes = Buffer.concat([await readFile(path), Buffer.from('late real payload original corruption')])
  await writeFile(path, bytes)
  await assert.rejects(readCertifiedCapsuleKnowledge(extracted.handle), /原件|分片|bytes|清单|hash/)
  await assert.rejects(readRootKnowledgeMaterial(material), /原件|分片|bytes|清单|hash/)
  assert.deepEqual(await readFile(path), bytes, 'Failed use preserves the changed bytes as evidence')
}))
