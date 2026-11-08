import assert from 'node:assert/strict'
import test from 'node:test'
import { withSettledWorkingSource5 } from './helpers/working5-automatic-source-fixture'
import { prepareWorking5AssetAuthorityFixture } from './helpers/working5-asset-authority-fixture'
import { readRootRestoreWorkingAssetBlob5 } from '../src/main/database/restore-knowledge-working-asset-authority5'

test('settled Working5 keeps job and receipt coordinates separate and both bind actual base original alias bytes after spool retirement',
  { concurrency: false }, () => withSettledWorkingSource5(async f => {
    const { authority, value } = await prepareWorking5AssetAuthorityFixture(f)
    const occurrences = value.roles[0].occurrences.filter(item => item.destination.uri === f.portable && item.destination.kind === 'definition')
    assert.equal(occurrences.length, 2)
    const [job, receipt] = [occurrences.find(item => item.scopeSource.includes('app_settings')),
      occurrences.find(item => item.scopeSource.includes('synced_operations'))]
    if (job?.status !== 'sealed-blob' || receipt?.status !== 'sealed-blob'
      || job.evidence.kind !== 'settled-captured-base-alias' || receipt.evidence.kind !== 'settled-captured-base-alias')
      throw new Error('Both independent original holders must retain their own settled evidence')
    assert.notEqual(job.id, receipt.id)
    assert.deepEqual(job.file, receipt.file)
    assert.match(job.file.path, new RegExp('/' + f.sourceInput.capsuleId + '/files/' + f.digest + '$'))
    for (const witness of job.evidence.witnesses) {
      assert.equal(f.working.baseCommitment.referenceUris[witness.baseReferenceIndex], witness.sourceUri)
      assert.equal(f.working.baseCommitment.tree.aliases[witness.aliasIndex].name, witness.physicalName)
      assert.equal(f.working.baseCommitment.tree.aliases[witness.aliasIndex].hash, f.digest)
    }
    const selected = await readRootRestoreWorkingAssetBlob5(authority, receipt.id)
    assert.equal(selected.status, 'original-blob')
    if (selected.status === 'original-blob') assert.deepEqual(selected.bytes, f.bytes)
  }))
