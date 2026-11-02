import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { assertRestorePath } from '../src/main/database/restore-safety-files'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { captureOriginalReferenceContextWithInitialInputs, readOriginalReferenceContext, reopenOriginalReferenceContext } from '../src/main/database/restore-knowledge-reference-context'
import { withWorking5References } from './helpers/working5-reference-fixture'

test('genuine reference-context copies authenticate archive5 parent base and working index bytes without treating C syntax as accepted coverage',
  { concurrency: false }, () => withWorking5References(async f => {
    const captured = await captureOriginalReferenceContextWithInitialInputs({ source: f.next.source, parents: [f.parent.bundle] })
    const actual = captured.value, descriptor = actual.descriptor
    assert.equal(descriptor.parents.length, 1); assert.equal(descriptor.acceptedCoverage, false); assert.equal(descriptor.effective, false); assert.equal(descriptor.permit, false)
    const parent = descriptor.parents[0], archive = f.f.value.assetArchive
    assert.equal(archive.version, 5); if (archive.version !== 5) throw new Error('Actual captured parent archive5 required')
    assert.equal(parent.managedOriginalBytes, f.parent.value.managedOriginalBytes)
    const logicalAssets = `catalog/backups/database-restore/${f.f.sourceInput.operationId}/knowledge-complete-assets-v2/${f.f.sourceInput.capsuleId}`
    const originals = parent.files.filter(file => !file.frame.length && file.path === logicalAssets + '/base-provenance.json')
    assert.equal(originals.length, 1)
    assert.equal(originals[0].bytes, archive.baseProjection.baseManifestFile.bytes); assert.equal(originals[0].sha256, archive.baseProjection.baseManifestFile.sha256)
    assert.ok(parent.directories.some(dir => !dir.frame.length && dir.path === logicalAssets + '/contexts'))
    const indices=parent.files.filter(file=>!file.frame.length&&file.path===logicalAssets+'/contexts/manifest.json')
    assert.equal(indices.length,1);assert.equal(indices[0].bytes,archive.workingOriginals.manifestFile.bytes);assert.equal(indices[0].sha256,archive.workingOriginals.manifestFile.sha256)
    assert.ok(parent.directories.some(dir=>!dir.frame.length&&dir.path===logicalAssets+'/contexts/files'))
    for(const member of [originals[0],indices[0]]){
      const copied=join(actual.directory,...referenceContextObjectPath([parent.mountId,...member.frame],member.path).split('/'))
      await assertRestorePath(copied,f.profileRoot);const before=await readFile(copied)
      assert.equal(capsuleBytesHash(before),member.sha256);assert.equal(before.length,member.bytes)
      const changed=Buffer.from(before);changed[Math.floor(changed.length/2)]^=1
      try{await writeFile(copied,changed);await assert.rejects(readOriginalReferenceContext(captured.context),'Every actual parent base and working index original is independently authenticated')}
      finally{await writeFile(copied,before)}
    }
    const reopened = await reopenOriginalReferenceContext({ source: f.next.source, contextId: descriptor.contextId, expectedContextHash: actual.contextHash })
    const read = await readOriginalReferenceContext(reopened)
    assert.equal(read.contextHash, actual.contextHash); assert.deepEqual(read.descriptor, descriptor)
  }))
