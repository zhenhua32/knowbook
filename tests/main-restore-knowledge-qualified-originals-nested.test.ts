import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareQualifiedOriginalImport, reopenQualifiedOriginalBundle, readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { withNestedOriginalScenario } from './helpers/qualified-originals-nested-scenario'
import { assertRoot3NestedKnowledge } from './helpers/root3-nested-plan-assertions'

test('qualified originals carry every native and imported C1/C2 domain through independent copying and a fresh process after all earlier sources retire', t => withNestedOriginalScenario(async ({ f, second, stage }) => {
  const importedOperation = randomUUID(), imported = await prepareQualifiedOriginalImport({ profileRoot: f.receiver.userDataRoot,
    operationId: importedOperation, sourceDirectory: second.directory, expectedDescriptorHash: second.descriptorHash })
  assert.equal(imported.scope, 'copied-original-bytes-only'); assert.equal(imported.semanticValidationComplete, false)
  await assert.rejects(readCompleteOriginalPackage(imported as never), /句柄/)
  stage('independent-import')
  const input = { profileRoot: f.receiver.userDataRoot, operationId: importedOperation, mountId: imported.mountId, expectedDescriptorHash: imported.descriptorHash }
  const expectedPath = join(f.receiver.userDataRoot, 'expected-complete-original-' + randomUUID() + '.json')
  await writeFile(expectedPath, JSON.stringify(second.value), { flag: 'wx' })
  const running = promisify(execFile)(process.execPath, ['--import','tsx',resolve('tests/helpers/qualified-originals-process.cjs'),JSON.stringify({ ...input, expectedPath })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
  running.child.stderr?.on('data', bytes => process.stderr.write(bytes))
  const { stdout } = await running
  const reopened = JSON.parse(stdout)
  assert.notEqual(reopened.pid, process.pid); assert.deepEqual(reopened.original, second.value)
  await t.test('complete Root3 planner retains four C1/C2 original domains, repeated originals and every unresolved coverage support after source retirement', async inner => {
    await assertRoot3NestedKnowledge(inner, second, reopened.knowledge)
  })
  stage('independent-process')
  const stored = imported
  const nestedSql = stored.files.find(file => file.frame.length >= 4 && file.path.endsWith('/original/knowbook.db'))!
  assert.ok(nestedSql)
  assert.equal(nestedSql.sourcePath, join(stored.directory, ...referenceContextObjectPath(nestedSql.frame, nestedSql.path).split('/')))
  await writeFile(nestedSql.sourcePath, 'late tampered second-generation original')
  await assert.rejects(reopenQualifiedOriginalBundle(input))
}))
