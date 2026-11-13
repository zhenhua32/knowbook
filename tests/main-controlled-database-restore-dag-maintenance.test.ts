import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DURABLE_SQL_DAG_MAX_PARENTS, durableSqlDagRootHash, validateDurableSqlDagNode,
  type DurableSqlCapsuleReference, type DurableSqlDagReference } from '../src/main/database/restore-knowledge-dag-model'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { withControlledRestore, restoreKnowbookDatabase, assertOriginals, originals, noProcesses, inspect } from './helpers/controlled-restore-fixture'
import { ordered } from './helpers/controlled-restore-dag-fixture'

test('the DAG codec rejects oversized parent sets, getter facts, extra own hash and a single capsule reused as both originals', () => {
  const source: DurableSqlCapsuleReference = { kind: 'durable-sql-capsule-ref', version: 1,
    operationId: randomUUID(), capsuleId: randomUUID(), manifestHash: '0'.repeat(64) }
  const current = { ...source, capsuleId: randomUUID() }
  const base = validateDurableSqlDagNode({ kind: 'restore-durable-sql-dag-node', version: 1,
    readerVersion: 'knowbook-durable-sql-dag-v1', material: 'durable-sql-only', source, current, parents: [] })
  const parents = ordered(Array.from({ length: DURABLE_SQL_DAG_MAX_PARENTS + 1 }, (): DurableSqlDagReference => ({
    kind: 'durable-sql-dag-ref', version: 1, operationId: randomUUID(), dagId: randomUUID(), rootHash: '1'.repeat(64) })))
  assert.throws(() => validateDurableSqlDagNode({ ...base, parents }), /集合超预算/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, version: 2 }), /未知/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, readerVersion: 'caller-raw-mode' }), /未知/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, rootHash: durableSqlDagRootHash(base) }), /闭集/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, current: source }), /独立原件/)
  let getterReads = 0
  const accessor = { ...base }
  Object.defineProperty(accessor, 'source', { enumerable: true, get() { getterReads++; return source } })
  assert.throws(() => validateDurableSqlDagNode(accessor), /访问器/)
  assert.equal(getterReads, 0)
})

test('the real ordinary maintenance path writes only prepared DAG diagnostics and preserves receipt1 intent2 and both original sides', () => withControlledRestore(async f => {
  const before = f.sealCurrent(), result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const preflight = JSON.parse(await readFile(join(result.recoveryDirectory, 'knowledge-dag-preflight.json'), 'utf8'))
  assert.equal(preflight.status, 'prepared-originals-only')
  assert.equal(preflight.acceptedSourceKnowledge, false); assert.equal(preflight.acceptedSqlCoverage, false)
  assert.equal(preflight.certifiedForInstallation, false); assert.equal(preflight.dag.certifiedForInstallation, false)
  assert.equal(preflight.dag.nodes, 1); assert.equal(preflight.dag.capsules, 2)
  const intent = JSON.parse(await readFile(join(result.recoveryDirectory, 'intent.json'), 'utf8'))
  assert.equal(intent.version, 2); assert.equal(intent.receipt.version, 1)
  assert.equal('knowledgeRoot' in intent.receipt, false, 'Prepared evidence is not sneaked into the old accepted receipt codec')
  assert.equal(inspect(f.database, db => (db.prepare('SELECT title FROM documents WHERE id=?').get(f.id) as { title: string }).title), 'Ordinary source backup')
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assertOriginals(join(result.recoveryDirectory, 'original', 'knowbook.db'), before)
}))

test('the real maintenance knowledge gate still refuses source before stopping current and never claims a joint DAG preflight', () => withV3Fixture(async f => {
  const backup = join(f.root, 'real-knowledge-source.db')
  await f.store.backupDatabase(backup)
  const before = originals(f.file), sourceBytes = await readFile(backup)
  let stopped = false, replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.userDataRoot, backupPath: backup,
    stopProcesses: async () => { stopped = true; return [] }, beforeReplace: async () => { replaced = true } }), /同步知识|同步历史/)
  assert.equal(stopped, false); assert.equal(replaced, false)
  assertOriginals(f.file, before)
  assert.deepEqual(await readFile(backup), sourceBytes)
  const recovery = join(f.userDataRoot, 'backups', 'database-restore'), names = await readdir(recovery)
  assert.equal(names.length, 1)
  assert.equal((await readdir(join(recovery, names[0]))).includes('knowledge-dag-preflight.json'), false)
}))

test('a late prepared DAG root tamper triggers the original maintenance rollback and leaves both original sides intact', () => withControlledRestore(async f => {
  const before = f.sealCurrent()
  let changed: string | undefined
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => {
      const recovery = join(f.profile, 'backups', 'database-restore'), names = await readdir(recovery)
      assert.equal(names.length, 1)
      const preflight = JSON.parse(await readFile(join(recovery, names[0], 'knowledge-dag-preflight.json'), 'utf8'))
      const ref = preflight.dag.root as DurableSqlDagReference
      changed = join(recovery, ref.operationId, 'knowledge-dags', ref.dagId, 'root.json')
      await writeFile(changed, Buffer.concat([await readFile(changed), Buffer.from('\n')]))
    } }), /DAG|canonical/)
  assert.ok(changed)
  assertOriginals(f.database, before)
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assert.ok((await readFile(changed, 'utf8')).endsWith('\n'), 'The failed prepared artifact remains diagnostic evidence')
}))
