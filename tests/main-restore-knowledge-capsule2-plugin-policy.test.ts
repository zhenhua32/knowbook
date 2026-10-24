import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2AssetReferencesOwned } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { pluginPolicyTables, seedPluginPolicy } from './helpers/capsule2-plugin-policy-fixture'
import { assertRawCapsule2PluginPolicyOwned } from '../src/main/database/restore-knowledge-capsule2-plugin-policy-read'

const rows = (db: Database.Database) => pluginPolicyTables.map(table => ({ table, rows: db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() }))
async function observe(f: V3Fixture, reject = false) {
  const original = rows(f.db)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const raw = readRawCapsule2ContentOwned(db)
    if (reject) assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /plugin|插件|原字段|INTEGER|TEXT|来源/)
    else {
      const value = readRawCapsule2WorkspaceHistoryOwned(db)
      assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    }
    assert.deepEqual(readRawCapsule2ContentOwned(db), raw)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(rows(f.db), original)
}

test('capsule2 plugin policy retains all sixteen real repository families including revoked grants, migrated snapshots and pending system work without recovery', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f)
  assert.equal(actual.repository.getGrantSet(actual.firstGrant.id), null)
  assert.equal(actual.repository.getSystemPluginInstallRequest(actual.request.id)?.status, 'awaiting-confirmation')
  assert.equal(actual.repository.getSystemPluginRun(actual.run.id)?.status, 'starting')
  assert.equal(actual.repository.getSystemPluginOsPersistenceByPlugin('source-policy-v3')?.status, 'awaiting-confirmation')
  await observe(f)
  assert.equal(actual.repository.getSystemPluginRun(actual.run.id)?.status, 'starting')
  assert.ok(actual.repository.findStateSnapshotForRevision(actual.installation.id, actual.first.revisionId))
}))

for (const table of pluginPolicyTables) test('capsule2 plugin policy refuses a non-TEXT original in ' + table + ' without repairing data', () => withV3Fixture(async f => {
  seedPluginPolicy(f)
  const column = table === 'plugin_state' ? 'scope_key' : table === 'plugin_state_snapshots' ? 'state_json' : table === 'plugin_definitions' ? 'name'
    : table === 'plugin_revisions' ? 'manifest_json' : table === 'plugin_installations' ? 'scope_kind' : table === 'plugin_grants' ? 'grants_json'
      : table === 'plugin_runs' ? 'status' : table === 'plugin_logs' ? 'message' : table === 'system_plugin_install_requests' ? 'reason'
        : table === 'system_plugin_packages' ? 'artifact_path' : table === 'system_plugin_installations' ? 'status' : table === 'system_plugin_runs' ? 'component'
          : table === 'system_plugin_audit' ? 'action' : table === 'system_plugin_dependency_jobs' ? 'kind' : table === 'system_plugin_crash_markers' ? 'phase' : 'service_id'
  f.db.prepare('UPDATE ' + table + ' SET ' + column + '=CAST(' + column + ' AS BLOB)').run()
  await observe(f, true)
}))

const unreadable: Array<[string, string, unknown]> = [
  ['plugin_revisions', 'manifest_json', '{'], ['plugin_grants', 'grants_json', '{'], ['plugin_installations', 'enabled', 2],
  ['plugin_state', 'value_json', '{'], ['plugin_state_snapshots', 'state_json', '[]'], ['plugin_logs', 'data_json', '{'],
  ['system_plugin_install_requests', 'restart_required', 0], ['system_plugin_packages', 'status', 'unknown-status'],
  ['system_plugin_installations', 'enabled', 2], ['system_plugin_runs', 'component', 'unknown-component'],
  ['system_plugin_audit', 'actor', 'unknown-actor'], ['system_plugin_dependency_jobs', 'command_json', '[]'],
  ['system_plugin_crash_markers', 'state', 'unknown-state'], ['system_plugin_os_persistence', 'command_json', '[]'],
  ['plugin_state', 'schema_version', 2.5], ['system_plugin_audit', 'id', null]
]
for (const [table, column, value] of unreadable) test(`capsule2 plugin policy refuses an unreadable stored ${table}.${column} across the complete family`, () => withV3Fixture(async f => {
  seedPluginPolicy(f); f.db.prepare('UPDATE ' + table + ' SET ' + column + '=?').run(value); await observe(f, true)
}))

test('capsule2 plugin policy scans genuine retained logs beyond the public1000-page limit instead of accepting only the displayed prefix', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f)
  for (let i = 0; i < 1001; i++) actual.repository.appendPluginLog({ id: 'source-tail-' + i, pluginId: actual.pluginId, level: 'info', event: 'source.tail', message: 'Actual retained log' })
  const displayed = new Set(actual.repository.listPluginLogs(actual.pluginId, 1000).map(row => row.id))
  assert.equal(displayed.size, 1000)
  const retained = (f.db.prepare('SELECT id FROM plugin_logs WHERE plugin_id=? ORDER BY rowid').all(actual.pluginId) as Array<{ id: string }>).find(row => !displayed.has(row.id))
  assert.ok(retained, 'The actual Main page excludes an original retained log')
  await observe(f)
  f.db.prepare("UPDATE plugin_logs SET data_json='{' WHERE id=?").run(retained.id)
  assert.equal(actual.repository.listPluginLogs(actual.pluginId, 1000).length, 1000, 'The original public page remains readable and cannot detect the hidden retained fault')
  await observe(f, true)
}))

