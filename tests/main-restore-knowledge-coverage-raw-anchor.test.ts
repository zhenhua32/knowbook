import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { COVERAGE_ANCHOR_CHANNEL, coverageOperationId } from '../src/main/database/restore-knowledge-coverage-model'
import { assertSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { readSyncedGroupLifecycles } from '../src/main/database/synced-lifecycle-state'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'
import { withPayloadStore } from './helpers/restore-knowledge-payload-fixture'
import { structureFixture } from './helpers/coverage-structure-fixture'
import { insertCoverageSyntax, ordinaryExposure, readCoverage } from './helpers/coverage-raw-sql-fixture'

test('coverage raw SQL preserves original UUID nonzero-member open TEXT channels, including the new fixed channel name', async () => withV3Fixture(f => {
  for (const channel of [COVERAGE_ANCHOR_CHANNEL, 'recovery-knowledge-coverage-v99', 'ordinary future channel 🧩']) {
    ordinaryExposure(f.db, f.groupId, channel)
    const original = f.db.transaction(() => readSyncedGroupLifecycles(f.db, [f.groupId]))().get(f.groupId)
    assert.equal(original?.exposure, 'possible', 'The existing raw validator accepts the actual UUID/member/open-channel fact')
    assert.doesNotThrow(() => assertSyncedLifecycleSchema(f.db), 'Original full lifecycle admission also keeps its open ordinary channel contract')
    const before = allTables(f.db)
    assert.deepEqual(readCoverage(f.db).entries, [], 'Ordinary member exposure is not a C requirement or accepted restore fact')
    assert.deepEqual(allTables(f.db), before)
  }
}))

test('coverage raw SQL never lets a reserved coverage ID with real members use the ordinary channel exception', async () => withV3Fixture(f => {
  const fixture = structureFixture()
  insertCoverageSyntax(f.db, fixture, { omit: 'anchor' })
  ordinaryExposure(f.db, f.groupId, 'recovery-knowledge-coverage-v99', coverageOperationId(fixture.coverage.operationId))
  const before = allTables(f.db)
  assert.throws(() => readCoverage(f.db), /member/)
  assert.deepEqual(allTables(f.db), before)
}))

test('coverage raw SQL rejects memberful coverage anchors even with exact v1 channel and an otherwise complete tuple', async () => withV3Fixture(f => {
  const fixture = structureFixture()
  insertCoverageSyntax(f.db, fixture, { omit: 'anchor' })
  ordinaryExposure(f.db, f.groupId, COVERAGE_ANCHOR_CHANNEL, coverageOperationId(fixture.coverage.operationId))
  assert.throws(() => readCoverage(f.db), /member/)
}))

test('coverage raw SQL refuses zero-member UUID channel-only orphans for both fixed and future coverage channels', async () => {
  for (const channel of [COVERAGE_ANCHOR_CHANNEL, 'recovery-knowledge-coverage-v99']) await withPayloadStore(async f => {
    insertCoverageSyntax(f.db, structureFixture(), { omit: 'coverage', anchor: { id: randomUUID(), channel } })
    assert.throws(() => readCoverage(f.db), /零成员|无C id/)
  })
})

test('coverage raw SQL rejects reserved ID unknown versions and wrong channels before treating them as ordinary facts', async () => {
  for (const anchor of [{ id: 'synced:restore-knowledge-coverage:v9:' + randomUUID() }, { channel: 'ordinary-open-channel' }])
    await withPayloadStore(async f => {
      insertCoverageSyntax(f.db, structureFixture(), { anchor })
      assert.throws(() => readCoverage(f.db), /未知coverage anchor/)
    })
})

test('coverage raw SQL refuses wrong immutable anchor hashes without repairing evidence and old full admission still rejects the new family', () => withPayloadStore(async f => {
  insertCoverageSyntax(f.db, structureFixture(), { anchor: { target_fingerprint: 'f'.repeat(64) } })
  const before = allTables(f.db)
  assert.throws(() => readCoverage(f.db), /真实零成员anchor/)
  assert.throws(() => assertSyncedLifecycleSchema(f.db), /曝光|anchor|publication|观察|零成员|非法|未知/i)
  assert.deepEqual(allTables(f.db), before)
}))
