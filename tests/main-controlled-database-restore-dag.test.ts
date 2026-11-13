import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureDurableSqlDag, readCertifiedDurableSqlDag, reopenCertifiedDurableSqlDag,
  type CertifiedDurableSqlDag } from '../src/main/database/restore-knowledge-dag-read'
import { readDurableSqlDagNodeFile } from '../src/main/database/restore-knowledge-dag-files'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { capture, captureDirectory, immutableBytes, input, setupPair } from './helpers/controlled-restore-dag-fixture'

test('a prepared DAG SQL-recertifies genuinely different source/current scopes and Main ACK facts without claiming K or installation', () => withV3Fixture(async f => {
  const pair = await setupPair(f), handle = await capture(pair), diagnostic = await readCertifiedDurableSqlDag(handle)
  const before = await immutableBytes(pair)
  assert.equal(diagnostic.nodes, 1); assert.equal(diagnostic.capsules, 2); assert.equal(diagnostic.height, 1)
  assert.equal(diagnostic.semanticKnowledgeExtracted, false); assert.equal(diagnostic.acceptedSqlCoverage, false)
  assert.equal(diagnostic.certifiedForInstallation, false)
  const file = await readDurableSqlDagNodeFile(pair.profileRoot, diagnostic.root)
  assert.deepEqual(file.node.source, pair.source.ref); assert.deepEqual(file.node.current, pair.current.ref)
  const reopened = await reopenCertifiedDurableSqlDag(input(pair, diagnostic.root))
  assert.deepEqual(await readCertifiedDurableSqlDag(reopened), diagnostic)
  assert.deepEqual(await immutableBytes(pair), before)
}))

test('a three-level prepared diamond preserves both branches and shares the exact ancestor and original vertices', () => withV3Fixture(async f => {
  const pair = await setupPair(f), ancestor = await capture(pair)
  await assert.rejects(capture(pair, [ancestor, ancestor]), /parent引用未按准确locator排序或重复矛盾/)
  assert.equal((await readdir(join(pair.recoveryDirectory, 'knowledge-dags'))).length, 1, 'A duplicate real parent handle did not mint another persistent node')
  const left = await capture(pair, [ancestor]), right = await capture(pair, [ancestor])
  const reads = join(pair.recoveryDirectory, 'knowledge-capsule-reads')
  const before = (await readdir(pair.recoveryDirectory)).includes('knowledge-capsule-reads') ? (await readdir(reads)).length : 0
  const diagnostic = await readCertifiedDurableSqlDag(await capture(pair, [left, right]))
  const afterCapture = (await readdir(pair.recoveryDirectory)).includes('knowledge-capsule-reads') ? (await readdir(reads)).length : 0
  assert.equal(diagnostic.nodes, 4, 'Two equal-byte branch nodes retain their different genuine locators')
  assert.equal(diagnostic.capsules, 2, 'The exact two shared original locators retain both genuine SQL certificates')
  assert.equal(afterCapture - before, 0, 'The producer reuses private SQL certificates and creates no redundant SQL scratch')
  const reopened = await readCertifiedDurableSqlDag(await reopenCertifiedDurableSqlDag(input(pair, diagnostic.root)))
  assert.deepEqual(reopened, diagnostic)
  assert.equal((await readdir(reads)).length - afterCapture, 2, 'Actual reopen creates exactly one independent SQL recertification scratch per unique original')
  assert.equal(diagnostic.height, 3)
  assert.equal(diagnostic.acceptedSqlCoverage, false, 'Prepared evidence ancestry does not claim three accepted restores')
}))

test('fabricated DAG or capsule handles and a wrong trusted root hash cannot produce a certified graph', () => withV3Fixture(async f => {
  const pair = await setupPair(f), handle = await capture(pair), diagnostic = await readCertifiedDurableSqlDag(handle)
  const before = await immutableBytes(pair)
  const fakeDag: CertifiedDurableSqlDag = Object.freeze({ kind: 'certified-durable-sql-dag' })
  const fakeCapsule: typeof pair.source.capsule = Object.freeze({ kind: 'certified-durable-sql-capsule' })
  await assert.rejects(readCertifiedDurableSqlDag(fakeDag), /句柄/)
  await assert.rejects(captureDurableSqlDag({ profileRoot: pair.profileRoot, operationId: pair.operationId, dagId: randomUUID(),
    source: fakeCapsule, current: pair.current.capsule, parents: [] }), /句柄/)
  await assert.rejects(capture(pair, [fakeDag]), /句柄/)
  const wrong = { ...diagnostic.root, rootHash: (diagnostic.root.rootHash[0] === '0' ? '1' : '0') + diagnostic.root.rootHash.slice(1) }
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, wrong)), /根hash/)
  assert.equal((await readdir(join(pair.recoveryDirectory, 'knowledge-dags'))).length, 1, 'No fabricated handle minted another persistent node')
  assert.deepEqual(await readCertifiedDurableSqlDag(handle), diagnostic)
  assert.deepEqual(await immutableBytes(pair), before)
}))

test('equal capsule manifest hashes at different real locators keep both original supports in the DAG', () => withV3Fixture(async f => {
  const pair = await setupPair(f), duplicate = await captureDirectory(pair.profileRoot, pair.operationId, pair.source.info.originalDirectory)
  assert.equal(duplicate.seal.manifestHash, pair.source.seal.manifestHash)
  assert.notEqual(duplicate.ref.capsuleId, pair.source.ref.capsuleId)
  const first = await capture(pair)
  const second = await captureDurableSqlDag({ profileRoot: pair.profileRoot, operationId: pair.operationId, dagId: randomUUID(),
    source: duplicate.capsule, current: pair.current.capsule, parents: [first] })
  assert.equal((await readCertifiedDurableSqlDag(second)).capsules, 3, 'Distinct locators are not discarded merely because their manifest hash is equal')
  const changed = join(duplicate.info.originalDirectory, 'knowbook.db')
  await writeFile(changed, Buffer.concat([await readFile(changed), Buffer.from('tamper only the second equal-hash copy')]))
  await assert.rejects(readCertifiedDurableSqlDag(second), /原件|bytes|清单/)
  await assert.rejects(capture(pair, [second]), /原件|bytes|清单/, 'Producer reuse must recheck every original in the private parent closure')
}))
