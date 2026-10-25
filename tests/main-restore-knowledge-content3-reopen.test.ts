import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rename } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareRootRestoreContentPlan3 } from '../src/main/database/restore-knowledge-content3-read'
import { prepareRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareQualifiedOriginalImport, readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { readPreparedMixedOriginalDirectoryBytes } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { withQualifiedNestedFixture, captureQualifiedNoPriorSource } from './helpers/qualified-originals-minimal-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle } from './helpers/qualified-originals-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('complete content planner refuses v1 payloads and independently reopens capsule2 content with original qualified prior-C domains after earlier sources retire', () => withQualifiedNestedFixture(async f => {
  const legacy = await prepareRootKnowledgeConservationPlan3(f.handle)
  await assert.rejects(prepareRootRestoreContentPlan3(legacy.plan), /v1知识不能补造/)
  const current = await captureQualifiedNoPriorSource(f.source, 2)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const saved = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current, undefined, true)
  assert.ok(saved.knowledgePlan); assert.ok(saved.knowledgeValue)
  const expected = (await prepareRootRestoreContentPlan3(saved.knowledgePlan)).value
  assert.equal(saved.knowledgeValue.constraints.nodes.length, 2)
  assert.equal(saved.knowledgeValue.constraints.priorCoverage.length, 1)
  assert.equal(saved.knowledgeValue.constraints.priorCoverage[0].acceptedCoverage, false)
  const operationId = randomUUID(), imported = await prepareQualifiedOriginalImport({ profileRoot: f.receiver.userDataRoot,
    operationId, sourceDirectory: saved.directory, expectedDescriptorHash: saved.descriptorHash })
  const oldParent = await readPreparedMixedOriginalDirectoryBytes(f.handle)
  // Retire every old lookup path; only the independently imported copy is a
  // source for the new child. Renames stay inside these isolated fixture roots.
  for (const [root, path] of [[f.source.userDataRoot, join(f.source.userDataRoot, 'backups')],
    [f.source.userDataRoot, join(f.source.userDataRoot, 'original-input-verification')], [f.receiver.userDataRoot, oldParent.directory]] as const) {
    const local = relative(root, path)
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
    await rename(path, path + '-retired-' + randomUUID())
  }
  await assert.rejects(readCompleteOriginalPackage(f.handle))
  const beforeSource = allTables(f.source.db), beforeReceiver = allTables(f.receiver.db)
  const expectedPath = join(f.receiver.userDataRoot, 'expected-content-' + randomUUID() + '.json')
  await writeFile(expectedPath, JSON.stringify(expected), { flag: 'wx' })
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', resolve('tests/helpers/content3-process.cjs'), JSON.stringify({ profileRoot: f.receiver.userDataRoot,
      operationId, mountId: imported.mountId, expectedDescriptorHash: imported.descriptorHash, expectedPath })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
  const actual = JSON.parse(stdout)
  assert.notEqual(actual.pid, process.pid); assert.equal(actual.nodes, 2); assert.equal(actual.selectionHash, expected.selectionHash)
  assert.deepEqual(allTables(f.source.db), beforeSource); assert.deepEqual(allTables(f.receiver.db), beforeReceiver)
}))
