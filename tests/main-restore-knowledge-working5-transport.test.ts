// Independent mixed flow; original default file120s and child30s stay.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { captureActualFirstRequiredSqlDag, readActualFirstRequiredSqlDagMaterial } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedOriginalPackageWithInitialInputs, readCompleteOriginalContentPair3 } from '../src/main/database/restore-knowledge-qualified-originals'
import { withWorkingTransport5, assertWorkingTransportOperation5, assertWorkingTransportInventory5,
  retireWorkingTransportSource5, assertWorkingTransportContent5, assertWorkingTransportChild5 } from './helpers/working5-transport-fixture'

test('genuine mixed export import and qualified content consumers carry pending automatic archive5 complete working index and byhash originals with an empty base-v2 current after the original profile retires',
  { concurrency: false }, context => withWorkingTransport5(async f => {
    const started=performance.now(),phase=(name:string)=>context.diagnostic(JSON.stringify({phase:name,elapsedMs:Math.round(performance.now()-started)}))
    phase('genuine-pending-source-and-empty-current-ready')
    const { sourceRoot, sourceOperationId, sourceCertificate, currentCertificate, canonicalTransport, managedBytes, originalSqlBytes } = f
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: sourceRoot, operationId: sourceOperationId, dagId: randomUUID(), source: sourceCertificate.source, current: currentCertificate.source })
    phase('actual-dag-captured')
    const dagValue = await readActualFirstRequiredSqlDagMaterial(dag)
    phase('actual-material-reread')
    assert.equal(dagValue.managedOriginalBytes, managedBytes, 'Original bytes include the captured base provenance file even when all settled context files are absent')
    assert.equal(dagValue.originalSqlBytes, originalSqlBytes)
    assert.equal(dagValue.totalOriginalBytes, dagValue.originalSqlBytes + managedBytes)
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: sourceOperationId, bundleId: randomUUID() }), importOperation = randomUUID()
    phase('full-mixed-export-complete')
    const imported = await captureMixedOriginalPackageWithInitialInputs({ profileRoot: canonicalTransport, operationId: importOperation, sourceDirectory: exported.directory })
    phase('full-independent-mixed-import-certified')
    await assertWorkingTransportOperation5(f, importOperation)
    await assertWorkingTransportInventory5(f, imported.originalPackage)
    assert.equal(imported.value.managedOriginalBytes, managedBytes)
    const namespace = imported.value.root.namespace
    assert.equal(namespace.kind, 'imported-bundle')
    if (namespace.kind !== 'imported-bundle') throw new Error('Genuine independent imported mount required')
    const locator = { profileRoot: canonicalTransport, operationId: importOperation, mountId: namespace.mountId, expectedDescriptorHash: exported.descriptorHash }
    await retireWorkingTransportSource5(f)
    phase('origin-profile-retired')
    const content = await readCompleteOriginalContentPair3(imported.bundle)
    phase('fresh-content-reread-complete')
    assertWorkingTransportContent5(f, content)
    await assertWorkingTransportChild5(f, 'mixed', locator)
    phase('independent-sealed-only-child-complete')
  }))
