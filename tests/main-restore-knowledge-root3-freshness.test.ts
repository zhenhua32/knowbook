import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureReopenedRootKnowledgeConservationPlan3, readRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { withQualifiedNestedFixture, captureQualifiedNoPriorSource } from './helpers/qualified-originals-minimal-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle } from './helpers/qualified-originals-fixture'

test('complete Root3 plan rechecks actual SQL readers on hot use and cold original reopening independently rebuilds the same constraints', () => withQualifiedNestedFixture(async f => {
  const current = await captureQualifiedNoPriorSource(f.source, 1)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const saved = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current, undefined, true)
  assert.ok(saved.knowledgePlan); assert.ok(saved.knowledgeValue)
  const first = { plan: saved.knowledgePlan, value: saved.knowledgeValue }, originals: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name === 'knowbook.db' && directory.endsWith('original')) originals.push(path)
    }
  }
  await visit(join(saved.sealed.actual.profileRoot, 'original-input-verification'))
  assert.ok(originals.length >= 4)
  for (const file of originals) await writeFile(file, 'Root3 saved verification SQL original was changed')
  await assert.rejects(readRootKnowledgeConservationPlan3(first.plan))
  const reopened = await captureReopenedRootKnowledgeConservationPlan3({ profileRoot: saved.sealed.actual.profileRoot,
    operationId: saved.sealed.actual.value.operationId, mountId: saved.mountId, expectedDescriptorHash: saved.descriptorHash })
  assert.deepEqual(reopened.knowledgeValue, first.value)
}))
