import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureReopenedQualifiedOriginalBundle, readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { allTables } from './helpers/mixed-origin-bundle-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle } from './helpers/qualified-originals-fixture'
import { withQualifiedNestedFixture, captureQualifiedNoPriorSource } from './helpers/qualified-originals-minimal-fixture'

test('qualified hot readers requery their real private SQL originals and a cold reopen never borrows poisoned verification profiles', () => withQualifiedNestedFixture(async f => {
  const current = await captureQualifiedNoPriorSource(f.source, 1)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const saved = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current)
  const before = allTables(f.source.db), base = join(saved.sealed.actual.profileRoot, 'original-input-verification'), originals: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name === 'knowbook.db' && directory.endsWith('original')) originals.push(path)
    }
  }
  await visit(base); assert.ok(originals.length >= 4)
  for (const file of originals) await writeFile(file, 'poisoned saved verification SQL original')
  await assert.rejects(readCompleteOriginalPackage(saved.bundle))
  const cold = await captureReopenedQualifiedOriginalBundle({ profileRoot: saved.sealed.actual.profileRoot,
    operationId: saved.sealed.actual.value.operationId, mountId: saved.mountId, expectedDescriptorHash: saved.descriptorHash })
  assert.deepEqual(cold.value, saved.value)
  assert.deepEqual(allTables(f.source.db), before); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
