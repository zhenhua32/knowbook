import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { prepareFirstImportedQualifiedKnowledge, readPreparedFirstImportedQualifiedKnowledge } from '../src/main/database/restore-knowledge-qualified-first-bundle-read'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('two genuine imports produce independent qualified materials and a changed mounted original cannot borrow the other or verification copies', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(pair.dag), { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'qualified-two-mount-receiver'))
  try {
    const input = { profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory }
    const a = await importPreparedOriginBundle(input), b = await importPreparedOriginBundle(input)
    const mountedA = await readPreparedOriginBundle(a), mountedB = await readPreparedOriginBundle(b)
    const handleA = await prepareFirstImportedQualifiedKnowledge(a), handleB = await prepareFirstImportedQualifiedKnowledge(b)
    const valueA = await readPreparedFirstImportedQualifiedKnowledge(handleA), valueB = await readPreparedFirstImportedQualifiedKnowledge(handleB)
    assert.notDeepEqual(valueA.root.namespace, valueB.root.namespace); assert.notEqual(valueA.materialHash, valueB.materialHash); assert.notEqual(valueA.unionHash, valueB.unionHash)
    assert.deepEqual(valueA.union.payloads.map(item => item.projection), valueB.union.payloads.map(item => item.projection))
    const file = originBundleExpectedFiles(exported.descriptor).find(file => file.path.endsWith('/original/knowbook.db'))!
    const pathA = join(mountedA.originalDirectory, ...file.path.split('/')), pathB = join(mountedB.originalDirectory, ...file.path.split('/'))
    const originalB = await readFile(pathB), bad = Buffer.from(await readFile(pathA)); bad[bad.length - 1] ^= 1; await writeFile(pathA, bad)
    await assert.rejects(readPreparedFirstImportedQualifiedKnowledge(handleA), /bytes|hash/)
    assert.equal((await readPreparedFirstImportedQualifiedKnowledge(handleB)).materialHash, valueB.materialHash)
    assert.deepEqual(await readFile(pathA), bad); assert.deepEqual(await readFile(pathB), originalB)
  } finally { receiver.close() }
}))
