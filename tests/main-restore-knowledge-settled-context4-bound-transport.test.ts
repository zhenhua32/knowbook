import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { captureQualifiedOriginalBundleFromReferences, prepareQualifiedOriginalImport, captureReopenedQualifiedOriginalBundle,
  readCompleteOriginalContentPair3 } from '../src/main/database/restore-knowledge-qualified-originals'
import { withSettledContext4References, assertReferenceBaseFiles4 } from './helpers/settled-context4-reference-fixture'

test('real bound C input copies preserve archive4 base originals and empty contexts through both root and referenced parent domains',
  { concurrency: false }, () => withSettledContext4References(async f => {
    const captured = await captureQualifiedOriginalBundleFromReferences({ profileRoot: f.profileRoot, operationId: f.next.sourceInput.operationId,
      dagId: randomUUID(), source: f.next.source, parents: [f.parent.bundle], current: f.currentCertificate.source })
    assert.equal(captured.value.inputs[0].origin.kind, 'bound-original-bundle')
    assert.equal(captured.value.node.parents.length, 1); assert.equal(captured.contextData.descriptor.parents.length, 1)
    assert.equal(captured.contextData.descriptor.parents[0].managedOriginalBytes, f.parent.value.managedOriginalBytes)
    await assertReferenceBaseFiles4(f, captured.originalPackage)
    const receiver = join(await realpath(f.f.saved.f.folder), 'genuine-bound-context4-receiver')
    await mkdir(receiver); const profileRoot = await realpath(receiver), operationId = randomUUID()
    const copy = await prepareQualifiedOriginalImport({ profileRoot, operationId, sourceDirectory: captured.directory, expectedDescriptorHash: captured.descriptorHash })
    assert.equal(copy.scope, 'copied-original-bytes-only'); assert.equal(copy.semanticValidationComplete, false)
    const reopened = await captureReopenedQualifiedOriginalBundle({ profileRoot, operationId, mountId: copy.mountId, expectedDescriptorHash: captured.descriptorHash })
    const content = await readCompleteOriginalContentPair3(reopened.bundle)
    await assertReferenceBaseFiles4(f, content.originalPackage)
    assert.equal(content.source.materialHash, f.next.value.materialHash); assert.equal(content.source.assetArchiveHash, f.next.value.assetArchiveHash)
    assert.equal(content.current.materialHash, f.current.value.materialHash)
    assert.equal(reopened.value.acceptedCoverage, false); assert.equal(reopened.value.effective, false); assert.equal(reopened.value.permit, false)
  }))
