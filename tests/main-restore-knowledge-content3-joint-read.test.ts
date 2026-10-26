import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readCompleteOriginalContentPair3, prepareQualifiedOriginalImport, captureReopenedQualifiedOriginalBundle } from '../src/main/database/restore-knowledge-qualified-originals'
import { readRootKnowledgeConservationContent3 } from '../src/main/database/restore-knowledge-root3-read'
import { parseRequiredSqlDagNode, requiredSqlDagRootHash } from '../src/main/database/restore-knowledge-required-dag-model'
import { tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { allTables, randomUUID } from './helpers/synced-backup-v3-fixture'
import { observeCompleteSqlReads, withContent3JointReadFixture, wholeContent3PairHash,
  type CompleteSqlReadObservation } from './helpers/content3-joint-read-fixture'

const require = createRequire(import.meta.url)
const fs: typeof import('node:fs/promises') = require('node:fs/promises')
function exactRootReads(observations: CompleteSqlReadObservation[]) {
  assert.equal(observations.length, 2, 'The two real root packets each execute their complete SQL/K reader once')
  assert.notEqual(observations[0].databasePath, observations[1].databasePath)
  for (const observed of observations) {
    assert.equal(observed.completed, true)
    assert.equal(observed.readonly, true)
    assert.equal(observed.queryOnly, 1)
    assert.equal(observed.foreignKeys, 1)
    assert.equal(observed.inTransaction, true)
    assert.equal(observed.totalChangesBefore, 0)
    assert.equal(observed.totalChangesAfter, 0)
  }
}

test('fixed Main content reads authenticate each actual root SQL packet once and keep complete mixed qualified and late-byte contracts', { concurrency: false }, t => {
  const probe = observeCompleteSqlReads(t)
  return withContent3JointReadFixture(async f => {
    const coldMintReads = probe.observations.length
    assert.ok(coldMintReads > 0, 'The observation seam saw the actual complete native SQL/K callback during cold source construction')
    t.diagnostic('cold source and owner construction SQL/K leaves are separate from warm-read counts: ' + coldMintReads)
    await t.test('fake copied and accessor bundles fail before executing caller properties or complete SQL readers', async () => {
      const before = probe.observations.length
      let calls = 0
      const fake = Object.defineProperty({}, 'kind', { get() { calls++; throw new Error('caller getter') } })
      await assert.rejects(readCompleteOriginalContentPair3(fake as never))
      await assert.rejects(readCompleteOriginalContentPair3({ ...f.mixed.bundle }))
      await assert.rejects(readCompleteOriginalContentPair3({ ...f.qualified.bundle }))
      await assert.rejects(readCompleteOriginalContentPair3(f.expectedMixed as never))
      assert.equal(calls, 0)
      assert.equal(probe.observations.length, before)
    })
    await t.test('mixed hot reads preserve the entire original package and both actual source packets while every read uses new native SQL', async () => {
      const first = await probe.measure(() => readCompleteOriginalContentPair3(f.mixed.bundle))
      exactRootReads(first.observations)
      assert.deepEqual(first.value, f.expectedMixed)
      assert.equal(wholeContent3PairHash(first.value), wholeContent3PairHash(f.expectedMixed))
      assert.notEqual(first.value.source.capsuleId, first.value.current.capsuleId)
      assert.notEqual(first.value.source.materialHash, first.value.current.materialHash)
      assert.deepEqual(first.value.source.knowledge, f.left.packet.knowledge)
      assert.deepEqual(first.value.current.knowledge, f.right.packet.knowledge)
      const second = await probe.measure(() => readCompleteOriginalContentPair3(f.mixed.bundle))
      exactRootReads(second.observations)
      assert.deepEqual(second.value, first.value)
      const oldPaths = new Set(first.observations.map(item => item.databasePath))
      for (const observed of second.observations) assert.equal(oldPaths.has(observed.databasePath), false, 'Every later read gets fresh real SQL scratch')
    })
    await t.test('qualified roots read two complete capsule2 packets and retain the independently reread v1 ancestor domain without turning it into business content', async () => {
      const first = await probe.measure(() => readCompleteOriginalContentPair3(f.qualified.bundle))
      exactRootReads(first.observations)
      assert.deepEqual(first.value, f.expectedQualified)
      assert.equal(wholeContent3PairHash(first.value), wholeContent3PairHash(f.expectedQualified))
      assert.equal(first.value.originalPackage.original.parents.length, 1)
      const parent = first.value.originalPackage.original.parents[0].original
      assert.equal(parent.inputs.length, 2)
      for (const input of parent.inputs) assert.equal(input.binding.capsule.readerVersion, 'knowbook-durable-sql-v1')
      assert.deepEqual(first.value.source.knowledge, f.qualified.sealed.actual.value.knowledge)
      assert.deepEqual(first.value.current.knowledge, f.right.packet.knowledge)
      const second = await probe.measure(() => readCompleteOriginalContentPair3(f.qualified.bundle))
      exactRootReads(second.observations)
      assert.deepEqual(second.value, first.value)
      assert.equal(Object.isFrozen(second.value.source.source.sourceContent.tables), true)
      const oldPaths = new Set(first.observations.map(item => item.databasePath))
      for (const observed of second.observations) assert.equal(oldPaths.has(observed.databasePath), false)
    })
    await t.test('a genuine v1 root remains rejected instead of borrowing business data from another actual capsule2 owner', async () => {
      const before = probe.observations.length
      await assert.rejects(readCompleteOriginalContentPair3(f.handle), /v1|capsule2/)
      assert.equal(probe.observations.length, before)
    })
    await t.test('qualified hot reads reject a changed actual v1 ancestor verification original and reread it after byte restoration', async () => {
      const binding = f.expectedQualified.originalPackage.original.parents[0].original.node.source.capsule
      const base = join(f.source.userDataRoot, 'original-input-verification'), candidates: string[] = []
      for (const directory of await fs.readdir(base, { withFileTypes: true })) {
        assert.equal(directory.isSymbolicLink(), false)
        if (!directory.isDirectory()) continue
        const original = join(base, directory.name, 'backups', 'database-restore', binding.operationId,
          'knowledge-capsules', binding.capsuleId, 'original', 'knowbook.db')
        try { if ((await fs.lstat(original)).isFile()) candidates.push(original) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      assert.equal(candidates.length, 1, 'Exactly this qualified owner has the independent active v1 ancestor copy')
      const original = candidates[0], bytes = await fs.readFile(original), changed = Buffer.from(bytes)
      changed[0] ^= 0xff
      await fs.writeFile(original, changed)
      try { await assert.rejects(readCompleteOriginalContentPair3(f.qualified.bundle)) }
      finally { await fs.writeFile(original, bytes) }
      const restored = await probe.measure(() => readCompleteOriginalContentPair3(f.qualified.bundle))
      exactRootReads(restored.observations)
      assert.deepEqual(restored.value, f.expectedQualified)
    })
    await t.test('a re-signed actual copied descriptor cannot assign a real bound certificate to the other root binding', async () => {
      const operationId = randomUUID(), copied = await prepareQualifiedOriginalImport({ profileRoot: f.receiver.userDataRoot,
        operationId, sourceDirectory: f.qualified.directory, expectedDescriptorHash: f.qualified.descriptorHash })
      const path = join(copied.directory, 'descriptor.json')
      const descriptor = JSON.parse(await fs.readFile(path, 'utf8'))
      const node = parseRequiredSqlDagNode(descriptor.nodeText)
      const changedNode = { ...node, source: node.current, current: node.source,
        origins: { source: node.origins.current, current: node.origins.source } }
      const changed = { ...descriptor, nodeText: capsuleJson(changedNode), root: { ...descriptor.root, rootHash: requiredSqlDagRootHash(changedNode) } }
      // Re-sign both structural hashes. The genuine side certificate strings
      // deliberately remain attached to the wrong bindings, which must fail.
      const hash = capsuleBytesHash('knowbook.qualified-original-inputs.v1\0' + capsuleJson(changed))
      await fs.writeFile(path, capsuleJson(changed) + '\n')
      const before = probe.observations.length
      await assert.rejects(captureReopenedQualifiedOriginalBundle({ profileRoot: f.receiver.userDataRoot,
        operationId, mountId: copied.mountId, expectedDescriptorHash: hash }), /bound来源reader\/origin不准确/)
      assert.equal(probe.observations.length, before)
    })
    await t.test('a later hot mixed read rejects changed real verification SQL despite the intact complete packet returned earlier', async () => {
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readCompleteOriginalContentPair3(f.mixed.bundle))
    })
    await t.test('the Root3 content owner rejects context mutation after complete fresh SQL and both independent context FD reads finish', async () => {
      const open = fs.open, start = probe.observations.length
      let injected = false, independentOpens = 0
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const fd = await Reflect.apply(open, fs, args), close = fd.close.bind(fd)
        if (String(args[0]) === f.contextFile.sourcePath && new Error().stack?.includes('restore-knowledge-root3-contexts')) {
          independentOpens++
          if (independentOpens === 2) fd.close = async () => {
            await close()
            if (!injected) { injected = true; await fs.writeFile(f.contextFile.sourcePath, 'changed after the actual complete Root3 content read') }
          }
        }
        return fd
      })
      syncBuiltinESMExports()
      try { await assert.rejects(readRootKnowledgeConservationContent3(f.qualified.knowledgePlan!)) }
      finally {
        t.mock.restoreAll(); syncBuiltinESMExports()
        assert.equal(injected, true)
        assert.equal(independentOpens, 2)
        exactRootReads(probe.observations.slice(start))
      }
    })
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  })
})
