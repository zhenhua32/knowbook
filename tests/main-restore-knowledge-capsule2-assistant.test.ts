import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { assistantTurnId, assistantStepId, assistantToolCallId, assistantApprovalId } from '../src/shared/assistant-session'
import { assertRawCapsule2AssistantHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-assistant-read'

function seed(f: V3Fixture, options: { activeDocumentId?: string; end?: 'cancelled' | 'error' | 'turn'; modelConfig?: null } = {}) {
  const repository = f.store.assistantSessions
  const session = repository.createSession({ workspaceId: 'source-workspace', title: 'Actual assistant source',
    activeDocumentId: options.activeDocumentId ?? f.hostId, modelConfig: options.modelConfig === null ? null : { model: 'source-model', nested: { literal: 'file:///opaque/model.png' } } })
  const turnId = assistantTurnId('source:turn'), stepId = assistantStepId('source:step'), toolCallId = assistantToolCallId('source:tool'), approvalId = assistantApprovalId('source:approval')
  repository.append(session.id, { type: 'turn.started', payload: { turnId } })
  repository.append(session.id, { type: 'user.message', payload: { turnId, text: 'Actual user body', attachments: [{ literal: 'file:///opaque/attachment-value' }] } })
  repository.append(session.id, { type: 'step.started', payload: { turnId, stepId, provider: 'source-provider', model: 'source-model', visibleTools: ['test.read'], policy: { literal: 'file:///opaque/policy' } } })
  repository.append(session.id, { type: 'assistant.chunk', payload: { turnId, stepId, text: 'Actual first chunk ' } })
  repository.append(session.id, { type: 'assistant.message', payload: { turnId, stepId, text: 'Actual complete assistant message' } })
  repository.append(session.id, { type: 'tool.call', payload: { turnId, stepId, toolCallId, tool: 'test.read', version: 1, arguments: { literal: 'file:///opaque/arguments' } } })
  repository.append(session.id, { type: 'approval.requested', payload: { turnId, toolCallId, approvalId, pluginId: 'source-plugin', revisionId: 'sha256:' + 'a'.repeat(64),
    scope: { kind: 'workspace', workspaceId: 'source-workspace' }, permissions: [], summary: 'Actual persisted pending question', risk: 'low', expiresAt: '2040-01-01T00:00:00.000Z' } })
  repository.append(session.id, { type: 'session.title.updated', payload: { title: '  ' + '来源'.repeat(300) + '  ' } })
  if (options.end === 'turn') repository.append(session.id, { type: 'turn.ended', payload: { turnId, status: 'completed' } })
  if (options.end === 'cancelled') repository.append(session.id, { type: 'session.cancelled', payload: { reason: 'Actual terminal cancellation' } })
  if (options.end === 'error') repository.append(session.id, { type: 'session.error', payload: { error: { message: 'Actual terminal error' } } })
  return { repository, session, turnId, stepId, toolCallId, approvalId }
}
async function inspect(f: V3Fixture, rejected = false) {
  const producer = { sessions: f.db.prepare('SELECT * FROM assistant_sessions ORDER BY id').all(), events: f.db.prepare('SELECT * FROM assistant_events ORDER BY session_id,seq').all() }
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const raw = readRawCapsule2ContentOwned(db)
    if (rejected) assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /assistant|助手|session|会话|事件|序列|payload|JSON|surface|来源/)
    else {
      const history = readRawCapsule2WorkspaceHistoryOwned(db)
      assert.equal(history.certified, false); assert.equal(history.semanticValidationComplete, false); assert.equal(history.permit, false)
    }
    assert.deepEqual(readRawCapsule2ContentOwned(db), raw)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual({ sessions: f.db.prepare('SELECT * FROM assistant_sessions ORDER BY id').all(), events: f.db.prepare('SELECT * FROM assistant_events ORDER BY session_id,seq').all() }, producer)
}

test('capsule2 assistant history preserves the actual pending approval and active turn without startup recovery or title normalization', () => withV3Fixture(async f => {
  const actual = seed(f)
  await inspect(f)
  assert.equal(actual.repository.getSession(actual.session.id)?.activeTurnId, actual.turnId)
  assert.equal(actual.repository.getSession(actual.session.id)?.status, 'active')
  assert.equal(actual.repository.getSession(actual.session.id)?.title, '  ' + '来源'.repeat(300) + '  ')
  assert.equal(f.db.prepare("SELECT 1 FROM assistant_events WHERE type='approval.resolved'").get(), undefined)
}))

