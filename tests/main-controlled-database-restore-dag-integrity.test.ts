import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readCertifiedDurableSqlDag, reopenCertifiedDurableSqlDag } from '../src/main/database/restore-knowledge-dag-read'
import { readDurableSqlDagNodeFile, writeDurableSqlDagNodeFile } from '../src/main/database/restore-knowledge-dag-files'
import { DURABLE_SQL_DAG_MAX_NODE_BYTES, validateDurableSqlDagNode } from '../src/main/database/restore-knowledge-dag-model'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { capture, compare, immutableBytes, input, node, setupPair } from './helpers/controlled-restore-dag-fixture'

for (const change of ['root-bytes', 'extra-node-file', 'missing-original-db', 'index-bytes'] as const)
  test(`DAG recertification refuses ${change} without repairing the immutable evidence`, () => withV3Fixture(async f => {
    const pair = await setupPair(f), handle = await capture(pair), diagnostic = await readCertifiedDurableSqlDag(handle)
    const root = await readDurableSqlDagNodeFile(pair.profileRoot, diagnostic.root)
    if (change === 'root-bytes') await writeFile(root.path, capsuleJson(root.node) + ' '.repeat(DURABLE_SQL_DAG_MAX_NODE_BYTES + 1))
    else if (change === 'extra-node-file') await writeFile(join(dirname(root.path), 'pending.json'), '{}', { flag: 'wx' })
    else if (change === 'missing-original-db') await rm(join(pair.source.info.originalDirectory, 'knowbook.db'))
    else {
      const file = join(pair.source.seal.shardsDirectory, pair.source.seal.manifest.evidenceIndex.shards[0].name)
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('tampered index')]))
    }
    const before = await immutableBytes(pair)
    await assert.rejects(capture(pair, [handle]), /DAG|原件|manifest|分片|清单|缺失|bytes/, 'An earlier private certificate cannot hide changed original evidence')
    await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, diagnostic.root)), /DAG|原件|manifest|分片|清单|缺失|bytes/)
    await assert.rejects(readCertifiedDurableSqlDag({ kind: 'certified-durable-sql-dag' }), /句柄/)
    assert.deepEqual(await immutableBytes(pair), before)
  }))

test('one physical DAG locator with conflicting expected hashes is refused across independently encoded branches', () => withV3Fixture(async f => {
  const pair = await setupPair(f), ancestor = (await readCertifiedDurableSqlDag(await capture(pair))).root
  const wrong = { ...ancestor, rootHash: (ancestor.rootHash[0] === '0' ? '1' : '0') + ancestor.rootHash.slice(1) }
  const [leftId, rightId] = [randomUUID(), randomUUID()].sort(compare)
  const left = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, leftId, node(pair, [ancestor]))
  const right = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, rightId, node(pair, [wrong]))
  const head = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, randomUUID(), node(pair, [left.ref, right.ref]))
  // File/model output is deliberately untrusted. The real graph reader must
  // discover the mismatch; no fake loader/certified node is injected.
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, head.ref)), /同一DAG locator出现矛盾root hash/)
  const [goodCapsuleBranch, badCapsuleBranch] = [randomUUID(), randomUUID()].sort(compare)
  const badSource = { ...pair.source.ref,
    manifestHash: (pair.source.ref.manifestHash[0] === '0' ? '1' : '0') + pair.source.ref.manifestHash.slice(1) }
  const good = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, goodCapsuleBranch, node(pair))
  const bad = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, badCapsuleBranch,
    validateDurableSqlDagNode({ ...node(pair), source: badSource }))
  const capsuleConflict = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, randomUUID(), node(pair, [good.ref, bad.ref]))
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, capsuleConflict.ref)), /同一原capsule locator出现矛盾manifest hash/)
  assert.equal((await readCertifiedDurableSqlCapsule(pair.source.capsule)).manifestHash, pair.source.ref.manifestHash)
  assert.equal((await readCertifiedDurableSqlCapsule(pair.current.capsule)).manifestHash, pair.current.ref.manifestHash)
}))
