import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { assistantTurnId } from '../src/shared/assistant-session'

function seed(f: V3Fixture) {
  const repository = f.store.assistantSessions, session = repository.createSession({ workspaceId: 'stored-json-workspace', title: 'Stored JSON source', modelConfig: { model: 'actual' } })
  const turnId = assistantTurnId('stored-json-turn')
  repository.append(session.id, { type: 'turn.started', payload: { turnId } })
  repository.append(session.id, { type: 'user.message', payload: { turnId, text: 'Actual source message' } })
  return { repository, session }
}
function storedConfig(f: V3Fixture, sessionId: string, sessionConfig: string, initialConfig = sessionConfig) {
  const original = f.db.prepare('SELECT payload_json FROM assistant_events WHERE session_id=? AND seq=1').get(sessionId) as { payload_json: string }
  const first = JSON.parse(original.payload_json) as { title: string; workspaceId: string; activeDocumentId: string | null }
  const prefix = JSON.stringify({ title: first.title, workspaceId: first.workspaceId, activeDocumentId: first.activeDocumentId }).slice(0, -1)
  f.db.prepare('UPDATE assistant_sessions SET model_config_json=? WHERE id=?').run(sessionConfig, sessionId)
  f.db.prepare('UPDATE assistant_events SET payload_json=? WHERE session_id=? AND seq=1').run(prefix + ',"modelConfig":' + initialConfig + '}', sessionId)
}
async function observe(f: V3Fixture) {
  const original = f.db.prepare('SELECT payload_json FROM assistant_events ORDER BY session_id,seq').all()
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const raw = readRawCapsule2ContentOwned(db), value = readRawCapsule2WorkspaceHistoryOwned(db)
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    assert.deepEqual(readRawCapsule2ContentOwned(db), raw)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(f.db.prepare('SELECT payload_json FROM assistant_events ORDER BY session_id,seq').all(), original)
}

test('capsule2 assistant source preserves duplicate event JSON keys with the actual stored Main reader last-value meaning', () => withV3Fixture(async f => {
  const actual = seed(f), raw = '{ "turnId":"stored-json-turn", "text":"discarded", "text":"actual stored last value" }'
  f.db.prepare("UPDATE assistant_events SET payload_json=? WHERE session_id=? AND type='user.message'").run(raw, actual.session.id)
  const event = actual.repository.listEvents(actual.session.id).find(row => row.type === 'user.message')
  assert.ok(event?.type === 'user.message'); assert.equal(event.payload.text, 'actual stored last value')
  await observe(f)
  assert.equal((f.db.prepare("SELECT payload_json FROM assistant_events WHERE session_id=? AND type='user.message'").get(actual.session.id) as { payload_json: string }).payload_json, raw)
}))

test('capsule2 assistant source compares stored duplicate-key model config by decoded value without rewriting either original JSON spelling', () => withV3Fixture(async f => {
  const actual = seed(f), raw = ' { "b":2, "a":1, "a":3 } '
  storedConfig(f, actual.session.id, raw, '{"a":3,"b":2}')
  assert.deepEqual(actual.repository.getSession(actual.session.id)?.modelConfig, { b: 2, a: 3 })
  await observe(f)
  assert.equal((f.db.prepare('SELECT model_config_json FROM assistant_sessions WHERE id=?').get(actual.session.id) as { model_config_json: string }).model_config_json, raw)
}))

test('capsule2 assistant source preserves opaque stored config key names accepted by the existing Main decoder without prototype mutation', () => withV3Fixture(async f => {
  const actual = seed(f), raw = '{"__proto__":{"storedLiteral":true},"constructor":{"prototype":"literal"},"password":"historical opaque value"}'
  storedConfig(f, actual.session.id, raw)
  const value = actual.repository.getSession(actual.session.id)?.modelConfig as Record<string, unknown>
  assert.equal(Object.hasOwn(value, '__proto__'), true); assert.equal(Object.hasOwn(value, 'constructor'), true)
  await observe(f)
  assert.equal(Object.hasOwn(Object.prototype, 'storedLiteral'), false)
}))

test('capsule2 assistant source supports the existing stored decoder at depth5000 independently of authored JSON depth limits', () => withV3Fixture(async f => {
  const actual = seed(f), depth = 5000, raw = '['.repeat(depth) + '0' + ']'.repeat(depth)
  storedConfig(f, actual.session.id, raw)
  let value: unknown = actual.repository.getSession(actual.session.id)?.modelConfig
  for (let i = 0; i < depth; i++) { assert.ok(Array.isArray(value)); assert.equal(value.length, 1); value = value[0] }
  assert.equal(value, 0)
  await observe(f)
}))

test('capsule2 assistant source distinguishes opaque configs whose exact stored key differs even for prototype names', () => withV3Fixture(async f => {
  const actual = seed(f)
  storedConfig(f, actual.session.id, '{"__proto__":{"stored":true}}', '{"__proto__":{"stored":false}}')
  assert.ok(actual.repository.getSession(actual.session.id))
  await withCapsule2RawCopy(f, db => assert.throws(() => db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))(), /assistant|JSON|会话/))
}))
