import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-dag-read'
import { readDurableSqlDagNodeFile } from '../src/main/database/restore-knowledge-dag-files'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareSyncWitnessPair, captureSyncWitnessHead, extractSyncWitnessMaterial, flipSameSizeTail, syncWitnessFailure } from './helpers/sync-witness-fixture'

for (const change of ['ancestor-node', 'manifest', 'index'] as const)
  test('synchronous prepared witness refuses late same-size ' + change + ' bytes and preserves the corrupted evidence', () => withV3Fixture(async f => {
    const pair = await prepareSyncWitnessPair(f), head = await captureSyncWitnessHead(pair, [pair.dag]), material = await extractSyncWitnessMaterial(pair, head)
    const ancestor = await readDurableSqlDagNodeFile(pair.profileRoot, pair.root)
    const path = change === 'ancestor-node' ? ancestor.path : change === 'manifest' ? pair.source.seal.manifestPath
      : join(pair.source.seal.shardsDirectory, pair.source.seal.manifest.evidenceIndex.shards[0].name)
    const { original, bad } = await flipSameSizeTail(path)
    assert.equal(bad.length, original.length)
    assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
    assert.deepEqual(await readFile(path), bad, 'Rejection never rewrites or repairs immutable evidence')
  }))
