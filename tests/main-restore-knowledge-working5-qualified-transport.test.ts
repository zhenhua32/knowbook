// Independent file and fresh genuine fixture; original file120s/child30s stay.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { captureQualifiedOriginalBundle, prepareQualifiedOriginalImport, captureReopenedQualifiedOriginalBundle,
  readCompleteOriginalContentAndWorkingPair5 } from '../src/main/database/restore-knowledge-qualified-originals'
import { withWorkingTransport5, assertWorkingTransportOperation5, assertWorkingTransportFiles5, assertWorkingTransportInventory5,
  retireWorkingTransportSource5, assertWorkingTransportContent5, assertWorkingTransportChild5 } from './helpers/working5-transport-fixture'

test('genuine qualified copy and independent cold readers carry pending automatic archive5 complete working index and byhash originals with an empty base-v2 current after the original profile retires',
  { concurrency: false }, () => withWorkingTransport5(async f => {
    const { sourceRoot, sourceOperationId, sourceCertificate, currentCertificate, canonicalTransport, managedBytes, originalSqlBytes } = f
    const qualified = await captureQualifiedOriginalBundle({ profileRoot: sourceRoot, operationId: sourceOperationId, dagId: randomUUID(), source: sourceCertificate.source, current: currentCertificate.source })
    assert.equal(qualified.value.managedOriginalBytes, managedBytes)
    assert.equal(qualified.value.originalSqlBytes, originalSqlBytes)
    const qualifiedOperation = randomUUID(), qualifiedCopy = await prepareQualifiedOriginalImport({ profileRoot: canonicalTransport, operationId: qualifiedOperation,
      sourceDirectory: qualified.directory, expectedDescriptorHash: qualified.descriptorHash })
    await assertWorkingTransportOperation5(f, qualifiedOperation)
    assert.equal(qualifiedCopy.scope, 'copied-original-bytes-only'); assert.equal(qualifiedCopy.semanticValidationComplete, false)
    await assertWorkingTransportFiles5(f, qualifiedCopy.files)
    const qualifiedLocator = { profileRoot: canonicalTransport, operationId: qualifiedOperation, mountId: qualifiedCopy.mountId, expectedDescriptorHash: qualified.descriptorHash }
    await retireWorkingTransportSource5(f)
    // The copy-only metadata never supplies a content handle. Mint a new real
    // owner from the independently copied originals after the old root is gone.
    const reopened = await captureReopenedQualifiedOriginalBundle(qualifiedLocator)
    const { pair: content, working } = await readCompleteOriginalContentAndWorkingPair5(reopened.bundle)
    await assertWorkingTransportInventory5(f, content.originalPackage)
    assertWorkingTransportContent5(f, content)
    assert.ok(working.source, 'The verified content read also returns its own reconstructed Working5')
    assert.equal(working.source.manifestHash, f.working.manifestHash)
    assert.deepEqual(working.source.records, f.working.records)
    assert.deepEqual(working.source.observation, f.working.observation)
    assert.equal('directory' in working.source || 'files' in working.source, false, 'Verification scratch paths cannot be used as asset originals')
    assert.equal(working.current, undefined, 'The old-format current role cannot borrow source Working5')
    assert.equal('working' in content || 'working' in content.source, false, 'Runtime W never enters the original packet')
    await assertWorkingTransportChild5(f, 'qualified', qualifiedLocator)
  }))
