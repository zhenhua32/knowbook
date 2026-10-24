import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readRawCapsule2OrdinaryPolicySourceOwned, diagnoseRawCapsule2SourcePolicyOwned } from '../src/main/database/restore-knowledge-capsule2-policy-source-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readRawCapsule2AssetReferencesOwned } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { diagnoseCapsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { allTables, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { seedPluginPolicy, pluginPolicyTables } from './helpers/capsule2-plugin-policy-fixture'
import { withCapsule2RawCopy, decodedCapsule2Table } from './helpers/capsule2-raw-fixture'

function seed(f: V3Fixture) {
  const plugin = seedPluginPolicy(f)
  f.store.saveSetting('source.policy.secret', 'actual-private-policy-secret-20261024')
  f.store.recordWorkspaceEvent({ type: 'document.updated', title: '', description: '', createdAt: 'literal retained source time', details: { schemaVersion: 1 } })
  f.store.assistantSessions.createSession({ workspaceId: 'policy-source', title: 'Actual retained assistant', modelConfig: null })
  return plugin
}

test('capsule2 source policy classifies all twenty actual retained families without replaying pending plugins or changing raw roles and byte hashes', () => withV3Fixture(async f => {
  const plugin = seed(f), before = allTables(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const value = readRawCapsule2OrdinaryPolicySourceOwned(db), { policy, sourceContent } = value
    assert.equal(policy.tables.length, 20)
    assert.deepEqual(policy.tables.map(table => table.table).sort(), [...pluginPolicyTables, 'app_settings', 'workspace_events', 'assistant_sessions', 'assistant_events'].sort())
    assert.deepEqual(policy.tables.map(table => table.table).sort(), sourceContent.tables.filter(table => table.role === 'policy-unresolved').map(table => table.name).sort())
    for (const entry of policy.tables) {
      const original = sourceContent.tables.find(table => table.name === entry.table); assert.ok(original)
      assert.equal(entry.rows, original.rows.length)
      assert.equal(entry.originalTableHash, capsuleBytesHash('knowbook.capsule2.source-policy-original-table.v1\0' + capsuleJson(original)))
      assert.equal(entry.executionRule, 'retain-original-only-no-replay')
    }
    assert.equal(policy.tables.filter(table => table.family === 'plugin-retained-storage').length, 16)
    assert.equal(policy.tables.find(table => table.table === 'assistant_sessions')?.assetRule, 'opaque-values-not-paths-or-markdown')
    assert.equal(policy.tables.find(table => table.table === 'assistant_events')?.assetRule, 'host-message-and-retained-stream-markdown')
    assert.equal(policy.sourceContentHash, readRawCapsule2WorkspaceHistoryOwned(db).sourceContentHash)
    assert.equal(diagnoseCapsule2RawContent(sourceContent).policyUnresolvedTables.length, 20, 'The old raw representation and role domain remain unchanged')
    assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(policy.tables), true)
    assert.equal(policy.certified, false); assert.equal(policy.semanticValidationComplete, false); assert.equal(policy.replayAllowed, false)
    assert.equal(policy.executionAllowed, false); assert.equal(policy.grantAuthority, false); assert.equal(policy.permit, false)
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), 0)
  })())
  assert.equal(plugin.repository.getSystemPluginRun(plugin.run.id)?.status, 'starting')
  assert.equal(plugin.repository.getSystemPluginInstallRequest(plugin.request.id)?.status, 'awaiting-confirmation')
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 source policy includes empty retained families without inferring empty synced knowledge or creating rows', () => withV3Fixture(async f => {
  const before = allTables(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const { policy, physical } = readRawCapsule2OrdinaryPolicySourceOwned(db)
    assert.equal(policy.tables.length, 20)
    assert.ok(physical.groups.length > 0)
    assert.ok(policy.tables.filter(table => table.family === 'plugin-retained-storage').every(table => table.rows === 0))
    assert.equal(policy.acceptedCoverage, false); assert.equal(policy.effective, false)
  })())
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 source policy preserves opaque malformed preference and legacy activity bytes while assigning no Markdown or file authority', () => withV3Fixture(async f => {
  f.store.saveSetting('', '{ actual opaque source value')
  f.store.saveSetting('asset-looking', '![opaque](file:///never/read/source.png)')
  f.store.recordWorkspaceEvent({ type: 'document.updated', title: '', description: '', createdAt: 'literal source time' })
  f.db.prepare("UPDATE workspace_events SET details_json='{'").run()
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const { sourceContent, policy } = readRawCapsule2OrdinaryPolicySourceOwned(db)
    const setting = decodedCapsule2Table(sourceContent, 'app_settings').find(row => row.key === ''); assert.ok(setting)
    assert.equal(setting.value, '{ actual opaque source value')
    assert.ok(policy.tables.filter(table => ['app_settings', 'workspace_events'].includes(table.table)).every(table => table.assetRule === 'opaque-values-not-paths-or-markdown'))
    assert.equal(policy.externalPaths, 'original-literals-only-no-follow')
    assert.equal(policy.managedFiles, 'requires-actual-main-managed-originals')
    assert.equal(readRawCapsule2AssetReferencesOwned(db).scopes.some(scope => scope.destinations.some(item => item.uri.includes('/never/read/'))), false)
  })())
}))

