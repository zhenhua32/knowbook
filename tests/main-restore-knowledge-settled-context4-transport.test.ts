// Independent mixed flow; original default file120s and child30s stay.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { captureActualFirstRequiredSqlDag, readActualFirstRequiredSqlDagMaterial } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedOriginalPackageWithInitialInputs, readCompleteOriginalContentPair3 } from '../src/main/database/restore-knowledge-qualified-originals'
import { withContextTransport4, assertContextTransportOperation4, assertContextTransportInventory4,
  retireContextTransportSource4, assertContextTransportContent4, assertContextTransportChild4 } from './helpers/settled-context4-transport-fixture'

test('genuine mixed export import and qualified content consumers carry settled archive4 base-proof originals and empty contexts with an empty base-v2 current after the original profile retires',
  { concurrency: false }, () => withContextTransport4(async f => {
    const { sourceRoot, sourceOperationId, sourceCertificate, currentCertificate, canonicalTransport, managedBytes, originalSqlBytes } = f
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: sourceRoot, operationId: sourceOperationId, dagId: randomUUID(), source: sourceCertificate.source, current: currentCertificate.source })
    const dagValue = await readActualFirstRequiredSqlDagMaterial(dag)
    assert.equal(dagValue.managedOriginalBytes, managedBytes, 'Original bytes include the captured base provenance file even when all settled context files are absent')
    assert.equal(dagValue.originalSqlBytes, originalSqlBytes)
    assert.equal(dagValue.totalOriginalBytes, dagValue.originalSqlBytes + managedBytes)
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: sourceOperationId, bundleId: randomUUID() }), importOperation = randomUUID()
    const imported = await captureMixedOriginalPackageWithInitialInputs({ profileRoot: canonicalTransport, operationId: importOperation, sourceDirectory: exported.directory })
    await assertContextTransportOperation4(f, importOperation)
    await assertContextTransportInventory4(f, imported.originalPackage)
    assert.equal(imported.value.managedOriginalBytes, managedBytes)
    const namespace = imported.value.root.namespace
    assert.equal(namespace.kind, 'imported-bundle')
    if (namespace.kind !== 'imported-bundle') throw new Error('Genuine independent imported mount required')
    const locator = { profileRoot: canonicalTransport, operationId: importOperation, mountId: namespace.mountId, expectedDescriptorHash: exported.descriptorHash }
    await retireContextTransportSource4(f)
    const content = await readCompleteOriginalContentPair3(imported.bundle)
    assertContextTransportContent4(f, content)
    await assertContextTransportChild4(f, 'mixed', locator)
  }))
