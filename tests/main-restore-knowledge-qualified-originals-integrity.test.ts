import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { link, readFile, unlink, writeFile } from 'node:fs/promises'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { capsule2ReferenceContextHash } from '../src/main/database/restore-knowledge-reference-context-model'
import { readOriginalReferenceContext, reopenOriginalReferenceContext, bindCapsule2OriginalInputs } from '../src/main/database/restore-knowledge-reference-context'
import { readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { allTables, withMixedBundleFixture } from './helpers/mixed-origin-bundle-fixture'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle } from './helpers/qualified-originals-fixture'

test('qualified context reopens against actual complete SQL and every parent rather than rehashed descriptor authority', t => withMixedBundleFixture([1, 1], async f => {
  const current = await captureMixedSource(f.source, 1)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const saved = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current), ctx = saved.contextData
  const path = join(ctx.directory, 'descriptor.json'), original = await readFile(path), before = allTables(f.source.db)
  for (const attack of ['parent-material', 'declared-bytes', 'drop-root', 'raw-support', 'authority'] as const) await t.test(attack, async () => {
    const changed = JSON.parse(original.toString())
    if (attack === 'parent-material') changed.parents[0].materialHash = '0'.repeat(64)
    if (attack === 'declared-bytes') changed.parents[0].originalSqlBytes++
    if (attack === 'drop-root') changed.parents = []
    if (attack === 'raw-support') changed.requirements.entries[0].supports.coverage.rowHash = '0'.repeat(64)
    if (attack === 'authority') changed.acceptedCoverage = true
    try {
      await writeFile(path, capsuleJson(changed) + '\n')
      await assert.rejects(async () => reopenOriginalReferenceContext({ source: saved.sealed.source,
        contextId: changed.contextId, expectedContextHash: capsule2ReferenceContextHash(changed) }))
    } finally { await writeFile(path, original) }
  })
  await assert.rejects(bindCapsule2OriginalInputs(saved.context), /已开始/)
  const alias = join(ctx.profileRoot, 'outside-context-alias')
  await link(path, alias); await assert.rejects(readOriginalReferenceContext(saved.context)); await unlink(alias)
  await writeFile(join(ctx.directory, 'unlisted'), 'extra original context entry')
  await assert.rejects(readOriginalReferenceContext(saved.context)); await unlink(join(ctx.directory, 'unlisted'))
  assert.deepEqual((await readCompleteOriginalPackage(saved.bundle)).original, saved.value)
  assert.deepEqual(allTables(f.source.db), before); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