for (const end of ['turn', 'cancelled', 'error'] as const) test(`capsule2 assistant history accepts the actual ${end} projection and primitive model config`, () => withV3Fixture(async f => {
  seed(f, { end, modelConfig: null }); await inspect(f)
}))

test('capsule2 assistant history preserves the original session-created document identity after real Store deletion sets the live FK to null', () => withV3Fixture(async f => {
  const activeDocumentId = f.store.createDocument(null), actual = seed(f, { activeDocumentId })
  f.store.deleteDocument(activeDocumentId)
  assert.equal(actual.repository.getSession(actual.session.id)?.activeDocumentId, null)
  const first = f.db.prepare('SELECT payload_json FROM assistant_events WHERE session_id=? AND seq=1').get(actual.session.id) as { payload_json: string }
  assert.equal(JSON.parse(first.payload_json).activeDocumentId, activeDocumentId)
  await inspect(f)
}))

test('capsule2 assistant history accepts actual crash-recovery facts and an allowed-once historical result without minting plugin grants', () => withV3Fixture(async f => {
  const actual = seed(f)
  actual.repository.append(actual.session.id, { type: 'approval.resolved', payload: { approvalId: actual.approvalId, decision: 'allowed-once' } })
  const recovered = actual.repository.recoverInterruptedSessions()
  assert.equal(recovered.at(-1)?.type, 'turn.ended')
  assert.equal(actual.repository.getSession(actual.session.id)?.activeTurnId, null)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM plugin_grants').get() as { n: number }).n, 0)
  await inspect(f)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM plugin_grants').get() as { n: number }).n, 0)
}))

const event = (db: Database.Database, column: string, value: unknown, type = 'user.message') => db.prepare(`UPDATE assistant_events SET ${column}=? WHERE type=?`).run(value, type)
const faults: Array<[string, (f: V3Fixture) => void]> = [
  ['unknown session status', f => { f.db.prepare("UPDATE assistant_sessions SET status='archived'").run() }],
  ['session next_seq beyond the complete event tail', f => { f.db.prepare('UPDATE assistant_sessions SET next_seq=next_seq+1').run() }],
  ['missing complete first event family', f => { f.db.prepare('DELETE FROM assistant_events').run() }],
  ['a non-TEXT workspace id', f => { f.db.prepare("UPDATE assistant_sessions SET workspace_id=CAST(workspace_id AS BLOB)").run() }],
  ['invalid original creation time', f => { f.db.prepare("UPDATE assistant_sessions SET created_at='not-a-date'").run() }],
  ['session update time detached from its actual last event', f => { f.db.prepare("UPDATE assistant_sessions SET updated_at='1990-01-01T00:00:00Z'").run() }],
  ['malformed original model config JSON', f => { f.db.prepare("UPDATE assistant_sessions SET model_config_json='{' ").run() }],
  ['model config detached from the immutable first event', f => { f.db.prepare("UPDATE assistant_sessions SET model_config_json='null'").run() }],
  ['title detached from the complete event projection', f => { f.db.prepare("UPDATE assistant_sessions SET title='forged title'").run() }],
  ['active turn detached from its real event projection', f => { f.db.prepare("UPDATE assistant_sessions SET active_turn_id='other-turn'").run() }],
  ['a different current document substituted for the original identity', f => { f.db.prepare('UPDATE assistant_sessions SET active_document_id=?').run(f.targetId) }],
  ['a noncontiguous exact event sequence', f => { f.db.prepare('UPDATE assistant_events SET seq=seq+100 WHERE seq=(SELECT max(seq) FROM assistant_events)').run() }],
  ['an unsafe exact INTEGER sequence', f => { f.db.prepare('UPDATE assistant_sessions SET next_seq=9223372036854775807').run() }],
  ['an original REAL sequence', f => { f.db.prepare('UPDATE assistant_sessions SET next_seq=2.5').run() }],
  ['an unknown event type', f => { event(f.db, 'type', 'future.event') }],
  ['a prototype-name event type', f => { event(f.db, 'type', 'toString') }],
  ['a wrong event surface', f => { event(f.db, 'surface', 'audit-only') }],
  ['a missing payload object', f => { event(f.db, 'payload_json', 'null') }],
  ['a duplicate raw payload key', f => { event(f.db, 'payload_json', '{"turnId":"source:turn","text":"first","text":"second"}') }],
  ['a missing required payload field', f => { event(f.db, 'payload_json', '{"turnId":"source:turn"}') }],
  ['an indexed turn different from its original payload', f => { event(f.db, 'turn_id', 'forged-index') }],
  ['an indexed step different from its original payload', f => { event(f.db, 'step_id', 'forged-index', 'assistant.message') }],
  ['a valid event payload for a different active turn', f => { f.db.prepare("UPDATE assistant_events SET turn_id='other-turn',payload_json=? WHERE type='user.message'").run('{"turnId":"other-turn","text":"Actual shape, wrong current turn"}') }],
  ['a second session-created event after the initial event', f => { f.db.prepare("UPDATE assistant_events SET type='session.created',surface='audit-only',turn_id=NULL,step_id=NULL,payload_json=(SELECT payload_json FROM assistant_events WHERE seq=1) WHERE type='assistant.message'").run() }],
  ['an extra field in the host-owned session-created payload', f => { f.db.prepare("UPDATE assistant_events SET payload_json=json_set(payload_json,'$.future','opaque') WHERE type='session.created'").run() }],
  ['a missing document identity in the original session-created payload', f => { f.db.prepare("UPDATE assistant_events SET payload_json=json_remove(payload_json,'$.activeDocumentId') WHERE type='session.created'").run() }]
]
for (const [name, mutate] of faults) test('capsule2 assistant history refuses ' + name + ' without repairing source', () => withV3Fixture(async f => {
  seed(f); mutate(f); await inspect(f, true)
}))

