import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { reopenCertifiedDurableSqlDag } from '../src/main/database/restore-knowledge-dag-read'
import { writeDurableSqlDagNodeFile } from '../src/main/database/restore-knowledge-dag-files'
import { DURABLE_SQL_DAG_MAX_DEPTH, durableSqlDagRootHash,
  type DurableSqlDagNode, type DurableSqlDagReference } from '../src/main/database/restore-knowledge-dag-model'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { immutableBytes, input, node, setupPair } from './helpers/controlled-restore-dag-fixture'

test('a real on-disk DAG chain beyond the full depth budget is refused without truncating ancestors', () => withV3Fixture(async f => {
  const started = performance.now()
  const mark = (phase: string) => console.error(`[dag-depth-fixture] ${JSON.stringify({ phase, elapsedMs: performance.now() - started })}`)
  const pair = await setupPair(f)
  mark('pair-ready')
  const first = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, randomUUID(), node(pair))
  let head = first.ref
  const pending: Array<{ dagId: string; value: DurableSqlDagNode; ref: DurableSqlDagReference }> = []
  for (let depth = 1; depth <= DURABLE_SQL_DAG_MAX_DEPTH; depth++) {
    const dagId = randomUUID(), value = node(pair, [head])
    const ref: DurableSqlDagReference = { kind: 'durable-sql-dag-ref', version: 1,
      operationId: pair.operationId, dagId, rootHash: durableSqlDagRootHash(value) }
    pending.push({ dagId, value, ref }); head = ref
  }
  // Raw refs are untrusted model data. Distinct node writes do not read their
  // parents, so the full chain can be planned before bounded independent I/O.
  // Every original still uses the exact writer's identity/fsync/readback checks.
  for (let offset = 0; offset < pending.length; offset += 4) {
    const batch = pending.slice(offset, offset + 4)
    const written = await Promise.allSettled(batch.map(entry =>
      writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, entry.dagId, entry.value)))
    const failures = written.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'All independent DAG node writes must finish before fixture cleanup')
    for (let index = 0; index < written.length; index++) {
      const result = written[index]
      assert.equal(result.status, 'fulfilled')
      assert.deepEqual(result.value.ref, batch[index].ref, 'Each planned reference is checked against its actual durable original')
    }
  }
  assert.equal(pending.length + 1, DURABLE_SQL_DAG_MAX_DEPTH + 1)
  mark('all-original-nodes-written')
  const before = await immutableBytes(pair)
  mark('original-bytes-recorded')
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, head)), /节点\/深度超预算|最长DAG路径超预算/)
  mark('depth-refusal-verified')
  assert.deepEqual(await immutableBytes(pair), before)
  mark('all-original-bytes-unchanged')
}))
