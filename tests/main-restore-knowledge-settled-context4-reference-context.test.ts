import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { assertRestorePath } from '../src/main/database/restore-safety-files'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { captureOriginalReferenceContextWithInitialInputs, readOriginalReferenceContext, reopenOriginalReferenceContext } from '../src/main/database/restore-knowledge-reference-context'
import { withSettledContext4References } from './helpers/settled-context4-reference-fixture'

test('genuine reference-context copies authenticate archive4 parent base bytes and preserve empty contexts without treating C syntax as accepted coverage',
  { concurrency: false }, () => withSettledContext4References(async f => {
    const captured = await captureOriginalReferenceContextWithInitialInputs({ source: f.next.source, parents: [f.parent.bundle] })
    const actual = captured.value, descriptor = actual.descriptor
    assert.equal(descriptor.parents.length, 1); assert.equal(descriptor.acceptedCoverage, false); assert.equal(descriptor.effective, false); assert.equal(descriptor.permit, false)
    const parent = descriptor.parents[0], archive = f.f.value.assetArchive
    assert.equal(archive.version, 4); if (archive.version !== 4) throw new Error('Actual captured parent archive4 required')
    assert.equal(parent.managedOriginalBytes, f.parent.value.managedOriginalBytes)
    const logicalAssets = `catalog/backups/database-restore/${f.f.sourceInput.operationId}/knowledge-complete-assets-v2/${f.f.sourceInput.capsuleId}`
    const originals = parent.files.filter(file => !file.frame.length && file.path === logicalAssets + '/base-provenance.json')
    assert.equal(originals.length, 1)
    assert.equal(originals[0].bytes, archive.baseProjection.baseManifestFile.bytes); assert.equal(originals[0].sha256, archive.baseProjection.baseManifestFile.sha256)
    assert.ok(parent.directories.some(dir => !dir.frame.length && dir.path === logicalAssets + '/contexts'))
    assert.deepEqual(parent.files.filter(file => !file.frame.length && file.path.startsWith(logicalAssets + '/contexts/')), [])
    const copied = join(actual.directory, ...referenceContextObjectPath([parent.mountId, ...originals[0].frame], originals[0].path).split('/'))
    await assertRestorePath(copied, f.profileRoot)
    const before = await readFile(copied)
    assert.equal(capsuleBytesHash(before), archive.baseProjection.baseManifestFile.sha256)
    const changed = Buffer.from(before); changed[Math.floor(changed.length / 2)] ^= 1
    try {
      await writeFile(copied, changed)
      await assert.rejects(readOriginalReferenceContext(captured.context), 'The actual copied extra base original is authenticated, even for an empty context directory')
    } finally { await writeFile(copied, before) }
    const reopened = await reopenOriginalReferenceContext({ source: f.next.source, contextId: descriptor.contextId, expectedContextHash: actual.contextHash })
    const read = await readOriginalReferenceContext(reopened)
    assert.equal(read.contextHash, actual.contextHash); assert.deepEqual(read.descriptor, descriptor)
  }))
