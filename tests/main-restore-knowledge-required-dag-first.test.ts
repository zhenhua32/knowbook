import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureFirstRequiredSqlDag, readCertifiedRequiredSqlDag, type CertifiedRequiredSqlDag } from '../src/main/database/restore-knowledge-required-dag-read'
import { captureCertifiedCapsulePriorCoverage, readCertifiedCapsulePriorCoverage } from '../src/main/database/restore-knowledge-capsule-read'
import { validateRequiredSqlDagNode } from '../src/main/database/restore-knowledge-required-dag-model'
import { readSyncedPublicationCapture, type SyncedPublicationCapture } from '../src/main/database/synced-publication'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'

test('required DAG v2 first producer derives its full parent set from two real different-scope nonempty Main SQL originals', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), { value } = pair
  assert.equal(value.root.readerVersion, 'knowbook-required-sql-knowledge-dag-v2')
  assert.equal(value.node.version, 2); assert.equal(value.capsules.length, 2); assert.deepEqual(value.node.parents, [])
  assert.notEqual(value.node.source.capsule.manifestHash, value.node.current.capsule.manifestHash)
  assert.equal(value.preparedEvidence, true); assert.equal(value.acceptedCoverage, false); assert.equal(value.emptyKnowledgeProven, false)
  assert.equal(readSyncedPublicationCapture(pair.dag as unknown as SyncedPublicationCapture), null)
  const actual = await readCertifiedCapsulePriorCoverage(await captureCertifiedCapsulePriorCoverage(pair.source.capsule))
  assert.deepEqual(actual.requirements.entries, []); assert.equal(actual.namespaceResolved, false)
  assert.equal(actual.emptyKnowledgeProven, false, 'Empty prior-C references do not erase real create/group history or assert empty K')
  assert.ok(Object.isFrozen(value.node.origins.source) && Object.isFrozen(value.node.source.requiredRoots))
  assert.equal(Reflect.set(value.node.source, 'rawRequirementsHash', '0'.repeat(64)), false)
  assert.deepEqual(await readCertifiedRequiredSqlDag(pair.dag), value)
  const changed = structuredClone(value.node)
  Object.assign(changed, { parents: [{ ...value.root, dagId: randomUUID() }] })
  assert.throws(() => validateRequiredSqlDagNode(changed), /父集/)
}))

test('required DAG v2 refuses caller parents, fabricated SQL handles and serialized material without minting or writing a root', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), dagId = randomUUID(), invalid = { ...pair.input, dagId, parents: [] }
  await assert.rejects(captureFirstRequiredSqlDag(invalid as unknown as typeof pair.input), /字段/)
  await assert.rejects(lstat(join(dirname(dirname(pair.file)), dagId)), { code: 'ENOENT' })
  await assert.rejects(captureFirstRequiredSqlDag({ ...pair.input, dagId, source: Object.freeze({ kind: 'certified-durable-sql-capsule' }) }), /句柄/)
  for (const fake of [JSON.parse(JSON.stringify(pair.dag)), JSON.parse(JSON.stringify(pair.value)), { kind: 'certified-required-sql-dag' }])
    await assert.rejects(readCertifiedRequiredSqlDag(fake as CertifiedRequiredSqlDag), /句柄/)
  await assert.rejects(readCertifiedCapsulePriorCoverage(JSON.parse(JSON.stringify(await captureCertifiedCapsulePriorCoverage(pair.current.capsule)))), /句柄/)
}))
