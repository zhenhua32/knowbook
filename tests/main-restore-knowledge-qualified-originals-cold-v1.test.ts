import assert from 'node:assert/strict'
import test from 'node:test'
import { basename, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { captureCertifiedCapsuleNoPriorSourceInputs, captureReopenedCertifiedCapsuleNoPriorSourceInputs } from '../src/main/database/restore-knowledge-capsule-read'
import { readActualNoPriorOriginalInput } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { withQualifiedNestedFixture, captureQualifiedNoPriorSource } from './helpers/qualified-originals-minimal-fixture'
import { allTables } from './helpers/mixed-origin-bundle-fixture'

test('v1 cold paired capture matches the original whole SQL oracle and its genuine later reader rejects changed originals', () => withQualifiedNestedFixture(async f => {
  const saved = await captureQualifiedNoPriorSource(f.source, 1)
  const old = await captureCertifiedCapsuleNoPriorSourceInputs(saved.handle as Parameters<typeof captureCertifiedCapsuleNoPriorSourceInputs>[0])
  const input = { profileRoot: saved.original.info.profileRoot, operationId: basename(saved.original.info.recoveryDirectory),
    capsuleId: basename(saved.original.info.capsuleDirectory), expectedManifestHash: old.seal.manifestHash }
  const actual = await captureReopenedCertifiedCapsuleNoPriorSourceInputs(input), before = allTables(f.source.db)
  assert.deepEqual({ seal: actual.seal, value: actual.value, projection: actual.projection }, old)
  assert.equal(actual.value.requirements.entries.length, 0)
  assert.equal(actual.value.namespaceResolved, false); assert.equal(actual.value.acceptedCoverage, false)
  await writeFile(join(saved.original.info.originalDirectory, 'knowbook.db'), 'late changed actual v1 SQL')
  await assert.rejects(readActualNoPriorOriginalInput(input.profileRoot, actual.source))
  await assert.rejects(captureReopenedCertifiedCapsuleNoPriorSourceInputs(input))
  assert.deepEqual(allTables(f.source.db), before); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
