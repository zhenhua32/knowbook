import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertExchangeData } from '../sync/synced-exchange-model'
import { publicationCompare, publicationJson } from '../sync/synced-publication-model'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleSchema } from './synced-lifecycle-schema'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { hasAnySyncedObservationPending } from './synced-remote-observation-pending'
import { readInitialIncomingWorkspace } from './synced-initial-incoming-read'
import { readSyncedExchangeCutJournal } from './synced-exchange-host-cut'
import { decodeHostJournal, hostJournalKind } from './synced-host-journal'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { auditRestoreKnowledgeConnection, readRestoreKnowledgeCapture } from './restore-safety-knowledge'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { RECOVERY_BOUNDARY_CHANNEL, recoveryBoundaryInvalid, recoveryBoundaryKey, recoveryBoundaryJson,
  recoveryBoundaryHash, recoveryEpochMarkerId, recoveryEpochRequestHash, recoveryEpochTargetFingerprint,
  recoveryOperationRowHash, validateSyncedRecoveryHistoryBoundary, validateSyncedRecoveryEpochReceipt,
  type SyncedRecoveryGroupHistoryRow, type SyncedRecoveryHistoryBoundary, type SyncedRecoveryOperationRow,
  type SyncedRecoveryEpochReceipt } from './synced-recovery-boundary-model'

/** Host-fixed allocation, not a public restore request or a knowledge proof.
 * A maintenance/restore owner supplies its fixed epoch/CAS only after capturing
 * the real sources. This repository derives all history facts from SQL itself.
 * The caller owns the outer IMMEDIATE, including content installation/receipt. */
export interface SyncedRecoveryEpochAllocation {
  operationId: string; expectedWorkspaceScope: string; expectedRecoveryEpoch: string
  workspaceScope: string; recoveryEpoch: string; documentBoundary: string; acceptedAt: string
}
type Group = { id: string; creation_id: string; created_at: string; origin_json: string
  revision: string; topology_revision: string; history_cursor: string; history_position: number }
type State = { document_id: string; cursor: string; position: number }
type Mapping = { history_id: string; document_id: string; position: number }
type Instance = { instance_id: string; group_id: string; host_document_id: string; binding_version: string }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const quoted = (name: string): string => '"' + name.replaceAll('"', '""') + '"'

/** Reject undecodable SQL TEXT instead of archiving the driver's replacement
 * characters as if they were the original journal/ACK bytes. */
function exactRows<T>(db: Database.Database, table: string, columns: string[], texts = columns): T[] {
  const selected = [...columns.map(quoted), ...texts.map(column => `CAST(${quoted(column)} AS BLOB) AS ${quoted('__raw_' + column)}`)]
  return (db.prepare('SELECT ' + selected.join(',') + ' FROM ' + quoted(table)).all() as Record<string, unknown>[]).map(row => {
    for (const column of texts) {
      const bytes = row['__raw_' + column]
      if (!(bytes instanceof Uint8Array) || typeof row[column] !== 'string'
        || decoder.decode(bytes) !== row[column]) return recoveryBoundaryInvalid('原SQL TEXT不是准确UTF8字符串：' + table + '.' + column)
    }
    return Object.fromEntries(columns.map(column => [column, row[column]])) as T
  })
}
function checkedInput(input: SyncedRecoveryEpochAllocation): void {
  assertExchangeData(input)
  assertSyncedShape(input, ['operationId', 'expectedWorkspaceScope', 'expectedRecoveryEpoch', 'workspaceScope', 'recoveryEpoch', 'documentBoundary', 'acceptedAt'])
  for (const value of [input.operationId, input.expectedWorkspaceScope, input.expectedRecoveryEpoch, input.workspaceScope, input.recoveryEpoch])
    if (!isSyncedUuid(value)) return recoveryBoundaryInvalid('维护owner固定身份无效')
  for (const value of [input.documentBoundary, input.acceptedAt]) if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return recoveryBoundaryInvalid('维护owner固定时点无效')
  if (input.expectedRecoveryEpoch === input.recoveryEpoch) return recoveryBoundaryInvalid('维护owner没有分配新epoch')
}

/** Advance the real execution domain. This does not install backup contents,
 * merge irreversible knowledge, or grant a public restore/install permit.
 * Failure rolls back its entire savepoint even if the outer owner catches it. */
