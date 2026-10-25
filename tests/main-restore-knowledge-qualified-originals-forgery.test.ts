import assert from 'node:assert/strict'
import test from 'node:test'
import { captureOriginalReferenceContext } from '../src/main/database/restore-knowledge-reference-context'
import { allTables, withMixedBundleFixture } from './helpers/mixed-origin-bundle-fixture'
import { addOriginalReferenceSyntax, sealedReferenceSource } from './helpers/qualified-originals-fixture'

test('Main context capture rejects missing, fake and getter parent handles for real nonempty C before creating an authority', () => withMixedBundleFixture([1, 1], async f => {
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const source = await sealedReferenceSource(f.source), before = allTables(f.source.db)
  await assert.rejects(captureOriginalReferenceContext({ source: source.source, parents: [] }), /全集/)
  let observed = 0
  const fake = Object.defineProperty({}, 'kind', { get() { observed++; throw Error('caller getter') } })
  await assert.rejects(captureOriginalReferenceContext({ source: source.source, parents: [fake as never] }), /私有|句柄/)
  assert.equal(observed, 0)
  assert.deepEqual(allTables(f.source.db), before); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
