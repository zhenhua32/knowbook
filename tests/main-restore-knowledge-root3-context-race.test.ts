import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { referenceContextCatalogPath } from '../src/main/database/restore-knowledge-qualified-original-model'
import { withQualifiedNestedFixture, captureQualifiedNoPriorSource } from './helpers/qualified-originals-minimal-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle } from './helpers/qualified-originals-fixture'

const require = createRequire(import.meta.url)
const fs: typeof import('node:fs/promises') = require('node:fs/promises')

test('complete Root3 owner rejects context bytes changed after the actual independent context-read FD closes', { concurrency: false }, t => withQualifiedNestedFixture(async f => {
  const current = await captureQualifiedNoPriorSource(f.source, 1)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const saved = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current, undefined, true)
  assert.ok(saved.knowledgePlan)
  const input = saved.value.inputs.find(input => input.origin.kind === 'bound-original-bundle')!
  assert.ok(input.origin.kind === 'bound-original-bundle')
  const path = referenceContextCatalogPath(input.binding, input.origin.mountId)
  const file = saved.originalPackage.files.find(file => !file.frame.length && file.path === path)!
  assert.ok(file)
  const open = fs.open; let injected = false, independentOpens = 0
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const fd = await Reflect.apply(open, fs, args), close = fd.close.bind(fd)
    const isIndependentContextRead = String(args[0]) === file.sourcePath && new Error().stack?.includes('restore-knowledge-root3-contexts')
    if (isIndependentContextRead) independentOpens++
    // The first FD hashes original bytes; the second reads bounded TEXT.
    // Attack only after both captures have completed, before the owner closes
    // its complete immutable-package bracket.
    if (isIndependentContextRead && independentOpens === 2) fd.close = async () => {
      await close()
      if (!injected) { injected = true; await fs.writeFile(file.sourcePath, 'changed after actual Root3 context extraction') }
    }
    return fd
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(readRootKnowledgeConservationPlan3(saved.knowledgePlan!))
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports()
    assert.equal(injected, true, 'Attack follows both actual Root3-specific descriptor reads, after complete SQL capture')
    assert.equal(independentOpens, 2)
  }
}))