export function advanceSyncedRecoveryEpoch(db: Database.Database, input: SyncedRecoveryEpochAllocation): SyncedRecoveryEpochReceipt | null {
  if (!db.open || db.readonly || !db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1)
    return recoveryBoundaryInvalid('epoch推进要求原writable connection的owned IMMEDIATE/FK事务')
  checkedInput(input)
  return db.transaction(() => {
    if (hasAnySyncedObservationPending()) return recoveryBoundaryInvalid('仍有未持久化的远端观察拒绝份额')
    assertSyncedBlockSchema(db)
    assertSyncedLifecycleSchema(db)
    const existing = assertSyncedRecoveryBoundaryRecords(db)
    const previous = existing.boundaries.get(input.operationId)
    if (previous) {
      if (previous.workspaceScope !== input.workspaceScope || previous.workspaceScope !== input.expectedWorkspaceScope || previous.beforeEpoch !== input.expectedRecoveryEpoch
        || previous.afterEpoch !== input.recoveryEpoch || previous.acceptedAt !== input.acceptedAt
        || previous.documentBoundary !== input.documentBoundary) return recoveryBoundaryInvalid('原epoch operation被复用为另一份固定分配')
      return validateSyncedRecoveryEpochReceipt({ kind: 'synced-recovery-epoch', version: 1, operationId: previous.operationId,
        workspaceScope: previous.workspaceScope, beforeEpoch: previous.beforeEpoch, afterEpoch: previous.afterEpoch,
        boundaryHash: recoveryBoundaryHash(previous), acceptedAt: previous.acceptedAt })
    }
    for (const boundary of existing.boundaries.values()) {
      if (boundary.beforeEpoch === input.recoveryEpoch || boundary.afterEpoch === input.recoveryEpoch)
        return recoveryBoundaryInvalid('固定新epoch复用了已知历史世代')
      if (boundary.documentBoundary === input.documentBoundary || boundary.documents.some(row => row.beforeUpdatedAt === input.documentBoundary))
        return recoveryBoundaryInvalid('新document CAS复用了已知恢复历史守卫')
    }
    const workspace = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
      { workspace_scope: string; recovery_epoch: string } | undefined
    if (!workspace || workspace.workspace_scope !== input.expectedWorkspaceScope || workspace.recovery_epoch !== input.expectedRecoveryEpoch)
      return recoveryBoundaryInvalid('原scope/epoch已改变')
    const documents = exactRows<{ id: string; updated_at: string }>(db, 'documents', ['id', 'updated_at'])
      .sort((a, b) => publicationCompare(a.id, b.id))
    if (documents.some(row => row.updated_at === input.documentBoundary)) return recoveryBoundaryInvalid('新document CAS与原值相同')
    for (const row of db.prepare('SELECT expected_versions_json FROM document_block_moves').all() as Array<{ expected_versions_json: string }>) {
      const values: unknown = JSON.parse(row.expected_versions_json)
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).includes(input.documentBoundary))
        return recoveryBoundaryInvalid('新document CAS与原move守卫不分离')
    }
    const states = exactRows<State>(db, 'synced_host_history_state', ['document_id', 'cursor', 'position'], ['document_id', 'cursor'])
      .sort((a, b) => publicationCompare(a.document_id, b.document_id))
    const groups = exactRows<Group>(db, 'synced_groups', ['id', 'creation_id', 'created_at', 'origin_json', 'revision', 'topology_revision', 'history_cursor', 'history_position'],
      ['id', 'creation_id', 'created_at', 'origin_json', 'revision', 'topology_revision', 'history_cursor'])
      .sort((a, b) => publicationCompare(a.id, b.id))
    const hasJournals = Boolean(db.prepare('SELECT 1 FROM synced_host_history LIMIT 1').get()
      || db.prepare('SELECT 1 FROM synced_group_history LIMIT 1').get())
    if (!groups.length && !states.length && !hasJournals) {
      // A genuine ordinary restore must remain ordinary; an empty rotation is
      // already certified by its outer maintenance receipt, not a fake sync anchor.
      db.prepare('UPDATE synced_workspace_state SET workspace_scope=?,recovery_epoch=? WHERE singleton=1')
        .run(input.workspaceScope, input.recoveryEpoch)
      db.prepare('UPDATE documents SET updated_at=?').run(input.documentBoundary)
      return null
    }
    if (input.workspaceScope !== input.expectedWorkspaceScope) return recoveryBoundaryInvalid('同步history不能改派到另一个workspace scope')
    const diagnostic = readRestoreKnowledgeCapture(auditRestoreKnowledgeConnection(db))
    if (!diagnostic || diagnostic.reasons.some(reason => reason.startsWith('未知同步 namespace：')))
      return recoveryBoundaryInvalid('未知SQL namespace不能证明执行历史闭集')
    const initial = readInitialIncomingWorkspace(db)
    const deleted = assertSyncedLogicalDeletionRecords(db), lives = readSyncedGroupLifecycles(db, groups.map(row => row.id))
    const allocated = new Set<string>([input.recoveryEpoch, ...states.map(row => row.cursor), ...groups.flatMap(row => [row.revision, row.topology_revision, row.history_cursor])])
    for (const prior of existing.boundaries.values()) {
      allocated.add(prior.beforeEpoch); allocated.add(prior.afterEpoch)
      for (const host of prior.hosts) { allocated.add(host.beforeCursor); allocated.add(host.afterCursor) }
      for (const group of prior.groups) for (const guard of [group.before, group.after]) {
        allocated.add(guard.revision); allocated.add(guard.topologyRevision); allocated.add(guard.historyCursor)
      }
      for (const instance of prior.instances) { allocated.add(instance.beforeBindingVersion); allocated.add(instance.afterBindingVersion) }
    }
    const fresh = (): string => { let value: string; do { value = randomUUID() } while (allocated.has(value)); allocated.add(value); return value }
    const mappings = exactRows<Mapping>(db, 'synced_host_history_documents', ['history_id', 'document_id', 'position'], ['history_id', 'document_id'])
    const tokens = [...new Set(mappings.map(row => row.history_id))].sort(publicationCompare)
    // Validate original journal strings before the journal-only codec reads them.
    const journals = exactRows<SyncedHostHistoryBranchRow>(db, 'synced_host_history', ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
    for (const row of journals) if (hostJournalKind(row) !== 'bare-create'
      && decodeHostJournal(row).persisted.some(side => side.updatedAt === input.documentBoundary))
      return recoveryBoundaryInvalid('新document CAS复用了原host journal守卫')
    const histories = exactRows<SyncedRecoveryGroupHistoryRow>(db, 'synced_group_history',
      ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'],
      ['id', 'group_id', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
    const instances = exactRows<Instance>(db, 'synced_instances', ['instance_id', 'group_id', 'host_document_id', 'binding_version'])
      .sort((a, b) => publicationCompare(a.instance_id, b.instance_id))
    for (const row of instances) allocated.add(row.binding_version)
    const operations = exactRows<SyncedRecoveryOperationRow>(db, 'synced_operations', ['client_operation_id', 'request_hash', 'result_json', 'created_at'])
    const pins = exactRows<{ group_id: string; kind: string; pin_id: string; created_at: string }>(db, 'synced_group_pins', ['group_id', 'kind', 'pin_id', 'created_at'])
    const boundary: SyncedRecoveryHistoryBoundary = validateSyncedRecoveryHistoryBoundary({ kind: 'synced-recovery-history-boundary', version: 1,
      operationId: input.operationId, workspaceScope: workspace.workspace_scope, beforeEpoch: workspace.recovery_epoch,
      afterEpoch: input.recoveryEpoch, documentBoundary: input.documentBoundary, acceptedAt: input.acceptedAt,
      documents: documents.map(row => ({ documentId: row.id, beforeUpdatedAt: row.updated_at, afterUpdatedAt: input.documentBoundary })),
      hosts: states.map(row => ({ documentId: row.document_id, beforeCursor: row.cursor, beforePosition: row.position, afterCursor: fresh() })),
      hostCuts: tokens.map(historyToken => ({ historyToken, ...readSyncedExchangeCutJournal(db, historyToken),
        mappings: mappings.filter(row => row.history_id === historyToken).map(row => ({ documentId: row.document_id, position: row.position }))
          .sort((a, b) => publicationCompare(a.documentId, b.documentId)) })),
      groups: groups.map(row => {
        const lifecycle = lives.get(row.id)
        if (!lifecycle) return recoveryBoundaryInvalid('原group缺准确lifecycle')
        const disposition = deleted.has('group:' + row.id) ? 'deleted-evidence' : lifecycle.state === 'retired-create' ? 'retired-evidence' : 'active'
        const before = { revision: row.revision, topologyRevision: row.topology_revision, historyCursor: row.history_cursor, historyPosition: row.history_position }
        return { groupId: row.id, creationId: row.creation_id, createdAt: row.created_at, originJson: row.origin_json, disposition, before,
          after: disposition === 'active' ? { revision: fresh(), topologyRevision: fresh(), historyCursor: fresh(), historyPosition: 0 }
            : { ...before, historyPosition: 0 }, rows: histories.filter(history => history.group_id === row.id).sort((a, b) => a.position - b.position) }
      }),
      instances: instances.map(row => ({ instanceId: row.instance_id, groupId: row.group_id, hostDocumentId: row.host_document_id,
        beforeBindingVersion: row.binding_version, afterBindingVersion: fresh() })),
      retainedOperations: operations.map(row => ({ operationId: row.client_operation_id, rowHash: recoveryOperationRowHash(row) }))
        .sort((a, b) => publicationCompare(a.operationId, b.operationId)),
      retainedPins: pins.map(row => ({ groupId: row.group_id, kind: row.kind, pinId: row.pin_id, createdAt: row.created_at }))
        .sort((a, b) => publicationCompare(publicationJson([a.groupId, a.kind, a.pinId]), publicationJson([b.groupId, b.kind, b.pinId]))) })
    const receipt = validateSyncedRecoveryEpochReceipt({ kind: 'synced-recovery-epoch', version: 1, operationId: input.operationId,
      workspaceScope: boundary.workspaceScope, beforeEpoch: boundary.beforeEpoch, afterEpoch: boundary.afterEpoch,
      boundaryHash: recoveryBoundaryHash(boundary), acceptedAt: boundary.acceptedAt })
    const markerId = recoveryEpochMarkerId(input.operationId), requestHash = recoveryEpochRequestHash(receipt)
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(recoveryBoundaryKey(input.operationId), recoveryBoundaryJson(boundary), input.acceptedAt)
    db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(markerId, requestHash, recoveryBoundaryJson(receipt), input.acceptedAt)
    db.prepare(`INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at)
      VALUES(?,?,?,?,?,'possible',?,NULL)`).run(markerId, requestHash, RECOVERY_BOUNDARY_CHANNEL,
        recoveryEpochTargetFingerprint(boundary.workspaceScope), receipt.boundaryHash, input.acceptedAt)
    db.exec('DELETE FROM synced_host_history_documents; DELETE FROM synced_group_history')
    for (const row of boundary.hosts) db.prepare('UPDATE synced_host_history_state SET cursor=?,position=0 WHERE document_id=?')
      .run(row.afterCursor, row.documentId)
    for (const row of boundary.groups) if (row.disposition === 'active')
      db.prepare('UPDATE synced_groups SET revision=?,topology_revision=?,history_cursor=?,history_position=0 WHERE id=?')
        .run(row.after.revision, row.after.topologyRevision, row.after.historyCursor, row.groupId)
    for (const row of boundary.instances) db.prepare('UPDATE synced_instances SET binding_version=? WHERE instance_id=?').run(row.afterBindingVersion, row.instanceId)
    db.prepare('UPDATE documents SET updated_at=?').run(input.documentBoundary)
    db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(input.recoveryEpoch)
    assertSyncedRecoveryBoundaryRecords(db)
    const final = readInitialIncomingWorkspace(db)
    if (final.snapshot.workspaceScope !== input.workspaceScope || final.snapshot.recoveryEpoch !== input.recoveryEpoch)
      return recoveryBoundaryInvalid('实际workspace未按固定epoch推进')
    if (final.snapshot.catalogId !== initial.snapshot.catalogId || publicationJson(final.snapshot.records) !== publicationJson(initial.snapshot.records)
      || publicationJson([...final.groupIds].sort(publicationCompare)) !== publicationJson([...initial.groupIds].sort(publicationCompare))
      || publicationJson([...final.identities]) !== publicationJson([...initial.identities]))
      return recoveryBoundaryInvalid('执行边界改变了原内容或稳定身份')
    for (const row of boundary.documents) {
      const actual = db.prepare('SELECT updated_at FROM documents WHERE id=?').get(row.documentId) as { updated_at: string } | undefined
      if (actual?.updated_at !== row.afterUpdatedAt) return recoveryBoundaryInvalid('实际document CAS未推进')
    }
    for (const row of boundary.hosts) {
      const actual = db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(row.documentId) as { cursor: string; position: number } | undefined
      if (actual?.cursor !== row.afterCursor || actual.position !== 0) return recoveryBoundaryInvalid('实际host cursor/position未推进')
    }
    for (const row of boundary.groups) {
      const actual = db.prepare('SELECT revision,topology_revision,history_cursor,history_position FROM synced_groups WHERE id=?').get(row.groupId) as Group | undefined
      if (!actual || actual.revision !== row.after.revision || actual.topology_revision !== row.after.topologyRevision
        || actual.history_cursor !== row.after.historyCursor || actual.history_position !== 0) return recoveryBoundaryInvalid('实际group guards/position未闭合')
    }
    for (const row of boundary.instances) {
      const actual = db.prepare('SELECT group_id,host_document_id,binding_version FROM synced_instances WHERE instance_id=?').get(row.instanceId) as Instance | undefined
      if (!actual || actual.group_id !== row.groupId || actual.host_document_id !== row.hostDocumentId
        || actual.binding_version !== row.afterBindingVersion) return recoveryBoundaryInvalid('实际instance binding未推进')
    }
    return receipt
  })()
}
