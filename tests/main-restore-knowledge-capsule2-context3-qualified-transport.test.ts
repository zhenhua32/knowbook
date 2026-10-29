// Independent file and fresh genuine fixture; original file120s/child30s stay.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { captureQualifiedOriginalBundle, prepareQualifiedOriginalImport, captureReopenedQualifiedOriginalBundle,
  readCompleteOriginalContentPair3 } from '../src/main/database/restore-knowledge-qualified-originals'
import { withContextTransport3, assertContextTransportOperation3, assertContextTransportFiles3, assertContextTransportInventory3,
  retireContextTransportSource3, assertContextTransportContent3, assertContextTransportChild3 } from './helpers/capsule2-context3-transport-fixture'

test('genuine qualified copy and independent cold readers carry source archive3 contexts with an empty base-v2 current after the original profile retires',
  { concurrency: false }, () => withContextTransport3(async f => {
    const { sourceRoot, sourceOperationId, sourceCertificate, currentCertificate, canonicalTransport, managedBytes, originalSqlBytes } = f
    const qualified = await captureQualifiedOriginalBundle({ profileRoot: sourceRoot, operationId: sourceOperationId, dagId: randomUUID(), source: sourceCertificate.source, current: currentCertificate.source })
    assert.equal(qualified.value.managedOriginalBytes, managedBytes)
    assert.equal(qualified.value.originalSqlBytes, originalSqlBytes)
    const qualifiedOperation = randomUUID(), qualifiedCopy = await prepareQualifiedOriginalImport({ profileRoot: canonicalTransport, operationId: qualifiedOperation,
      sourceDirectory: qualified.directory, expectedDescriptorHash: qualified.descriptorHash })
    await assertContextTransportOperation3(f, qualifiedOperation)
    assert.equal(qualifiedCopy.scope, 'copied-original-bytes-only'); assert.equal(qualifiedCopy.semanticValidationComplete, false)
    await assertContextTransportFiles3(f, qualifiedCopy.files)
    const qualifiedLocator = { profileRoot: canonicalTransport, operationId: qualifiedOperation, mountId: qualifiedCopy.mountId, expectedDescriptorHash: qualified.descriptorHash }
    await retireContextTransportSource3(f)
    // The copy-only metadata never supplies a content handle. Mint a new real
    // owner from the independently copied originals after the old root is gone.
    const reopened = await captureReopenedQualifiedOriginalBundle(qualifiedLocator)
    const content = await readCompleteOriginalContentPair3(reopened.bundle)
    await assertContextTransportInventory3(f, content.originalPackage)
    assertContextTransportContent3(f, content)
    await assertContextTransportChild3(f, 'qualified', qualifiedLocator)
  }))