test('capsule2 assistant history visits the genuine 1005th event and refuses a damaged tail beyond the repository page limit', () => withV3Fixture(async f => {
  const actual = seed(f)
  for (let i = actual.repository.getSession(actual.session.id)!.lastSeq; i < 1005; i++) actual.repository.append(actual.session.id, { type: 'assistant.chunk', payload: { turnId: actual.turnId, stepId: actual.stepId, text: `original chunk ${i}` } })
  assert.equal(actual.repository.listEvents(actual.session.id, 0, 1000).length, 1000)
  assert.equal(actual.repository.getSession(actual.session.id)?.lastSeq, 1005)
  await inspect(f)
  f.db.prepare("UPDATE assistant_events SET surface='audit-only' WHERE seq=1005").run()
  await inspect(f, true)
}))

test('capsule2 assistant history rejects a repeated turn start even when its indexed fields and current projection are made consistent', () => withV3Fixture(async f => {
  seed(f)
  f.db.prepare("UPDATE assistant_events SET type='turn.started',surface='trajectory',step_id=NULL,payload_json=? WHERE type='assistant.message'").run('{"turnId":"source:turn"}')
  await inspect(f, true)
}))

test('capsule2 assistant history rejects an appended event after a real terminal session even with consistent sequence and timestamps', () => withV3Fixture(async f => {
  const actual = seed(f, { end: 'cancelled' })
  f.db.prepare(`INSERT INTO assistant_events(id,session_id,seq,type,surface,turn_id,step_id,payload_json,created_at)
    SELECT 'injected-after-terminal',session_id,seq+1,'session.title.updated','audit-only',NULL,NULL,'{"title":"forged late title"}',created_at
    FROM assistant_events WHERE session_id=? AND seq=(SELECT max(seq) FROM assistant_events WHERE session_id=?)`).run(actual.session.id, actual.session.id)
  f.db.prepare("UPDATE assistant_sessions SET next_seq=next_seq+1,title='forged late title' WHERE id=?").run(actual.session.id)
  await inspect(f, true)
}))

test('capsule2 assistant history keeps its actual readonly query-only foreign-key transaction boundary', () => withV3Fixture(async f => {
  seed(f)
  assert.throws(() => f.db.transaction(() => assertRawCapsule2AssistantHistoryOwned(f.db))(), /readonly/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => assertRawCapsule2AssistantHistoryOwned(db), /来源事务/)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2AssistantHistoryOwned(db))(), /query-only/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2AssistantHistoryOwned(db))(), /FKON/)
    db.pragma('foreign_keys=ON')
    db.transaction(() => assertRawCapsule2AssistantHistoryOwned(db))()
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })
}))
