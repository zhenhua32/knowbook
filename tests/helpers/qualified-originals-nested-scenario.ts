import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readPreparedMixedOriginalDirectoryBytes } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { allTables } from './mixed-origin-bundle-fixture'
import { withQualifiedNestedFixture, captureQualifiedNoPriorSource } from './qualified-originals-minimal-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle, prepareOriginalReferenceCut } from './qualified-originals-fixture'

export async function withNestedOriginalScenario(run: (value: Awaited<ReturnType<typeof prepare>>) => Promise<void>, withKnowledgePlan = false) {
  await withQualifiedNestedFixture(async f => {
    const value = await prepare(f, withKnowledgePlan)
    try { await run(value) }
    finally {
      const before = value.before
      assert.deepEqual(allTables(f.source.db), before)
      assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    }
  })
}
async function prepare(f: Parameters<Parameters<typeof withQualifiedNestedFixture>[0]>[0], withKnowledgePlan: boolean) {
  const started = performance.now(), stage = (name: string) => console.info('[qualified-original-stage]', JSON.stringify({ name, elapsedMs: Math.round(performance.now() - started) }))
  const current = await captureQualifiedNoPriorSource(f.source, 1)
  const firstOperation = randomUUID()
  prepareOriginalReferenceCut(f.source, f.value.originalRoot.operationId)
  prepareOriginalReferenceCut(f.source, firstOperation)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const first = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current, firstOperation, withKnowledgePlan)
  stage('first-root')
  // Stored C roots remain native relative to their original SQL. Imported
  // parent qualifiers belong to the original node/context, never rewritten C.
  addOriginalReferenceSyntax(f.source, first.value.root)
  const second = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }, { bundle: first.bundle, original: first.value.root }], current, undefined, withKnowledgePlan), before = allTables(f.source.db)
  stage('second-root')
  assert.equal(second.value.depth, 3); assert.equal(second.value.nodes, 4); assert.equal(second.value.capsules, 8)
  const projection = second.value.inputs[0].knowledge.projection
  assert.ok('coverageMaterial' in projection); assert.equal(projection.coverageMaterial.length, 8)
  assert.equal(second.value.parents.length, 2)
  assert.ok(second.contextData.descriptor.requirements.entries.every(entry => entry.root.namespace.kind === 'native'))
  assert.ok(second.value.node.parents.every(root => root.namespace.kind === 'imported-bundle'))
  const nested = second.value.parents.find(parent => parent.original.parents.length)!
  const direct = second.value.parents.find(parent => !parent.original.parents.length)!
  assert.deepEqual(nested.original.parents[0].original, direct.original, 'Identical original knowledge remains under two distinct complete physical domains')
  assert.notDeepEqual(nested.original.parents[0].reference.namespace, direct.reference.namespace)
  const finalPackage = second.originalPackage
  const stats = await Promise.all(finalPackage.files.map(file => lstat(file.sourcePath, { bigint: true })))
  assert.equal(new Set(stats.map(stat => String(stat.dev) + ':' + String(stat.ino))).size, stats.length)
  assert.ok(stats.every(stat => stat.nlink === 1n))
  // Exact actual Main fixture outputs; no live profile or UUID fallback.
  const basePackage = await readPreparedMixedOriginalDirectoryBytes(f.handle)
  for (const directory of [f.exported.directory, basePackage.directory, first.directory, first.contextData.directory, second.contextData.directory])
    await rm(directory, { recursive: true })
  for (const directory of [current.original.info.originalDirectory, first.sealed.original.info.originalDirectory, second.sealed.original.info.originalDirectory])
    await writeFile(join(directory, 'knowbook.db'), 'retired earlier source original')
  return { f, second, before, stage }
}
