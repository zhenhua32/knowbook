import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readRootKnowledgeConservationContent3, readRootKnowledgeConservationContentAndOriginals5 } from '../src/main/database/restore-knowledge-root3-read'
import { observeCompleteSqlReads, withContent3JointReadFixture } from './helpers/content3-joint-read-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

const require = createRequire(import.meta.url)
const fs: typeof import('node:fs/promises') = require('node:fs/promises')

test('same-read Root3 runtime originals still reject late real qualified context bytes after both complete SQL packets and independent context FD reads finish', { concurrency: false }, t => {
  const probe = observeCompleteSqlReads(t)
  return withContent3JointReadFixture(async f => {
    assert.ok(f.qualified.knowledgePlan)
    const expected = await readRootKnowledgeConservationContent3(f.qualified.knowledgePlan)
    const originalBytes = await fs.readFile(f.contextFile.sourcePath)
    const open = fs.open, start = probe.observations.length
    let injected = false, independentOpens = 0
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const fd = await Reflect.apply(open, fs, args), close = fd.close.bind(fd)
      if (String(args[0]) === f.contextFile.sourcePath && new Error().stack?.includes('restore-knowledge-root3-contexts')) {
        independentOpens++
        if (independentOpens === 2) fd.close = async () => {
          await close()
          if (!injected) { injected = true; await fs.writeFile(f.contextFile.sourcePath, 'changed after the actual same-read Root3 content and independent context FD reads') }
        }
      }
      return fd
    })
    syncBuiltinESMExports()
    try { await assert.rejects(readRootKnowledgeConservationContentAndOriginals5(f.qualified.knowledgePlan)) }
    finally {
      t.mock.restoreAll(); syncBuiltinESMExports()
      await fs.writeFile(f.contextFile.sourcePath, originalBytes)
      assert.equal(injected, true); assert.equal(independentOpens, 2)
      const actualReads = probe.observations.slice(start)
      assert.equal(actualReads.length, 2, 'Both genuine root packets completed before the independent late mutation')
      for (const observed of actualReads) {
        assert.equal(observed.completed, true); assert.equal(observed.readonly, true)
        assert.equal(observed.queryOnly, 1); assert.equal(observed.foreignKeys, 1); assert.equal(observed.inTransaction, true)
        assert.equal(observed.totalChangesBefore, 0); assert.equal(observed.totalChangesAfter, 0)
      }
    }
    const restored = await readRootKnowledgeConservationContentAndOriginals5(f.qualified.knowledgePlan)
    assert.deepEqual(restored.value, expected)
    assert.equal(restored.original, f.qualified.bundle)
    assert.equal(restored.pair.originalPackage.original.parents.length, 1)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  })
})
