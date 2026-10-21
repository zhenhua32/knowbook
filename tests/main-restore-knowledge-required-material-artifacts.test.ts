import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractRequiredRootKnowledgeMaterial, assertRequiredRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'

for (const artifact of ['required-v2-node', 'real-capsule-index'] as const)
  test('required-v2 synchronous witness rereads late actual ' + artifact + ' bytes and preserves bad evidence', () => withV3Fixture(async f => {
    const pair = await actualRequiredDagPair(f), material = await extractRequiredRootKnowledgeMaterial(pair.dag)
    const file = artifact === 'required-v2-node' ? pair.file : join(pair.source.seal.shardsDirectory, pair.source.seal.manifest.evidenceIndex.shards[0].name)
    assert.equal(assertRequiredRootKnowledgeArtifactsFreshNow(material), undefined)
    const original = await readFile(file), bad = Buffer.from(original); bad[bad.length - 1] ^= 1
    await writeFile(file, bad)
    assert.throws(() => assertRequiredRootKnowledgeArtifactsFreshNow(material), /同步v2|同步witness|node|capsule|bytes|artifact/)
    assert.deepEqual(await readFile(file), bad)
  }))