test('capsule2 plugin policy never treats persisted commands, manifests, state or audit JSON as Markdown asset holders', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f), uri = 'file:///never/plugin-policy-asset.png', literal = `![opaque](<${uri}>)`
  actual.repository.writePluginState(actual.pluginId, actual.scope, 'asset-looking', { literal })
  actual.repository.appendPluginLog({ id: 'source-opaque-log', pluginId: actual.pluginId, level: 'info', event: 'source.opaque', message: literal, data: { literal } })
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const value = readRawCapsule2AssetReferencesOwned(db)
    assert.equal(value.scopes.some(scope => scope.destinations.some(destination => destination.uri === uri)), false)
  })())
}))

test('capsule2 plugin policy validates a revoked grant hidden by the live active-only getter instead of reviving or omitting it', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f)
  assert.equal(actual.repository.getGrantSet(actual.firstGrant.id), null)
  f.db.prepare("UPDATE plugin_grants SET grants_json='{' WHERE id=?").run(actual.firstGrant.id)
  assert.equal(actual.repository.getGrantSet(actual.firstGrant.id), null)
  await observe(f, true)
}))

test('capsule2 plugin policy preserves stored duplicate/opaque JSON with the existing Main decoder meaning and original bytes', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f), raw = '{ "value":1,"value":2,"__proto__":{"literal":true} }'
  f.db.prepare('UPDATE plugin_state SET value_json=? WHERE plugin_id=?').run(raw, actual.pluginId)
  const value = actual.repository.readPluginState(actual.pluginId, actual.scope, 'state')?.value as Record<string, unknown>
  assert.equal(value.value, 2); assert.equal(Object.hasOwn(value, '__proto__'), true)
  await observe(f)
  assert.equal((f.db.prepare('SELECT value_json FROM plugin_state WHERE plugin_id=?').get(actual.pluginId) as { value_json: string }).value_json, raw)
  assert.equal(Object.hasOwn(Object.prototype, 'literal'), false)
}))

test('capsule2 plugin policy preserves deeply nested stored state accepted by the actual Main reader without an authored depth filter', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f), depth = 5000, raw = '['.repeat(depth) + '0' + ']'.repeat(depth)
  f.db.prepare('UPDATE plugin_state SET value_json=? WHERE plugin_id=?').run(raw, actual.pluginId)
  let value: unknown = actual.repository.readPluginState(actual.pluginId, actual.scope, 'state')?.value
  for (let i = 0; i < depth; i++) { assert.ok(Array.isArray(value)); value = value[0] }
  assert.equal(value, 0); await observe(f)
}))

test('capsule2 plugin policy preserves cross-plugin historical log references actually accepted by the Main metadata writer', () => withV3Fixture(async f => {
  const actual = seedPluginPolicy(f), other = 'source-other-historical-log'
  actual.repository.createDefinition({ id: other, name: 'Actual other log owner', source: 'legacy', persistenceScope: 'workspace' })
  actual.repository.appendPluginLog({ id: 'source-cross-log', pluginId: other, revisionId: actual.first.revisionId, runId: 'source-v2-first-run',
    level: 'info', event: 'source.historical', message: 'Actual API allows metadata references across plugins' })
  assert.equal(actual.repository.listPluginLogs(other)[0].revisionId, actual.first.revisionId)
  await observe(f)
}))

test('capsule2 plugin policy checks declared support independently of a source connection previously allowing an orphan reference', () => withV3Fixture(async f => {
  seedPluginPolicy(f)
  f.db.pragma('foreign_keys=OFF')
  f.db.prepare("UPDATE plugin_logs SET revision_id=? WHERE id='source-v2-log'").run('sha256:' + 'f'.repeat(64))
  f.db.pragma('foreign_keys=ON')
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => db.transaction(() => assertRawCapsule2PluginPolicyOwned(db))(), /外键缺完整支持行/)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })
}))

test('capsule2 plugin policy enforces the actual readonly query-only FK transaction boundary', () => withV3Fixture(async f => {
  seedPluginPolicy(f)
  assert.throws(() => f.db.transaction(() => assertRawCapsule2PluginPolicyOwned(f.db))(), /readonly/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => assertRawCapsule2PluginPolicyOwned(db), /来源事务/)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2PluginPolicyOwned(db))(), /query-only/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2PluginPolicyOwned(db))(), /FKON/)
    db.pragma('foreign_keys=ON')
    db.transaction(() => assertRawCapsule2PluginPolicyOwned(db))()
  })
}))

test('capsule2 plugin policy refuses an exact unsafe SQLite INTEGER without Number rounding the retained epoch', () => withV3Fixture(async f => {
  seedPluginPolicy(f)
  f.db.prepare('UPDATE plugin_runs SET epoch=9223372036854775807').run()
  await observe(f, true)
}))
