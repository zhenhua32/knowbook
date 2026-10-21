import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { captureKnowledgeOriginal, extractKnowledge } from './helpers/restore-knowledge-payload-fixture'

test('K retains exact old group rows and shared host cuts across real recovery and a later valid new content branch', () => withV3Fixture(async f => {
  editCreatedGroup(f.db, f.groupId)
  const oldRows = f.db.prepare('SELECT * FROM synced_group_history WHERE group_id=? ORDER BY position').all(f.groupId) as Array<{
    id: string; group_id: string; position: number; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string
  }>
  const oldMappings = f.db.prepare('SELECT * FROM synced_host_history_documents ORDER BY document_id,position').all() as Array<{ history_id: string; document_id: string; position: number }>
  assert.ok(oldRows.length && oldMappings.length, 'The actual create/content writers produced executable history before the cut')
  const source = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const before = f.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state').get() as { workspace_scope: string; recovery_epoch: string }
  const operationId = randomUUID()
  f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, { operationId, expectedWorkspaceScope: before.workspace_scope,
    expectedRecoveryEpoch: before.recovery_epoch, workspaceScope: before.workspace_scope, recoveryEpoch: randomUUID(),
    acceptedAt: '2041-01-01T00:00:00.000Z', documentBoundary: '2041-01-01T00:00:00.000Z' })).immediate()
  const edited = editCreatedGroup(f.db, f.groupId)
  const current = await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))
  const boundary = current.payload.recoveryBoundaries.find(item => item.boundary.operationId === operationId)
  assert.ok(boundary)
  assert.deepEqual(boundary.boundary.groups.find(group => group.groupId === f.groupId)?.rows, oldRows,
    'Typed B payload preserves original archived SQL strings/hashes/IDs, not today\'s group CAS')
  for (const old of oldRows) {
    const archived = current.payload.archivedGroupHistories.find(row => row.archive === 'recovery' && row.historyId === old.id)
    assert.ok(archived); assert.equal(archived.operationId, operationId)
    assert.deepEqual(archived.before, JSON.parse(old.before_json)); assert.deepEqual(archived.after, JSON.parse(old.after_json))
    assert.equal(current.payload.groupHistories.some(row => row.historyId === old.id), false)
  }
  assert.ok(current.payload.groupHistories.length > 0, 'A genuine later Main edit owns a fresh content branch')
  assert.ok(current.payload.historicalMaterial.some(item => item.fact.family === 'group-ack' && item.fact.locator.key[0] === edited.operationId))
  for (const mapping of oldMappings) {
    assert.ok(boundary.boundary.hostCuts.some(cut => cut.historyToken === mapping.history_id))
    const journal = current.payload.hostJournals.find(row => row.historyToken === mapping.history_id)
    assert.ok(journal); assert.deepEqual(journal.mappings, [])
  }
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge([source.handle, current.handle]))
  assert.equal(union.payloads.length, 2); assert.equal(union.status, 'evidence-only')
  assert.ok(union.payloads.some(payload => payload.groupHistories.some(row => row.historyId === oldRows[0].id)),
    'A historical executable token is retained as evidence, without granting present Undo')
}))