test('capsule2 policy summaries exclude source credentials, original payloads, commands and private per-table hashes', () => withV3Fixture(async f => {
  seed(f)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const summary = diagnoseRawCapsule2SourcePolicyOwned(db), text = JSON.stringify(summary)
    assert.equal(summary.tables.length, 20)
    for (const forbidden of ['actual-private-policy-secret-20261024', 'source-policy-v2', 'not-executed.exe', 'originalTableHash', 'value_json'])
      assert.equal(text.includes(forbidden), false)
    assert.equal('sourceContent' in summary, false)
    assert.equal(summary.permit, false); assert.equal(summary.grantAuthority, false)
  })())
}))

test('capsule2 policy source hashes bind original opaque SQL bytes rather than normalizing equivalent JSON', () => withV3Fixture(async f => {
  f.store.saveSetting('actual.policy.bytes', '{"a":1}')
  let first: { source: string; table: string; policy: string } | undefined
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const { policy } = readRawCapsule2OrdinaryPolicySourceOwned(db)
    first = { source: policy.sourceContentHash, table: policy.tables.find(table => table.table === 'app_settings')!.originalTableHash, policy: policy.observationHash }
  })())
  f.db.prepare("UPDATE app_settings SET value='{ \"a\" : 1 }' WHERE key='actual.policy.bytes'").run()
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const { policy } = readRawCapsule2OrdinaryPolicySourceOwned(db); assert.ok(first)
    assert.notEqual(policy.sourceContentHash, first.source)
    assert.notEqual(policy.tables.find(table => table.table === 'app_settings')!.originalTableHash, first.table)
    assert.notEqual(policy.observationHash, first.policy)
  })())
}))

const corruptions: Array<[string, (f: V3Fixture) => void]> = [
  ['plugin policy', f => { seedPluginPolicy(f); f.db.prepare('UPDATE plugin_state SET schema_version=2.5').run() }],
  ['preference storage', f => { f.store.saveSetting('bad', 'literal'); f.db.prepare("UPDATE app_settings SET value=CAST(value AS BLOB) WHERE key='bad'").run() }],
  ['assistant event JSON', f => { f.store.assistantSessions.createSession({ workspaceId: 'policy-corrupt', title: 'Actual source', modelConfig: null }); f.db.prepare("UPDATE assistant_events SET payload_json='{' ").run() }]
]
for (const [name, corrupt] of corruptions) test('capsule2 source policy preserves existing rejection of actual corrupt ' + name + ' without repairing source', () => withV3Fixture(async f => {
  corrupt(f); const before = allTables(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    assert.throws(() => readRawCapsule2OrdinaryPolicySourceOwned(db))
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), 0)
  })())
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 retained-policy classification cannot launder unknown reserved sync metadata through the real workspace or asset consumer', () => withV3Fixture(async f => {
  f.store.saveSetting('synced.unknown-source-policy-family', '{}')
  const before = allTables(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const { policy } = readRawCapsule2OrdinaryPolicySourceOwned(db)
    assert.equal(policy.reservedMetadata, 'requires-observer2-total2-and-prior-root-interpretation')
    assert.equal(policy.acceptedCoverage, false); assert.equal(policy.permit, false)
    assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /未知|unknown|namespace|reserved/i)
    assert.throws(() => readRawCapsule2AssetReferencesOwned(db), /未知|unknown|namespace|reserved/i)
  })())
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 policy source requires the actual readonly query-only FK-owned transaction', () => withV3Fixture(async f => {
  assert.throws(() => readRawCapsule2OrdinaryPolicySourceOwned(f.db), /readonly|只读|事务|query/i)
  f.db.transaction(() => assert.throws(() => readRawCapsule2OrdinaryPolicySourceOwned(f.db), /readonly|只读|事务|query/i))()
  await withCapsule2RawCopy(f, db => assert.throws(() => readRawCapsule2OrdinaryPolicySourceOwned(db), /readonly|只读|事务|query/i))
}))

test('capsule2 source policy rejects an unknown SQL table instead of classifying its contents as empty or executable policy', () => withV3Fixture(async f => {
  f.db.exec("CREATE TABLE unknown_source_policy(id TEXT PRIMARY KEY, payload TEXT); INSERT INTO unknown_source_policy VALUES('actual','retained bytes')")
  const before = allTables(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => assert.throws(() => readRawCapsule2OrdinaryPolicySourceOwned(db), /未知.*family|未知数据表/))())
  assert.deepEqual(allTables(f.db), before)
}))
